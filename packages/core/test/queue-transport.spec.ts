import { afterEach, describe, expect, it, vi } from 'vitest';

// Stand-in for `@adonisjs/queue`: records every dispatch / dispatchMany the transport issues.
const queue = vi.hoisted(() => {
  const calls: Array<{ kind: 'one' | 'many'; payload: unknown; queue?: string }> = [];
  const dispatcher = (kind: 'one' | 'many', payload: unknown) => {
    const call: { kind: 'one' | 'many'; payload: unknown; queue?: string } = { kind, payload };
    calls.push(call);
    const pending = Object.assign(Promise.resolve(), {
      toQueue(name: string) {
        call.queue = name;
        return pending;
      },
    });
    return pending;
  };
  class Job {
    static options = {};
    static dispatch(payload: unknown) {
      return dispatcher('one', payload);
    }
    static dispatchMany(payloads: unknown[]) {
      return dispatcher('many', payloads);
    }
  }
  return { calls, Job, Locator: { register: () => {} } };
});
vi.mock('@adonisjs/queue', () => ({ Job: queue.Job, Locator: queue.Locator }));

import { emit } from '../src/channel.js';
import { bindListenerInvoker } from '../src/listener_dispatch.js';
import { resetRegistry } from '../src/registry.js';
import DiagnosticsListenerJob from '../src/transports/diagnostics_listener_job.js';
import type { TransportContext, TransportHandle } from '../src/transports/factory.js';
import { transports } from '../src/transports/factory.js';

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function context(): TransportContext {
  const logger = { error: vi.fn() };
  return {
    app: { container: { make: async () => logger } },
    forward: { libs: ['resilience'] },
    nodeId: 'A',
  } as unknown as TransportContext;
}

type Started = (() => void) | TransportHandle;
const stopOf = (started: Started) => (typeof started === 'function' ? started() : started.stop?.());

describe('transports.queue', () => {
  const teardowns: Started[] = [];
  afterEach(() => {
    for (const t of teardowns.splice(0)) stopOf(t);
    queue.calls.length = 0;
    resetRegistry();
  });

  it('pushes a turn of events with one dispatchMany onto the configured queue', async () => {
    teardowns.push(await transports.queue({ queue: 'diagnostics' })(context()));

    emit('resilience', 'circuit-opened', { n: 1 });
    emit('resilience', 'circuit-closed', { n: 2 });
    emit('resilience', 'circuit-opened', { n: 3 });
    await nextTurn();

    expect(queue.calls).toHaveLength(1);
    expect(queue.calls[0]?.kind).toBe('many');
    expect(queue.calls[0]?.queue).toBe('diagnostics');
    const payloads = queue.calls[0]?.payload as Array<{ node: string; env: { payload: unknown } }>;
    expect(payloads.map((p) => p.env.payload)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(payloads.every((p) => p.node === 'A')).toBe(true);
  });

  it('uses a plain dispatch for a single event', async () => {
    teardowns.push(await transports.queue()(context()));

    emit('resilience', 'circuit-opened', { n: 1 });
    await nextTurn();

    expect(queue.calls).toEqual([{ kind: 'one', payload: expect.objectContaining({ node: 'A' }) }]);
  });
});

describe('transports.queue listener delivery', () => {
  const started: TransportHandle[] = [];
  afterEach(async () => {
    for (const handle of started.splice(0)) await handle.stop?.();
    queue.calls.length = 0;
    resetRegistry();
    bindListenerInvoker(null);
  });

  const envelope = (n: number) =>
    ({ v: 1, id: `id-${n}`, ts: 0, lib: 'agent', event: 'run.finished', payload: { n } }) as const;

  it('dispatches one listener job per (listener, event) onto the configured queue', async () => {
    const handle = (await transports.queue({ queue: 'diagnostics' })(context())) as TransportHandle;
    started.push(handle);

    await handle.deliver?.([{ listenerId: 'track#handle', envelope: envelope(1) }]);
    await handle.deliver?.([
      { listenerId: 'track#handle', envelope: envelope(2) },
      { listenerId: 'audit#handle', envelope: envelope(2) },
    ]);

    expect(queue.calls).toEqual([
      {
        kind: 'one',
        payload: { listenerId: 'track#handle', env: envelope(1) },
        queue: 'diagnostics',
      },
      {
        kind: 'many',
        payload: [
          { listenerId: 'track#handle', env: envelope(2) },
          { listenerId: 'audit#handle', env: envelope(2) },
        ],
        queue: 'diagnostics',
      },
    ]);
  });

  it('retries a listener job 3 times by default, or as configured', async () => {
    started.push((await transports.queue()(context())) as TransportHandle);
    expect(DiagnosticsListenerJob.options).toMatchObject({
      name: 'agora.diagnostics.listener',
      maxRetries: 3,
    });
    started.push((await transports.queue({ retries: 7 })(context())) as TransportHandle);
    expect(DiagnosticsListenerJob.options.maxRetries).toBe(7);
  });

  it('runs the listener in the worker and fails the job when the handler throws', async () => {
    const invoke = vi.fn(async (listenerId: string) => {
      if (listenerId === 'failing#handle') throw new Error('boom');
    });
    bindListenerInvoker(invoke);

    const ok = new DiagnosticsListenerJob();
    (ok as unknown as { payload: unknown }).payload = {
      listenerId: 'track#handle',
      env: envelope(1),
    };
    await ok.execute();
    expect(invoke).toHaveBeenCalledWith('track#handle', envelope(1));

    const failing = new DiagnosticsListenerJob();
    (failing as unknown as { payload: unknown }).payload = {
      listenerId: 'failing#handle',
      env: envelope(1),
    };
    await expect(failing.execute()).rejects.toThrow('boom');
  });

  it('fails the job (so it is retried) when diagnostics has not booted in the worker', async () => {
    const job = new DiagnosticsListenerJob();
    (job as unknown as { payload: unknown }).payload = { listenerId: 'x#y', env: envelope(1) };
    await expect(job.execute()).rejects.toThrow(/not booted/);
  });
});
