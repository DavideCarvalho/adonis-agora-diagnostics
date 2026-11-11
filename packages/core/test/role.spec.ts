import { join } from 'node:path';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeHub, FakeRedis } from './fake-redis.js';

/** `@adonisjs/redis`: one hub per test, the app's connection is a FakeRedis that counts duplicates. */
const redis = vi.hoisted(() => ({ pub: null as unknown, duplicates: 0 }));
vi.mock('@adonisjs/redis/services/main', () => ({
  default: { connection: () => ({ ioConnection: redis.pub }) },
}));

/** `@adonisjs/queue`: records every dispatch, named after the job its payload belongs to. */
const queue = vi.hoisted(() => {
  const calls: Array<{ job: string; payload: unknown }> = [];
  const pending = (): Promise<void> & { toQueue(): unknown } =>
    Object.assign(Promise.resolve(), { toQueue: () => pending() });
  const record = (payload: unknown) =>
    calls.push({
      job:
        typeof payload === 'object' && payload !== null && 'listenerId' in payload
          ? 'agora.diagnostics.listener'
          : 'agora.diagnostics.event',
      payload,
    });
  class Job {
    static options: { name?: string } = {};
    static dispatch(payload: unknown) {
      record(payload);
      return pending();
    }
    static dispatchMany(payloads: unknown[]) {
      for (const payload of payloads) record(payload);
      return pending();
    }
  }
  return { calls, Job, Locator: { register: () => {} } };
});
vi.mock('@adonisjs/queue', () => ({ Job: queue.Job, Locator: queue.Locator }));

import DiagnosticsProvider from '../providers/diagnostics_provider.js';
import { emit } from '../src/channel.js';
import type { DiagnosticsConfig } from '../src/define_config.js';
import type { DeliveryTransportContext, ListenerDelivery } from '../src/delivery.js';
import { bindListenerInvoker, getListenerInvoker } from '../src/listener_dispatch.js';
import { resetListeners } from '../src/listeners.js';
import { resetRegistry } from '../src/registry.js';
import { resolveRole } from '../src/role.js';
import { onDiagnostic, unsubscribeAll } from '../src/subscriber.js';
import DiagnosticsListenerJob from '../src/transports/diagnostics_listener_job.js';
import { setDurableModuleLoader, transports } from '../src/transports/factory.js';
import { createDiagnosticsQueueRelay, getActiveReEmitter } from '../src/transports/queue.js';
import { createDiagnosticsRedisRelay } from '../src/transports/redis.js';
import type { DiagnosticEvent } from '../src/types.js';

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const RELAY = 'agora:diagnostics:relay';

class CountingRedis extends FakeRedis {
  constructor(readonly hub: FakeHub) {
    super(hub);
  }
  duplicate() {
    redis.duplicates += 1;
    return new FakeRedis(this.hub);
  }
}

/** Every listener invocation, in order. */
const ran: Array<{ listener: string; payload: unknown }> = [];
class Track {
  handle(event: DiagnosticEvent) {
    ran.push({ listener: 'Track#handle', payload: event.payload });
  }
}

async function boot(config: DiagnosticsConfig) {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const app = {
    config: { get: (_key: string, fallback: unknown) => ({ otel: false, ...config }) ?? fallback },
    container: {
      make: async (binding: unknown) =>
        binding === 'logger' ? logger : new (binding as new () => object)(),
    },
    makePath: (...parts: string[]) => join('/nonexistent-app-root', ...parts),
  } as unknown as ApplicationService;
  const provider = new DiagnosticsProvider(app);
  await provider.boot();
  await provider.ready();
  return provider;
}

/** A message another process put on the Redis relay channel. */
function fromOtherProcess(hub: FakeHub, payload: unknown) {
  const env = { v: 1, id: 'remote-1', ts: 0, lib: 'agent', event: 'run.finished', payload };
  new FakeRedis(hub).publish(RELAY, JSON.stringify({ node: 'other', env }));
}

function fakeDurable() {
  const delivered: ListenerDelivery[] = [];
  const contexts: DeliveryTransportContext[] = [];
  setDurableModuleLoader(async () => ({
    isConfigured: () => true,
    createDeliveryTransport(context) {
      contexts.push(context);
      return { deliver: (deliveries) => void delivered.push(...deliveries) };
    },
  }));
  return { delivered, contexts };
}

let provider: DiagnosticsProvider | undefined;
afterEach(async () => {
  await provider?.shutdown();
  provider = undefined;
  setDurableModuleLoader(null);
  unsubscribeAll();
  resetListeners();
  resetRegistry();
  bindListenerInvoker(null);
  ran.length = 0;
  queue.calls.length = 0;
  redis.duplicates = 0;
});

describe('config.role', () => {
  it("defaults to 'all' and rejects an unknown value", () => {
    expect(resolveRole({})).toBe('all');
    expect(resolveRole({ role: 'worker' })).toBe('worker');
    expect(() => resolveRole({ role: 'web' as never })).toThrow(
      "config.role must be 'all', 'api' or 'worker'",
    );
  });

  it.each(['api', 'worker'] as const)(
    'refuses %s at boot without a default transport',
    async (role) => {
      onDiagnostic('agent', 'run.finished', [Track, 'handle']);
      await expect(boot({ role })).rejects.toThrow(
        `config.role is "${role}", which splits emitting from consuming — but no \`default\` transport is selected`,
      );
    },
  );

  it("keeps 'all' without a transport: listeners run in-process", async () => {
    onDiagnostic('agent', 'run.finished', [Track, 'handle']);
    provider = await boot({ role: 'all' });
    emit('agent', 'run.finished', { n: 1 });
    await nextTurn();
    expect(ran).toEqual([{ listener: 'Track#handle', payload: { n: 1 } }]);
  });
});

describe('role × redis', () => {
  const setup = () => {
    const hub = new FakeHub();
    redis.pub = new CountingRedis(hub);
    const seen: unknown[] = [];
    const spy = new FakeRedis(hub);
    spy.subscribe(RELAY);
    spy.on('message', (_channel, message) => seen.push(JSON.parse(message).env.payload));
    return { hub, seen };
  };
  const config = (role: 'all' | 'api' | 'worker'): DiagnosticsConfig => ({
    role,
    default: 'redis',
    nodeId: 'self',
    transports: { redis: transports.redis() },
  });

  it("'api' publishes (listener libs included), opens no subscriber, runs no listener", async () => {
    const { hub, seen } = setup();
    const observed: unknown[] = [];
    onDiagnostic('agent', 'run.finished', [Track, 'handle']);
    onDiagnostic('agent', 'run.finished', (event) => void observed.push(event.payload));
    provider = await boot(config('api'));

    expect(redis.duplicates).toBe(0);
    emit('agent', 'run.finished', { n: 1 });
    fromOtherProcess(hub, { n: 2 });
    await nextTurn();

    expect(seen).toEqual(expect.arrayContaining([{ n: 1 }, { n: 2 }]));
    expect(seen).toHaveLength(2);
    expect(ran).toEqual([]);
    // An onDiagnostic function observes what THIS process emits, never what others relay.
    expect(observed).toEqual([{ n: 1 }]);
    expect(getListenerInvoker()).toBeNull();
  });

  it("'worker' subscribes and runs listeners for its own and relayed events", async () => {
    const { hub } = setup();
    onDiagnostic('agent', 'run.finished', [Track, 'handle']);
    provider = await boot(config('worker'));

    expect(redis.duplicates).toBe(1);
    emit('agent', 'run.finished', { n: 1 });
    fromOtherProcess(hub, { n: 2 });
    await nextTurn();
    expect(ran.map((r) => r.payload)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("'all' behaves like 'worker'", async () => {
    const { hub } = setup();
    onDiagnostic('agent', 'run.finished', [Track, 'handle']);
    provider = await boot(config('all'));
    fromOtherProcess(hub, { n: 2 });
    await nextTurn();
    expect(ran.map((r) => r.payload)).toEqual([{ n: 2 }]);
  });
});

describe('role × queue', () => {
  const config = (role: 'all' | 'api' | 'worker'): DiagnosticsConfig => ({
    role,
    default: 'queue',
    nodeId: 'self',
    forward: { libs: ['agent'] },
    transports: { queue: transports.queue() },
  });
  const job = (payload: unknown) =>
    Object.assign(new DiagnosticsListenerJob(), { payload }) as DiagnosticsListenerJob;

  it("'api' dispatches relay and listener jobs, binds no re-emitter and no invoker", async () => {
    onDiagnostic('agent', 'run.finished', [Track, 'handle']);
    provider = await boot(config('api'));

    emit('agent', 'run.finished', { n: 1 });
    await nextTurn();
    expect(queue.calls.map((c) => c.job).sort()).toEqual([
      'agora.diagnostics.event',
      'agora.diagnostics.listener',
    ]);
    expect(ran).toEqual([]);
    expect(getActiveReEmitter()).toBeNull();
    expect(getListenerInvoker()).toBeNull();

    // A listener job that lands here fails, so the queue retries it on a worker.
    const listenerJob = queue.calls.find((c) => c.job === 'agora.diagnostics.listener');
    await expect(job(listenerJob?.payload).execute()).rejects.toThrow(/config\.role is 'api'/);
  });

  it.each(['worker', 'all'] as const)(
    "'%s' binds the re-emitter and runs listener jobs",
    async (role) => {
      onDiagnostic('agent', 'run.finished', [Track, 'handle']);
      provider = await boot(config(role));

      expect(getActiveReEmitter()?.nodeId).toBe('self');
      emit('agent', 'run.finished', { n: 1 });
      await nextTurn();
      expect(ran).toEqual([]); // still handed over, never run inline
      const listenerJob = queue.calls.find((c) => c.job === 'agora.diagnostics.listener');
      await job(listenerJob?.payload).execute();
      expect(ran).toEqual([{ listener: 'Track#handle', payload: { n: 1 } }]);
    },
  );
});

describe('role × durable', () => {
  const config = (role: 'api' | 'worker'): DiagnosticsConfig => ({
    role,
    default: 'durable',
    transports: { durable: transports.durable() },
  });

  it("'api' hands deliveries to durable and publishes no process invoker", async () => {
    const durable = fakeDurable();
    onDiagnostic('agent', 'run.finished', [Track, 'handle']);
    provider = await boot(config('api'));

    emit('agent', 'run.finished', { n: 1 });
    await nextTurn();
    expect(durable.delivered.map((d) => d.listenerId)).toEqual(['Track#handle']);
    expect(ran).toEqual([]);
    expect(getListenerInvoker()).toBeNull();
    // durable still registers its workflow with the invoker; where the run executes is its call.
    expect(typeof durable.contexts[0]?.invoke).toBe('function');
  });

  it("'worker' hands deliveries to durable and runs them through the invoker", async () => {
    const durable = fakeDurable();
    onDiagnostic('agent', 'run.finished', [Track, 'handle']);
    provider = await boot(config('worker'));

    emit('agent', 'run.finished', { n: 1 });
    await nextTurn();
    const [delivery] = durable.delivered;
    await durable.contexts[0]?.invoke(delivery?.listenerId ?? '', delivery?.envelope as never);
    expect(ran).toEqual([{ listener: 'Track#handle', payload: { n: 1 } }]);
    expect(getListenerInvoker()).not.toBeNull();
  });
});

describe('receive-less relays', () => {
  it('createDiagnosticsRedisRelay({ receive: false }) needs no sub and only publishes', async () => {
    const hub = new FakeHub();
    const pub = new FakeRedis(hub);
    const stop = createDiagnosticsRedisRelay({ pub, receive: false, libs: ['agent'] });
    emit('agent', 'run.finished', {});
    await nextTurn();
    expect(pub.publishCount).toBe(1);
    stop();
    // @ts-expect-error a relay that receives needs a `sub`
    expect(() => createDiagnosticsRedisRelay({ pub, libs: ['agent'] })).toThrow(
      '`sub` is required',
    );
  });

  it('createDiagnosticsQueueRelay({ receive: false }) binds no re-emitter', () => {
    const stop = createDiagnosticsQueueRelay({ job: { dispatch: () => {} }, receive: false });
    expect(getActiveReEmitter()).toBeNull();
    stop();
  });
});
