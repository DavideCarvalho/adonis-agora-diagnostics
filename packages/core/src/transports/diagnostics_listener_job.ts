import { Job } from '@adonisjs/queue';
import type { DeliveredEvent } from '../delivery.js';
import { getListenerInvoker } from '../listener_dispatch.js';
import { jobIdOf } from './diagnostics_event_job.js';
import { getQueueJobAuth, type SealedJobPayload } from './queue_auth.js';

/** One queued listener delivery, before it is sealed. */
export interface DiagnosticsListenerPayload {
  listenerId: string;
  env: DeliveredEvent;
}

/**
 * The `@adonisjs/queue` job behind `transports.queue()` listener delivery: one job per
 * `(listener, event)`. `execute()` authenticates the payload (`secret` or `crypto`, bound by the
 * queue transport in the worker), then runs the listener through the process invoker; a handler
 * error fails the job, so the queue retries it (`retries` in the transport config). A retry carries
 * the same job id and passes again; a job that fails authentication is refused, reported, and not
 * retried.
 *
 * Imports `@adonisjs/queue` at module load, so it is loaded lazily by `transports.queue(...)`.
 */
export default class DiagnosticsListenerJob extends Job<
  SealedJobPayload | DiagnosticsListenerPayload
> {
  static override options: { name: string; maxRetries?: number } = {
    name: 'agora.diagnostics.listener',
  };

  async execute(): Promise<void> {
    const invoke = getListenerInvoker();
    const auth = getQueueJobAuth();
    if (!invoke || !auth) {
      // Thrown, not skipped: a retry can land on a worker that runs listeners.
      throw new Error(
        "@adonis-agora/diagnostics runs no listeners in this process: it is not booted, its config.role is 'api', or its default transport is not the queue",
      );
    }
    const opened = await auth.open('listener', this.payload, jobIdOf(this));
    if (!opened) return; // refused and reported: retrying would not change the verdict
    const item = opened.item as Partial<DiagnosticsListenerPayload> | null;
    if (
      item === null ||
      typeof item !== 'object' ||
      typeof item.listenerId !== 'string' ||
      item.env === null ||
      typeof item.env !== 'object'
    ) {
      return;
    }
    await invoke(item.listenerId, item.env);
  }
}
