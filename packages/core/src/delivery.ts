/**
 * The listener delivery contract: types only, so a transport package (`@adonis-agora/durable`)
 * can implement it with `import type` from `@adonis-agora/diagnostics/delivery` and never load
 * diagnostics at runtime.
 *
 * Lifecycle, in every process that boots the diagnostics provider with a delivering transport
 * selected:
 *
 * 1. At boot (`ready`), after listeners are registered, the transport is created with a
 *    {@link DeliveryTransportContext}. It must register whatever it needs to run deliveries later
 *    (a job, a workflow) in THIS process too, because any process may be the one that runs them.
 * 2. When a process emits an event that matches listeners, diagnostics calls
 *    {@link ListenerDeliveryTransport.deliver} in that process only, once per matching listener,
 *    off the emitter's call stack, batched per event loop turn, in emit order. Copies of the event
 *    that reached other processes through a relay are never delivered again.
 * 3. Wherever the transport runs a delivery, it calls {@link DeliveryTransportContext.invoke}
 *    `(listenerId, envelope)`. The promise settles when the handler finishes and rejects with the
 *    handler's own error, so the transport can retry.
 * 4. On shutdown, diagnostics awaits {@link ListenerDeliveryTransport.stop}.
 */
import type { ApplicationService } from '@adonisjs/core/types';
import type { DiagnosticEvent } from './types.js';

/** An envelope handed to a delivering transport: `id` is always set. */
export type DeliveredEvent<TPayload = unknown> = DiagnosticEvent<TPayload> & { id: string };

/** One unit of work: run listener `listenerId` for `envelope`. */
export interface ListenerDelivery {
  /**
   * Stable listener id (`<file>#<method>` for a listener from the listeners directory,
   * `<ClassName>#<method>` or an explicit id for one registered in a preload). The same in every
   * process that registers the same listeners.
   */
  listenerId: string;
  /**
   * The event, as emitted. JSON-serializable when the emitting library's payload is. `id` is the
   * event id: `diag:<envelope.id>:<listenerId>` identifies this delivery uniquely, use it as the
   * idempotency key.
   */
  envelope: DeliveredEvent;
}

/**
 * Run listener `listenerId` for `envelope` in this process. Resolves when the handler finishes;
 * rejects with the handler's error (retry it), or with an error whose `code` is
 * `E_UNKNOWN_DIAGNOSTICS_LISTENER` when this process has no listener with that id.
 */
export type ListenerInvoker = (listenerId: string, envelope: DiagnosticEvent) => Promise<void>;

/** What a delivering transport receives when diagnostics creates it at boot. */
export interface DeliveryTransportContext {
  /** The booted application. */
  app: ApplicationService;
  /** Id of this process (the diagnostics `nodeId`, or a random one). */
  nodeId: string;
  /** Runs a listener in this process. See {@link ListenerInvoker}. */
  invoke: ListenerInvoker;
  /** Ids of the listeners registered in this process at boot. */
  listenerIds: readonly string[];
}

/** A transport that owns listener execution (`queue`, `durable`). */
export interface ListenerDeliveryTransport {
  /**
   * Take ownership of these deliveries. Called only in the emitting process. Should return (or
   * resolve) once the deliveries are safely enqueued; a throw or rejection is logged by
   * diagnostics and those deliveries are lost.
   */
  deliver(deliveries: readonly ListenerDelivery[]): void | Promise<void>;
  /** Release resources on shutdown. Awaited. */
  stop?(): void | Promise<void>;
}

/** Options of `transports.durable()`. They are passed to the step that runs each listener. */
export interface DurableTransportConfig {
  /** Max attempts of a listener before its run fails. */
  retries?: number;
  /** How the delay between attempts grows: constant (`fixed`) or doubling (`exp`). */
  backoff?: 'fixed' | 'exp';
  /** Base delay between attempts, in ms. */
  backoffMs?: number;
  /** Upper bound of the exponential delay, in ms. */
  backoffMaxMs?: number;
  /** Add random jitter to the delay. */
  jitter?: boolean;
}

/**
 * The module `transports.durable()` imports at boot: `@adonis-agora/durable/diagnostics`.
 */
export interface DurableDiagnosticsModule {
  /**
   * Whether durable is configured in this app (its engine can be resolved from the container).
   * Called at boot, before {@link createDeliveryTransport}; `false` makes boot fail.
   */
  isConfigured(app: ApplicationService): boolean | Promise<boolean>;
  /** Create the delivering transport. Called once per process, at boot. */
  createDeliveryTransport(
    context: DeliveryTransportContext,
    config: DurableTransportConfig,
  ): ListenerDeliveryTransport | Promise<ListenerDeliveryTransport>;
}
