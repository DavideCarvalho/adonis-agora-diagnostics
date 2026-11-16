import diagnostics_channel from 'node:diagnostics_channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { channelName, emit, getChannel } from '../src/channel.js';
import { RecentEventsBuffer } from '../src/recent.js';
import { resetRegistry } from '../src/registry.js';
import { createDiagnosticsQueueRelay, getActiveReEmitter } from '../src/transports/queue.js';
import { createDiagnosticsRedisRelay } from '../src/transports/redis.js';
import type { DiagnosticEvent } from '../src/types.js';
import { FakeJob } from './fake-queue.js';
import { FakeHub, FakeRedis } from './fake-redis.js';

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function capture(lib: string, event: string) {
  const events: DiagnosticEvent[] = [];
  const channel = diagnostics_channel.channel(channelName(lib, event));
  const onMessage = (msg: unknown) => events.push(msg as DiagnosticEvent);
  channel.subscribe(onMessage);
  return { events, stop: () => channel.unsubscribe(onMessage) };
}

describe('emit app attribution', () => {
  const teardowns: Array<() => void> = [];
  afterEach(() => {
    for (const t of teardowns.splice(0)) t();
    vi.restoreAllMocks();
    resetRegistry();
  });

  it('stamps a valid app on the envelope', () => {
    const cap = capture('durable', 'run.started');
    teardowns.push(cap.stop);

    emit('durable', 'run.started', { runId: 'r1' }, { app: 'entre-textos' });
    emit('durable', 'run.started', { runId: 'r2' }, { app: 'A.b_c-1' });
    emit('durable', 'run.started', { runId: 'r3' }, { app: 'x'.repeat(64) });

    expect(cap.events.map((e) => e.app)).toEqual(['entre-textos', 'A.b_c-1', 'x'.repeat(64)]);
  });

  it('leaves the envelope unchanged without app', () => {
    const cap = capture('durable', 'run.started');
    teardowns.push(cap.stop);

    emit('durable', 'run.started', { runId: 'r1' });
    emit('durable', 'run.started', { runId: 'r2' }, { traceId: 't' });

    for (const env of cap.events) expect('app' in env).toBe(false);
  });

  it('drops an invalid app with a warning, still publishes, and never throws', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const cap = capture('durable', 'run.started');
    teardowns.push(cap.stop);

    const invalid = ['', 'has space', 'tenant:a', 'x'.repeat(65), 'ção', 42 as unknown as string];
    for (const app of invalid) {
      expect(() => emit('durable', 'run.started', {}, { app })).not.toThrow();
    }

    expect(cap.events).toHaveLength(invalid.length);
    for (const env of cap.events) expect('app' in env).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('[A-Za-z0-9_.-]{1,64}');
  });

  it('warns once per invalid value', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const cap = capture('durable', 'run.started');
    teardowns.push(cap.stop);

    for (let i = 0; i < 5; i++) emit('durable', 'run.started', {}, { app: 'once only' });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    teardowns.push(() => vi.unstubAllEnvs());
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const cap = capture('durable', 'run.started');
    teardowns.push(cap.stop);

    emit('durable', 'run.started', {}, { app: 'prod invalid' });

    expect(cap.events).toHaveLength(1);
    expect('app' in (cap.events[0] as object)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a throwing warning does not break emit', () => {
    vi.spyOn(process, 'emitWarning').mockImplementation(() => {
      throw new Error('boom');
    });
    const cap = capture('durable', 'run.started');
    teardowns.push(cap.stop);

    expect(() => emit('durable', 'run.started', {}, { app: 'throws here' })).not.toThrow();
    expect(cap.events).toHaveLength(1);
  });

  it('the Redis relay preserves app end to end', async () => {
    const hub = new FakeHub();
    teardowns.push(
      createDiagnosticsRedisRelay({
        pub: new FakeRedis(hub),
        sub: new FakeRedis(hub),
        libs: ['durable'],
        nodeId: 'A',
      }),
    );
    teardowns.push(
      createDiagnosticsRedisRelay({
        pub: new FakeRedis(hub),
        sub: new FakeRedis(hub),
        libs: [],
        nodeId: 'B',
      }),
    );
    const received: DiagnosticEvent[] = [];
    const onMessage = (m: unknown) => received.push(m as DiagnosticEvent);
    getChannel('durable', 'run.failed').subscribe(onMessage);
    teardowns.push(() => getChannel('durable', 'run.failed').unsubscribe(onMessage));

    emit('durable', 'run.failed', { runId: 'r1' }, { app: 'eduliberta' });
    await nextTurn();

    // the local copy, then node B's relayed copy (a different object that went through JSON)
    expect(received).toHaveLength(2);
    expect(received[0]).not.toBe(received[1]);
    expect(received.map((e) => e.app)).toEqual(['eduliberta', 'eduliberta']);
    expect(received[1]?.id).toBe(received[0]?.id);
  });

  it('the queue relay preserves app end to end', async () => {
    const job = new FakeJob();
    teardowns.push(createDiagnosticsQueueRelay({ job, libs: ['durable'], nodeId: 'A' }));

    emit('durable', 'run.failed', { runId: 'r1' }, { app: 'hub' });
    await nextTurn();

    const dispatched = job.dispatched;
    expect(dispatched).toHaveLength(1);
    const wire = JSON.parse(JSON.stringify(dispatched[0])) as { env: DiagnosticEvent };
    expect(wire.env.app).toBe('hub');

    const received: DiagnosticEvent[] = [];
    const onMessage = (m: unknown) => received.push(m as DiagnosticEvent);
    getChannel('durable', 'run.failed').subscribe(onMessage);
    teardowns.push(() => getChannel('durable', 'run.failed').unsubscribe(onMessage));
    getActiveReEmitter()?.reEmit({ node: 'B', env: wire.env });

    expect(received).toHaveLength(1);
    expect(received[0]?.app).toBe('hub');
  });

  it('the recent-events buffer keeps app', () => {
    const buffer = new RecentEventsBuffer(10);
    buffer.push({ ts: 1, lib: 'durable', event: 'run.failed', payload: {}, app: 'hub' });
    buffer.push({ ts: 2, lib: 'durable', event: 'run.failed', payload: {} });

    const apps = buffer.list().map((e) => e.app);
    expect(apps).toContain('hub');
    expect(apps).toContain(undefined);
  });
});
