import { Job } from '@adonisjs/queue';
import type { DeliveredEvent } from '../delivery.js';
import { getListenerInvoker } from '../listener_dispatch.js';

/** Payload of one queued listener delivery. */
export interface DiagnosticsListenerPayload {
  listenerId: string;
  env: DeliveredEvent;
}

/**
 * The `@adonisjs/queue` job behind `transports.queue()` listener delivery: one job per
 * `(listener, event)`. `execute()` runs the listener through the process invoker; a handler error
 * fails the job, so the queue retries it (`retries` in the transport config).
 *
 * Imports `@adonisjs/queue` at module load, so it is loaded lazily by `transports.queue(...)`.
 */
export default class DiagnosticsListenerJob extends Job<DiagnosticsListenerPayload> {
  static override options: { name: string; maxRetries?: number } = {
    name: 'agora.diagnostics.listener',
  };

  async execute(): Promise<void> {
    const invoke = getListenerInvoker();
    if (!invoke) {
      // Thrown, not skipped: a retry can land on a worker that runs listeners.
      throw new Error(
        "@adonis-agora/diagnostics runs no listeners in this process: it is not booted, or its config.role is 'api'",
      );
    }
    await invoke(this.payload.listenerId, this.payload.env);
  }
}
