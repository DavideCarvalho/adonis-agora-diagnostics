import { randomUUID } from 'node:crypto';
import { getChannel } from '../channel.js';
import { type ChannelRef, createChannelSelector, createTurnBatcher } from '../relay.js';
import { isRelayed, publishRelayed } from '../relayed.js';
import {
  createRemoteChannelGate,
  DEFAULT_MAX_REMOTE_CHANNELS,
  type RemoteChannelGate,
} from '../remote_channels.js';
import type { DiagnosticEvent } from '../types.js';
import {
  bindQueueJobAuth,
  createQueueJobAuth,
  type QueueJobAuth,
  type QueueJobAuthOptions,
  type SealedJobPayload,
} from './queue_auth.js';
import { isThenable } from './relay_auth.js';

export type { ChannelRef, SealedJobPayload };

/** What the relay dispatches: a sealed message, or the plain envelope with `insecure: true`. */
export type DiagnosticsEventJobPayload = SealedJobPayload | DiagnosticsEventEnvelope;

/**
 * The envelope a relayed diagnostics event is dispatched as. `node` is the id of the process that
 * forwarded the event (for echo suppression); `env` is the original {@link DiagnosticEvent}.
 */
export interface DiagnosticsEventEnvelope {
  /** Id of the process that forwarded the event. */
  node: string;
  /** The original diagnostics event envelope. */
  env: DiagnosticEvent;
}

/**
 * The minimal `@adonisjs/queue` `Job.dispatch` surface the relay needs to forward an event. The
 * `DiagnosticsEventJob` class satisfies it structurally, as does any job class whose
 * `dispatch(payload)` returns an awaitable. Keeping it structural lets the relay be tested without a
 * queue backend.
 */
export interface DiagnosticsEventJobLike {
  dispatch(payload: DiagnosticsEventJobPayload): PromiseLike<unknown> | unknown;
  /**
   * When present, a turn's forwarded events are pushed with one call (still one job per event, e.g.
   * `Job.dispatchMany`) instead of one `dispatch` each.
   */
  dispatchMany?(payloads: DiagnosticsEventJobPayload[]): PromiseLike<unknown> | unknown;
}

/**
 * Options of {@link createDiagnosticsQueueRelay}. Exactly one of `secret`, `crypto` or `insecure`
 * (or a ready `jobAuth`) is required: jobs are authenticated like Redis relay messages.
 */
export interface DiagnosticsQueueRelayOptions extends QueueJobAuthOptions {
  /**
   * The job authentication to seal with, instead of building one from `secret` / `crypto` /
   * `insecure` (what `transports.queue()` does, to share it with listener jobs).
   */
  jobAuth?: QueueJobAuth;
  /**
   * Called (once per reason) when a job a worker runs here is refused: unsealed, unauthenticated,
   * stale, replayed, malformed; and when the crypto cipher fails. Default: a process warning.
   */
  onError?: (error: Error) => void;
  /**
   * The job class used to forward events. Its `dispatch(envelope)` is called for each selected local
   * event. In an AdonisJS app this is the `DiagnosticsEventJob`, registered with `@adonisjs/queue`
   * so a worker in another process re-emits it locally via {@link bindRelayReEmitter}.
   */
  job: DiagnosticsEventJobLike;
  /** Forward every event of these libs (current + future channels). */
  libs?: string[];
  /** Forward these exact channels, in addition to `libs`. */
  channels?: ChannelRef[];
  /** Forward EVERY agora channel (current + future). Overrides `libs`/`channels`. Default false. */
  all?: boolean;
  /** Unique id for THIS process, for echo suppression. Default a random id. */
  nodeId?: string;
  /**
   * Whether to bind this process's re-emitter, so relay jobs a worker runs here re-emit onto the
   * local bus. Default `true`; `false` makes a forward-only relay (a `role: 'api'` process).
   */
  receive?: boolean;
  /**
   * How many channels events received from other processes may create here, on top of the ones
   * this process registered itself. Past it, events on unknown channels are dropped. Default 256.
   */
  maxRemoteChannels?: number;
  /**
   * Invoked if `job.dispatch(...)` / `job.dispatchMany(...)` throws or rejects (once per failed
   * call). Forwarding is fire-and-forget so a queue outage never throws into `emit()`; this hook
   * lets callers log the failure. Default: ignored.
   */
  onDispatchError?: (error: unknown) => void;
}

/**
 * Process-local state the `DiagnosticsEventJob` needs when its `execute()` runs in a worker:
 * the local `nodeId` (to suppress this process's own echoes) and the re-emit guard (to stop the
 * re-emitted event from being forwarded back to the queue). Populated by {@link bindRelayReEmitter}.
 */
export interface RelayReEmitter {
  /** Id of THIS process. Envelopes whose `node` equals it are this process's own echo. */
  readonly nodeId: string;
  /** Re-emit a queue-received envelope onto the local bus, guarded against re-forwarding. */
  reEmit(envelope: DiagnosticsEventEnvelope): void;
}

/**
 * Re-emit guard shared between the relay (forward side) and the job (receive side) within a process.
 * Holds the `nodeId` and the `reEmitting` WeakSet so an event re-emitted from the queue is not
 * forwarded back to the queue, mirroring the Redis relay's loop guard.
 */
class ReEmitGuard implements RelayReEmitter {
  readonly reEmitting = new WeakSet<object>();
  readonly #gate: RemoteChannelGate;
  constructor(
    readonly nodeId: string,
    maxRemoteChannels: number = DEFAULT_MAX_REMOTE_CHANNELS,
  ) {
    this.#gate = createRemoteChannelGate(maxRemoteChannels);
  }

  reEmit(envelope: DiagnosticsEventEnvelope): void {
    if (envelope === null || typeof envelope !== 'object') return;
    if (envelope.node === this.nodeId) return; // our own echo
    const env = envelope.env;
    if (env === null || typeof env !== 'object' || Array.isArray(env)) return;
    // Only valid names, on a channel this process knows or one of a bounded number of new ones.
    if (this.#gate.admit(env.lib, env.event) !== 'ok') return;
    this.reEmitting.add(env);
    try {
      publishRelayed(env, () => getChannel(env.lib, env.event).publish(env));
    } catch {
      // a local subscriber threw — never propagate into the worker
    } finally {
      this.reEmitting.delete(env);
    }
  }
}

/**
 * The active re-emitter for this process. The `DiagnosticsEventJob`'s `execute()` reads it so
 * a worker re-emits received events onto the local bus. `null` until a relay starts in this process.
 */
let activeReEmitter: ReEmitGuard | null = null;

/**
 * Bind the process-local re-emitter the `DiagnosticsEventJob` uses to publish queue-received
 * events. Called by {@link createDiagnosticsQueueRelay}; exported for advanced setups (e.g. a
 * worker-only process that forwards nothing but must still re-emit). Returns an unbind function.
 */
export function bindRelayReEmitter(reEmitter: RelayReEmitter): () => void {
  const guard = reEmitter instanceof ReEmitGuard ? reEmitter : new ReEmitGuard(reEmitter.nodeId);
  activeReEmitter = guard;
  return () => {
    if (activeReEmitter === guard) activeReEmitter = null;
  };
}

/** The re-emitter bound for this process, or `null` if no relay has started. Used by the job. */
export function getActiveReEmitter(): RelayReEmitter | null {
  return activeReEmitter;
}

/**
 * Relay diagnostics events across processes over `@adonisjs/queue`. Forwards selected local
 * `agora:<lib>:<event>` channels by dispatching a job carrying `{ node, env }`; a worker running in
 * ANOTHER process executes that job and re-emits the event onto its local bus (see the
 * `DiagnosticsEventJob`), so `onDiagnostic` handlers / `getChannel(...).subscribe(...)` fire
 * cross-process.
 *
 * A relay is fan-out (no back-channel), which fits the queue model. Loop-safe: own-process echoes
 * are suppressed by `nodeId`, and a re-emit guard stops a re-emitted event from being forwarded
 * back. Forwarding is fire-and-forget and never throws into `emit()`; the job's `execute()` never
 * throws into the worker. Does NOT own the queue lifecycle — `@adonisjs/queue` does.
 *
 * Forwarding happens off the emitter's call stack: selected events are queued and dispatched once
 * per event loop turn, in emit order — with a single `job.dispatchMany(...)` when available.
 *
 * Usually you don't call this directly: `config/diagnostics.ts` selects it via
 * `transports.queue({ ... })` and the provider starts it for you.
 *
 * @returns a teardown that dispatches any queued events, then removes all local subscriptions and
 *   unbinds the process re-emitter.
 */
export function createDiagnosticsQueueRelay(options: DiagnosticsQueueRelayOptions): () => void {
  const { job } = options;
  const nodeId = options.nodeId ?? randomUUID();
  const onDispatchError = options.onDispatchError;

  const jobAuth =
    options.jobAuth ?? createQueueJobAuth(options, queueRejectionHooks(options.onError));
  const guard = new ReEmitGuard(nodeId, options.maxRemoteChannels);
  const unbindReEmitter = options.receive === false ? () => {} : bindRelayReEmitter(guard);
  const unbindAuth = options.jobAuth ? () => {} : bindQueueJobAuth(jobAuth);
  if (jobAuth.mode === 'insecure') warnInsecureQueue();

  const report = (err: unknown): void => {
    try {
      onDispatchError?.(err);
    } catch {
      // the hook runs outside any caller — a throwing hook must not become an uncaught exception
    }
  };

  // dispatch is async (push to the queue backend) — fire-and-forget, but surface failures
  const fireAndReport = (dispatch: () => unknown): void => {
    try {
      const result = dispatch();
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        (result as PromiseLike<unknown>).then(undefined, report);
      }
    } catch (err) {
      report(err);
    }
  };

  const send = (payloads: DiagnosticsEventJobPayload[]): void => {
    if (payloads.length === 0) return;
    if (payloads.length > 1 && typeof job.dispatchMany === 'function') {
      fireAndReport(() => job.dispatchMany?.(payloads));
      return;
    }
    for (const payload of payloads) fireAndReport(() => job.dispatch(payload));
  };

  // Sealing may wait for the crypto server (once an hour): turns keep their order behind it.
  let tail: Promise<void> | null = null;
  const batcher = createTurnBatcher<DiagnosticEvent>((envs) => {
    const run = (): void | Promise<void> => {
      let sealed: ReturnType<QueueJobAuth['seal']>;
      try {
        sealed = jobAuth.seal('event', nodeId, envs);
      } catch (error) {
        report(error);
        return;
      }
      if (!isThenable<DiagnosticsEventJobPayload[]>(sealed)) {
        send(sealed as DiagnosticsEventJobPayload[]);
        return;
      }
      return Promise.resolve(sealed).then(
        (payloads) => send(payloads as DiagnosticsEventJobPayload[]),
        report,
      );
    };
    if (tail) {
      tail = tail.then(run);
      return;
    }
    const pending = run();
    if (pending) {
      const current: Promise<void> = pending.then(() => {
        if (tail === current) tail = null;
      });
      tail = current;
    }
  });

  const forward = (msg: unknown): void => {
    if (typeof msg !== 'object' || msg === null) return;
    // A re-emitted remote event (by this relay or any other in this process): never send it on.
    if (guard.reEmitting.has(msg) || isRelayed(msg)) return;
    batcher.push(msg as DiagnosticEvent);
  };

  const selector = createChannelSelector(options, forward);

  return () => {
    batcher.flush();
    selector.stop();
    unbindReEmitter();
    unbindAuth();
  };
}

/** The code of the errors `onError` receives for refused jobs. */
export const QUEUE_JOB_REJECTED = 'AGORA_DIAGNOSTICS_QUEUE_JOB_REJECTED';

const QUEUE_REJECTION_MESSAGES: Record<string, string> = {
  unsealed:
    'refused a diagnostics queue job without authentication (dispatched by an older version, or written into the queue backend by someone else)',
  unauthenticated:
    'refused a diagnostics queue job that failed authentication (is every process configured with the same `secret` / `crypto` key?)',
  stale:
    'refused a diagnostics queue job older than maxJobAge (or more than a minute ahead: check clocks)',
  replayed: 'refused a diagnostics queue job whose message another job already carried (a replay)',
  malformed: 'refused a malformed diagnostics queue job',
  'crypto-unavailable': 'the queue transport could not use its crypto key',
};

let warnedInsecureQueue = false;

function warnInsecureQueue(): void {
  if (warnedInsecureQueue) return;
  warnedInsecureQueue = true;
  try {
    process.emitWarning(
      '[@adonis-agora/diagnostics] the queue transport runs with `insecure: true`: anyone who can write jobs into the queue backend can inject diagnostics events and run listeners with input of their choosing. Set `secret` or `crypto` outside local development.',
      { code: 'AGORA_DIAGNOSTICS_INSECURE_RELAY' },
    );
  } catch {
    // a throwing warning listener must not break the relay
  }
}

/** Reports refused jobs once per reason, to `onError` or as a process warning. */
export function queueRejectionHooks(onError?: (error: Error) => void): {
  onReject: (reason: string, kind: string) => void;
  onError: (error: unknown) => void;
} {
  const reported = new Set<string>();
  const report = (reason: string, cause?: unknown): void => {
    if (reported.has(reason)) return;
    reported.add(reason);
    const error = Object.assign(
      new Error(
        `[@adonis-agora/diagnostics] ${QUEUE_REJECTION_MESSAGES[reason] ?? `refused a diagnostics queue job (${reason})`}`,
        { cause },
      ),
      { code: QUEUE_JOB_REJECTED, reason },
    );
    try {
      if (onError) onError(error);
      else process.emitWarning(error.message, { code: QUEUE_JOB_REJECTED });
    } catch {
      // a throwing hook must not break the worker
    }
  };
  return {
    onReject: (reason) => report(reason),
    onError: (cause) => report('crypto-unavailable', cause),
  };
}
