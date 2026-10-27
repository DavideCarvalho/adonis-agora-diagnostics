import { afterEach, describe, expect, it, vi } from 'vitest';
import { emit, getChannel } from '../src/channel.js';
import { resetRegistry } from '../src/registry.js';
import { createDiagnosticsQueueRelay, getActiveReEmitter } from '../src/transports/queue.js';
import type { DiagnosticEvent } from '../src/types.js';
import { FakeBatchJob, FakeJob } from './fake-queue.js';

/** Let the relay's per-turn flush run. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Simulate a worker in another process receiving the job: hand the envelope to the bound re-emitter. */
function deliverToWorker(envelope: { node: string; env: DiagnosticEvent }) {
  const reEmitter = getActiveReEmitter();
  if (!reEmitter) throw new Error('no re-emitter bound');
  reEmitter.reEmit(envelope);
}

describe('createDiagnosticsQueueRelay', () => {
  const teardowns: Array<() => void> = [];
  afterEach(() => {
    for (const t of teardowns.splice(0)) t();
    resetRegistry();
  });

  it('forwards a selected local event by dispatching a job', async () => {
    const job = new FakeJob();
    teardowns.push(createDiagnosticsQueueRelay({ job, libs: ['resilience'], nodeId: 'A' }));

    emit('resilience', 'circuit-opened', { key: 'payments' });
    await nextTurn();

    expect(job.dispatchCount).toBe(1);
    expect(job.dispatched[0]?.node).toBe('A');
    expect(job.dispatched[0]?.env.lib).toBe('resilience');
    expect(job.dispatched[0]?.env.event).toBe('circuit-opened');
    expect(job.dispatched[0]?.env.payload).toEqual({ key: 'payments' });
  });

  it('does not forward events of unselected libs', async () => {
    const job = new FakeJob();
    teardowns.push(createDiagnosticsQueueRelay({ job, libs: ['resilience'], nodeId: 'A' }));

    emit('durable', 'run.failed', { runId: 'r1' });
    await nextTurn();

    expect(job.dispatchCount).toBe(0);
  });

  it('re-emits a queue-received event onto the local bus', () => {
    const job = new FakeJob();
    teardowns.push(createDiagnosticsQueueRelay({ job, libs: ['resilience'], nodeId: 'B' }));
    const local = vi.fn();
    getChannel('resilience', 'circuit-opened').subscribe((m) => local(m));

    const env: DiagnosticEvent = {
      ts: 1,
      lib: 'resilience',
      event: 'circuit-opened',
      payload: { key: 'x' },
    };
    deliverToWorker({ node: 'OTHER', env });

    expect(local).toHaveBeenCalledTimes(1);
    expect((local.mock.calls[0]?.[0] as DiagnosticEvent | undefined)?.payload).toEqual({
      key: 'x',
    });
  });

  it('suppresses its own echo (node === nodeId)', () => {
    const job = new FakeJob();
    teardowns.push(createDiagnosticsQueueRelay({ job, libs: ['resilience'], nodeId: 'A' }));
    const local = vi.fn();
    getChannel('resilience', 'circuit-opened').subscribe(() => local());

    const env: DiagnosticEvent = { ts: 1, lib: 'resilience', event: 'circuit-opened', payload: {} };
    deliverToWorker({ node: 'A', env });

    expect(local).not.toHaveBeenCalled();
  });

  it('round-trips an event through the queue without looping back', async () => {
    const job = new FakeJob();
    teardowns.push(createDiagnosticsQueueRelay({ job, libs: ['resilience'], nodeId: 'A' }));
    const onLocal = vi.fn();
    getChannel('resilience', 'circuit-opened').subscribe(() => onLocal());

    // local emit forwards once and fires the local subscriber once
    emit('resilience', 'circuit-opened', { key: 'p' });
    await nextTurn();
    expect(job.dispatchCount).toBe(1);
    expect(onLocal).toHaveBeenCalledTimes(1);

    // the same event arriving from ANOTHER node is re-emitted locally once...
    const env: DiagnosticEvent = {
      ts: 1,
      lib: 'resilience',
      event: 'circuit-opened',
      payload: { key: 'p' },
    };
    deliverToWorker({ node: 'B', env });
    expect(onLocal).toHaveBeenCalledTimes(2);
    // ...and the re-emit is NOT forwarded back to the queue (loop guard held)
    await nextTurn();
    expect(job.dispatchCount).toBe(1);
  });

  it('honors exact channel selection and dotted event names', async () => {
    const job = new FakeJob();
    teardowns.push(
      createDiagnosticsQueueRelay({
        job,
        channels: [{ lib: 'durable', event: 'run.failed' }],
        nodeId: 'A',
      }),
    );

    emit('durable', 'run.failed', { runId: 'r1' });
    emit('durable', 'run.started', { runId: 'r1' });
    await nextTurn();

    expect(job.dispatchCount).toBe(1);
    expect(job.dispatched[0]?.env.event).toBe('run.failed');
  });

  it('forwards a future channel of a selected lib (onChannelRegistered)', async () => {
    const job = new FakeJob();
    teardowns.push(createDiagnosticsQueueRelay({ job, libs: ['authz'], nodeId: 'A' }));

    // 'authz:decision' channel first registers at this emit, after the relay started
    emit('authz', 'decision', { allow: true });
    await nextTurn();

    expect(job.dispatchCount).toBe(1);
    expect(job.dispatched[0]?.env.event).toBe('decision');
  });

  it('forwards every agora channel when all=true', async () => {
    const job = new FakeJob();
    teardowns.push(createDiagnosticsQueueRelay({ job, all: true, nodeId: 'A' }));

    emit('resilience', 'circuit-opened', {});
    emit('durable', 'run.failed', {});
    await nextTurn();

    expect(job.dispatchCount).toBe(2);
  });

  it('ignores malformed queue envelopes without throwing', () => {
    const job = new FakeJob();
    teardowns.push(createDiagnosticsQueueRelay({ job, all: true, nodeId: 'A' }));
    const reEmitter = getActiveReEmitter();
    expect(reEmitter).not.toBeNull();
    // missing env / wrong shapes must not throw
    expect(() => reEmitter?.reEmit({ node: 'X' } as never)).not.toThrow();
    expect(() => reEmitter?.reEmit({ node: 'X', env: { lib: 1 } } as never)).not.toThrow();
  });

  it('never throws into emit() and reports dispatch rejections', async () => {
    const job = new FakeJob();
    job.rejectWith = new Error('queue down');
    const onDispatchError = vi.fn();
    teardowns.push(
      createDiagnosticsQueueRelay({ job, libs: ['resilience'], nodeId: 'A', onDispatchError }),
    );

    expect(() => emit('resilience', 'circuit-opened', {})).not.toThrow();
    // dispatch rejection is surfaced asynchronously via the hook
    await nextTurn();
    await Promise.resolve();
    await Promise.resolve();
    expect(onDispatchError).toHaveBeenCalledTimes(1);
    expect((onDispatchError.mock.calls[0]?.[0] as Error | undefined)?.message).toBe('queue down');
  });

  it('stops forwarding and re-emitting after teardown', async () => {
    const job = new FakeJob();
    const teardown = createDiagnosticsQueueRelay({ job, libs: ['resilience'], nodeId: 'A' });

    teardown();

    emit('resilience', 'circuit-opened', { key: 'p' }); // no longer forwarded
    await nextTurn();
    expect(job.dispatchCount).toBe(0);

    // the process re-emitter is unbound after teardown
    expect(getActiveReEmitter()).toBeNull();
  });

  describe('forwarding off the emitter call stack', () => {
    it('returns from emit() before any job is dispatched', async () => {
      const job = new FakeBatchJob();
      teardowns.push(createDiagnosticsQueueRelay({ job, libs: ['resilience'], nodeId: 'A' }));

      emit('resilience', 'circuit-opened', { n: 1 });
      expect(job.dispatchCount).toBe(0);
      expect(job.batches).toHaveLength(0);

      await nextTurn();
      expect(job.dispatchCount).toBe(1);
    });

    it('dispatches N events emitted in one turn with a single dispatchMany, in emit order', async () => {
      const job = new FakeBatchJob();
      teardowns.push(createDiagnosticsQueueRelay({ job, all: true, nodeId: 'A' }));

      for (let i = 0; i < 50; i++) {
        emit('durable', i % 2 === 0 ? 'run.started' : 'run.failed', { i });
      }
      await nextTurn();

      expect(job.batches).toHaveLength(1);
      expect(job.dispatchCount).toBe(0);
      // one job payload per event, unchanged envelope shape
      const batch = job.batches[0] ?? [];
      expect(batch.map((e) => (e.env.payload as { i: number }).i)).toEqual(
        Array.from({ length: 50 }, (_, i) => i),
      );
      expect(batch.every((e) => e.node === 'A')).toBe(true);
    });

    it('dispatches one job per event in order when the job has no dispatchMany', async () => {
      const job = new FakeJob();
      teardowns.push(createDiagnosticsQueueRelay({ job, libs: ['resilience'], nodeId: 'A' }));

      emit('resilience', 'circuit-opened', { n: 1 });
      emit('resilience', 'circuit-closed', { n: 2 });
      emit('resilience', 'circuit-opened', { n: 3 });
      expect(job.dispatchCount).toBe(0);
      await nextTurn();

      expect(job.dispatched.map((e) => (e.env.payload as { n: number }).n)).toEqual([1, 2, 3]);
    });

    it('dispatches queued events synchronously on teardown', () => {
      const job = new FakeBatchJob();
      const teardown = createDiagnosticsQueueRelay({ job, libs: ['resilience'], nodeId: 'A' });

      emit('resilience', 'circuit-opened', { n: 1 });
      emit('resilience', 'circuit-closed', { n: 2 });
      teardown();

      expect(job.batches.flat().map((e) => (e.env.payload as { n: number }).n)).toEqual([1, 2]);
    });

    it('reports a rejected dispatchMany once through onDispatchError', async () => {
      const job = new FakeBatchJob();
      job.rejectWith = new Error('queue down');
      const onDispatchError = vi.fn();
      teardowns.push(
        createDiagnosticsQueueRelay({ job, libs: ['resilience'], nodeId: 'A', onDispatchError }),
      );

      emit('resilience', 'circuit-opened', {});
      emit('resilience', 'circuit-opened', {});
      await nextTurn();
      await Promise.resolve();

      expect(onDispatchError).toHaveBeenCalledTimes(1);
      expect((onDispatchError.mock.calls[0]?.[0] as Error | undefined)?.message).toBe('queue down');
    });

    it('reports a synchronously throwing dispatch and survives a throwing hook', async () => {
      const job = new FakeJob();
      job.dispatch = () => {
        throw new Error('boom');
      };
      const onDispatchError = vi.fn(() => {
        throw new Error('hook failed');
      });
      teardowns.push(
        createDiagnosticsQueueRelay({ job, libs: ['resilience'], nodeId: 'A', onDispatchError }),
      );
      const uncaught = vi.fn();
      process.on('uncaughtException', uncaught);
      try {
        expect(() => emit('resilience', 'circuit-opened', {})).not.toThrow();
        await nextTurn();
        expect(onDispatchError).toHaveBeenCalledTimes(1);
        expect(uncaught).not.toHaveBeenCalled();
      } finally {
        process.off('uncaughtException', uncaught);
      }
    });
  });
});
