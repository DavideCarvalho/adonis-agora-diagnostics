import type { DiagnosticsEventEnvelope, DiagnosticsEventJobLike } from '../src/transports/queue.js';

/**
 * In-memory stand-in for the `@adonisjs/queue` job used by the relay. Records every dispatched
 * envelope so tests can assert what the relay forwarded — and replay envelopes through a bound
 * re-emitter to simulate a worker in another process running the real job's `execute()`.
 */
export class FakeJob implements DiagnosticsEventJobLike {
  public readonly dispatched: DiagnosticsEventEnvelope[] = [];
  public dispatchCount = 0;
  /** When set, dispatch rejects with this reason (to exercise `onDispatchError`). */
  public rejectWith: unknown = undefined;

  dispatch(payload: DiagnosticsEventEnvelope): Promise<void> {
    this.dispatchCount += 1;
    this.dispatched.push(payload);
    if (this.rejectWith !== undefined) return Promise.reject(this.rejectWith);
    return Promise.resolve();
  }
}

/** A {@link FakeJob} that also supports bulk dispatch, like `Job.dispatchMany`. */
export class FakeBatchJob extends FakeJob {
  public readonly batches: DiagnosticsEventEnvelope[][] = [];

  dispatchMany(payloads: DiagnosticsEventEnvelope[]): Promise<void> {
    this.batches.push(payloads);
    if (this.rejectWith !== undefined) return Promise.reject(this.rejectWith);
    return Promise.resolve();
  }
}
