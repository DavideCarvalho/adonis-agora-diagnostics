import { capability } from '../capability.js';
import {
  createRelayCodec,
  isThenable,
  MAX_RELAY_SKEW_MS,
  type RelayAuthOptions,
  type RelayCodec,
  type RelayRejection,
} from './relay_auth.js';

/**
 * Authentication of the queue transport's jobs. A queue backend is not a trust boundary either:
 * whoever can write a job into it could otherwise inject events (`agora.diagnostics.event`) or run
 * any listener with input of their choosing (`agora.diagnostics.listener`). So each job carries a
 * message sealed with the same modes as the Redis relay (`secret`, `crypto`, or `insecure` on
 * explicit opt-in), each kind of job under its own label, so one kind cannot be passed off as the
 * other.
 *
 * Freshness and replays differ from Redis, because a job legitimately waits in a backlog and is
 * retried with the very same payload:
 *
 * - a job is refused once its message is older than `maxJobAge` (default 24 hours), not one minute;
 * - a message id is bound to the queue's **job id** the first time a worker sees it: the same job
 *   retried (same job id, any attempt) passes, the same message in another job (a copy written into
 *   the backend) is refused as a replay. Ids are remembered for the age window, per process.
 */

/** The authenticated payload of a diagnostics job. */
export interface SealedJobPayload {
  /** The message, as the relay codec wrote it (`s1\n…` with a secret, `c1\n…` with crypto). */
  sealed: string;
}

/** The two kinds of diagnostics jobs. */
export type DiagnosticsJobKind = 'event' | 'listener';

/** How long a queued job stays valid by default (it may wait in a backlog, and be retried). */
export const DEFAULT_MAX_JOB_AGE_MS = 24 * 60 * 60_000;

/** Message ids remembered per process, at most. */
const MAX_SEEN_JOB_IDS = 100_000;

const LABELS: Record<DiagnosticsJobKind, string> = {
  event: 'queue:agora.diagnostics.event',
  listener: 'queue:agora.diagnostics.listener',
};

/** What a worker opened from a job: the sender, and the item it sealed. */
export interface OpenedJob {
  node: string;
  item: unknown;
}

/** Seals and opens the queue transport's jobs. */
export interface QueueJobAuth {
  readonly mode: 'appKey' | 'secret' | 'crypto' | 'insecure';
  /**
   * The job payloads for `items` (one per item; an unserializable item is left out). In `insecure`
   * mode the payload is the item itself, plus `node` for events.
   */
  seal(
    kind: DiagnosticsJobKind,
    node: string,
    items: readonly object[],
  ): Array<SealedJobPayload | object> | Promise<Array<SealedJobPayload | object>>;
  /** Authenticate a job a worker runs: `null` refuses it (and reports why). */
  open(
    kind: DiagnosticsJobKind,
    payload: unknown,
    jobId: string | undefined,
  ): OpenedJob | null | Promise<OpenedJob | null>;
}

/** Why a job was refused (on top of the relay codec's reasons). */
export type QueueJobRejection = RelayRejection | 'unsealed';

/** Remembers which job first carried each message id. */
class JobReplayGuard {
  readonly #seen = new Map<string, { jobId: string | undefined; expires: number }>();
  constructor(readonly windowMs: number) {}

  accept(id: string, jobId: string | undefined, now: number): boolean {
    for (const [seenId, entry] of this.#seen) {
      if (entry.expires > now && this.#seen.size < MAX_SEEN_JOB_IDS) break;
      this.#seen.delete(seenId);
    }
    const seen = this.#seen.get(id);
    if (seen) return jobId !== undefined && seen.jobId === jobId;
    this.#seen.set(id, { jobId, expires: now + this.windowMs });
    return true;
  }
}

export interface QueueJobAuthOptions extends RelayAuthOptions {
  /** How long a job stays valid after it was dispatched, in milliseconds. Default 24 hours. */
  maxJobAgeMs?: number | undefined;
}

/**
 * The job authentication for `options`; throws when no (or more than one) mode is configured, with
 * the same message as the Redis relay.
 */
export function createQueueJobAuth(
  options: QueueJobAuthOptions,
  hooks: {
    onReject: (reason: QueueJobRejection, kind: DiagnosticsJobKind) => void;
    onError: (error: unknown) => void;
  },
): QueueJobAuth {
  const maxAgeMs = options.maxJobAgeMs ?? DEFAULT_MAX_JOB_AGE_MS;
  const codecs = {} as Record<DiagnosticsJobKind, RelayCodec>;
  for (const kind of ['event', 'listener'] as const) {
    codecs[kind] = createRelayCodec(
      options,
      LABELS[kind],
      { onReject: (reason) => hooks.onReject(reason, kind), onError: hooks.onError },
      { maxAgeMs, replayGuard: false, what: 'the queue transport' },
    );
  }
  const mode = codecs.event.mode;
  const guard = new JobReplayGuard(maxAgeMs + 2 * MAX_RELAY_SKEW_MS);

  if (mode === 'insecure') {
    return {
      mode,
      seal(kind, node, items) {
        return kind === 'event' ? items.map((env) => ({ node, env })) : [...items];
      },
      open(kind, payload) {
        if (payload === null || typeof payload !== 'object') {
          hooks.onReject('malformed', kind);
          return null;
        }
        if (kind === 'listener') return { node: '', item: payload };
        const { node, env } = payload as { node?: unknown; env?: unknown };
        return { node: typeof node === 'string' ? node : '', item: env };
      },
    };
  }

  const wrap = (messages: string[]): SealedJobPayload[] => messages.map((sealed) => ({ sealed }));

  return {
    mode,
    seal(kind, node, items) {
      const encoded = codecs[kind].encode(node, items);
      return isThenable<string[]>(encoded) ? Promise.resolve(encoded).then(wrap) : wrap(encoded);
    },
    open(kind, payload, jobId) {
      const sealed = (payload as Partial<SealedJobPayload> | null)?.sealed;
      if (typeof sealed !== 'string') {
        hooks.onReject('unsealed', kind);
        return null;
      }
      const check = (
        frame: { node: string; env: unknown; id?: string } | null,
      ): OpenedJob | null => {
        if (!frame || typeof frame.id !== 'string') return null;
        if (!guard.accept(frame.id, jobId, Date.now())) {
          hooks.onReject('replayed', kind);
          return null;
        }
        return { node: frame.node, item: frame.env };
      };
      const frame = codecs[kind].decode(sealed);
      return isThenable<{ node: string; env: unknown; id?: string } | null>(frame)
        ? Promise.resolve(frame).then(check)
        : check(frame);
    },
  };
}

const QUEUE_AUTH_SLOT = capability('diagnostics', 'queue-auth');

/**
 * Bind the job authentication the diagnostics jobs of this process open their payloads with.
 * `transports.queue()` (and {@link createDiagnosticsQueueRelay}) do it; returns an unbind.
 */
export function bindQueueJobAuth(auth: QueueJobAuth | null): () => void {
  const slots = globalThis as Record<symbol, unknown>;
  slots[QUEUE_AUTH_SLOT] = auth ?? undefined;
  return () => {
    if (slots[QUEUE_AUTH_SLOT] === auth) slots[QUEUE_AUTH_SLOT] = undefined;
  };
}

/** The job authentication bound in this process, or `null` before a queue transport started. */
export function getQueueJobAuth(): QueueJobAuth | null {
  return ((globalThis as Record<symbol, unknown>)[QUEUE_AUTH_SLOT] as QueueJobAuth) ?? null;
}
