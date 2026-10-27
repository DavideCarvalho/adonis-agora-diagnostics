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
import { resetRegistry } from '../src/registry.js';
import type { TransportContext } from '../src/transports/factory.js';
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

describe('transports.queue', () => {
  const teardowns: Array<() => void> = [];
  afterEach(() => {
    for (const t of teardowns.splice(0)) t();
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
