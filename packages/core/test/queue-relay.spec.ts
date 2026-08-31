import { afterEach, describe, expect, it, vi } from 'vitest';
import { emit, getChannel } from '../src/channel.js';
import { resetRegistry } from '../src/registry.js';
import { createDiagnosticsQueueRelay, getActiveReEmitter } from '../src/transports/queue.js';
import type { DiagnosticEvent } from '../src/types.js';
import { FakeJob } from './fake-queue.js';

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

  it('forwards a selected local event by dispatching a job', () => {
    const job = new FakeJob();
    teardowns.push(createDiagnosticsQueueRelay({ job, libs: ['resilience'], nodeId: 'A' }));

    emit('resilience', 'circuit-opened', { key: 'payments' });

    expect(job.dispatchCount).toBe(1);
    expect(job.dispatched[0]?.node).toBe('A');
    expect(job.dispatched[0]?.env.lib).toBe('resilience');
    expect(job.dispatched[0]?.env.event).toBe('circuit-opened');
    expect(job.dispatched[0]?.env.payload).toEqual({ key: 'payments' });
  });

  it('does not forward events of unselected libs', () => {
    const job = new FakeJob();
    teardowns.push(createDiagnosticsQueueRelay({ job, libs: ['resilience'], nodeId: 'A' }));

    emit('durable', 'run.failed', { runId: 'r1' });

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

  it('round-trips an event through the queue without looping back', () => {
    const job = new FakeJob();
    teardowns.push(createDiagnosticsQueueRelay({ job, libs: ['resilience'], nodeId: 'A' }));
    const onLocal = vi.fn();
    getChannel('resilience', 'circuit-opened').subscribe(() => onLocal());

    // local emit forwards once and fires the local subscriber once
    emit('resilience', 'circuit-opened', { key: 'p' });
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
    expect(job.dispatchCount).toBe(1);
  });

  it('honors exact channel selection and dotted event names', () => {
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

    expect(job.dispatchCount).toBe(1);
    expect(job.dispatched[0]?.env.event).toBe('run.failed');
  });

  it('forwards a future channel of a selected lib (onChannelRegistered)', () => {
    const job = new FakeJob();
    teardowns.push(createDiagnosticsQueueRelay({ job, libs: ['authz'], nodeId: 'A' }));

    // 'authz:decision' channel first registers at this emit, after the relay started
    emit('authz', 'decision', { allow: true });

    expect(job.dispatchCount).toBe(1);
    expect(job.dispatched[0]?.env.event).toBe('decision');
  });

  it('forwards every agora channel when all=true', () => {
    const job = new FakeJob();
    teardowns.push(createDiagnosticsQueueRelay({ job, all: true, nodeId: 'A' }));

    emit('resilience', 'circuit-opened', {});
    emit('durable', 'run.failed', {});

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
    await Promise.resolve();
    await Promise.resolve();
    expect(onDispatchError).toHaveBeenCalledTimes(1);
    expect((onDispatchError.mock.calls[0]?.[0] as Error | undefined)?.message).toBe('queue down');
  });

  it('stops forwarding and re-emitting after teardown', () => {
    const job = new FakeJob();
    const teardown = createDiagnosticsQueueRelay({ job, libs: ['resilience'], nodeId: 'A' });

    teardown();

    emit('resilience', 'circuit-opened', { key: 'p' }); // no longer forwarded
    expect(job.dispatchCount).toBe(0);

    // the process re-emitter is unbound after teardown
    expect(getActiveReEmitter()).toBeNull();
  });
});
