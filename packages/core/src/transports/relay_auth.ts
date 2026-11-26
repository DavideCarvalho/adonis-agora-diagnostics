import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { channelName } from '../channel.js';
import { isChannelRegistered } from '../registry.js';

/**
 * Authentication for the cross-process transports (Redis relay, queue jobs). Every message carries
 * an HMAC-SHA256 under a key every process of the deployment shares: the transport's `secret`, or
 * else one derived from the app's `APP_KEY`. A message that does not verify, is too old (or too far
 * ahead), or was already seen is dropped. Without a usable key the transport refuses to start.
 */

/** A secret as configured: a string, or a `Secret` (`env.get(...)` in AdonisJS). */
export type RelaySecret = string | { release(): string };

/** The key options both transports accept. */
export interface RelayAuthOptions {
  /**
   * A secret every process that relays shares, at least 16 characters. Takes precedence over
   * `appKey`; set it when the processes of different apps relay to each other.
   */
  secret?: RelaySecret | undefined;
  /** The app's `APP_KEY` (processes of the same app share it). Used when no `secret` is set. */
  appKey?: RelaySecret | undefined;
}

/** How far a Redis message's timestamp may be from now (both ways). */
export const MAX_RELAY_SKEW_MS = 60_000;
/** How long a queued job stays valid by default (it may wait in a backlog, and be retried). */
export const DEFAULT_MAX_JOB_AGE_MS = 24 * 60 * 60_000;
/** At most this many message ids are remembered per process for replay detection. */
const MAX_SEEN_IDS = 100_000;

/** What `lib` and `event` names a relayed event may carry. */
export const LIB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const EVENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** How many new channels relayed events may create per process, by default. */
export const DEFAULT_MAX_REMOTE_CHANNELS = 256;

function release(secret: RelaySecret | undefined): string | undefined {
  if (secret === undefined || secret === null) return undefined;
  try {
    const raw = typeof secret === 'string' ? secret : secret.release();
    return typeof raw === 'string' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The HMAC key for one transport (`label`), from `secret` or else `appKey`. Throws, naming the
 * option to set, when neither is usable.
 */
export function relayKey(options: RelayAuthOptions, label: string, what: string): Buffer {
  const secret = release(options.secret);
  if (secret !== undefined) {
    if (secret.length < 16) {
      throw new Error(
        `[@adonis-agora/diagnostics] ${what}: \`secret\` must be at least 16 characters`,
      );
    }
    return createHmac('sha256', secret).update(`agora:diagnostics:${label}:secret`).digest();
  }
  const appKey = release(options.appKey);
  if (appKey !== undefined && appKey.length >= 16) {
    return createHmac('sha256', appKey).update(`agora:diagnostics:${label}:app-key`).digest();
  }
  throw new Error(
    `[@adonis-agora/diagnostics] ${what} needs a key to authenticate its messages: set APP_KEY (processes of the same app), or pass \`secret\` (at least 16 characters, the same in every process) to the transport in config/diagnostics.ts`,
  );
}

/** Deterministic JSON (object keys sorted, `undefined` members dropped): what the MAC covers. */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(Number.isFinite(value) ? value : null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('[@adonis-agora/diagnostics] cannot canonicalize the message');
}

/** An authenticated message: who sent it, when, a unique id, the event, and the MAC. */
export interface SignedFrame {
  v: 1;
  id: string;
  ts: number;
  node: string;
  env: unknown;
  mac: string;
}

function macOf(key: Buffer, frame: Omit<SignedFrame, 'mac'>): string {
  return createHmac('sha256', key)
    .update(canonicalJson([frame.v, frame.id, frame.ts, frame.node, frame.env]))
    .digest('base64url');
}

/** Signs `env` (as it will look after a JSON round trip) for the other processes. */
export function signFrame(key: Buffer, node: string, env: unknown): SignedFrame {
  const wire = JSON.parse(JSON.stringify(env)) as unknown;
  const frame = { v: 1 as const, id: randomUUID(), ts: Date.now(), node, env: wire };
  return { ...frame, mac: macOf(key, frame) };
}

/** Why a message was dropped. */
export type RelayRejection = 'malformed' | 'unsigned' | 'forged' | 'stale' | 'replayed';

/**
 * Checks a received frame: its shape, its MAC, and its age (`maxAgeMs` into the past,
 * {@link MAX_RELAY_SKEW_MS} into the future). Returns the frame, or why it was refused.
 */
export function verifyFrame(
  key: Buffer,
  value: unknown,
  maxAgeMs: number,
): SignedFrame | RelayRejection {
  if (value === null || typeof value !== 'object') return 'malformed';
  const frame = value as Partial<SignedFrame>;
  if (frame.v !== 1 || typeof frame.mac !== 'string') return 'unsigned';
  if (
    typeof frame.id !== 'string' ||
    frame.id === '' ||
    typeof frame.ts !== 'number' ||
    !Number.isFinite(frame.ts) ||
    typeof frame.node !== 'string'
  ) {
    return 'malformed';
  }
  let expected: Buffer;
  try {
    expected = Buffer.from(
      macOf(key, { v: 1, id: frame.id, ts: frame.ts, node: frame.node, env: frame.env }),
    );
  } catch {
    return 'malformed';
  }
  const actual = Buffer.from(frame.mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return 'forged';
  const now = Date.now();
  if (frame.ts < now - maxAgeMs || frame.ts > now + MAX_RELAY_SKEW_MS) return 'stale';
  return frame as SignedFrame;
}

/**
 * Remembers message ids for as long as they could still verify, so a replayed message is dropped.
 * `accept(id, holder)` is true the first time an id is seen, and again only for the same `holder`
 * (a queue job's own retry).
 */
export class ReplayGuard {
  readonly #seen = new Map<string, { holder: string | undefined; expires: number }>();
  constructor(readonly windowMs: number) {}

  accept(id: string, holder?: string, now = Date.now()): boolean {
    for (const [seenId, entry] of this.#seen) {
      if (entry.expires > now && this.#seen.size < MAX_SEEN_IDS) break;
      this.#seen.delete(seenId);
    }
    const seen = this.#seen.get(id);
    if (seen) return holder !== undefined && seen.holder === holder;
    this.#seen.set(id, { holder, expires: now + this.windowMs });
    return true;
  }
}

/** Whether `(lib, event)` are well-formed names for a relayed event. */
export function isValidRemoteChannel(lib: unknown, event: unknown): boolean {
  return (
    typeof lib === 'string' &&
    typeof event === 'string' &&
    LIB_NAME_PATTERN.test(lib) &&
    EVENT_NAME_PATTERN.test(event)
  );
}

/**
 * Bounds the channels relayed events may create in this process: an existing channel is always
 * fine, a new one only while fewer than `max` were created this way.
 */
export function createRemoteChannelGate(max: number = DEFAULT_MAX_REMOTE_CHANNELS) {
  if (!Number.isInteger(max) || max < 0) {
    throw new TypeError(
      `[@adonis-agora/diagnostics] maxRemoteChannels must be a non-negative integer (got ${String(max)})`,
    );
  }
  const admitted = new Set<string>();
  return {
    admit(lib: unknown, event: unknown): 'ok' | 'invalid' | 'full' {
      if (!isValidRemoteChannel(lib, event)) return 'invalid';
      const name = channelName(lib as string, event as string);
      if (admitted.has(name) || isChannelRegistered(name)) return 'ok';
      if (admitted.size >= max) return 'full';
      admitted.add(name);
      return 'ok';
    },
  };
}

/** Calls `report(reason)` once per distinct reason (so a flood of bad messages logs one line each). */
export function oncePerReason(
  report: ((reason: string) => void) | undefined,
): (reason: string) => void {
  const seen = new Set<string>();
  return (reason) => {
    if (seen.has(reason)) return;
    seen.add(reason);
    try {
      report?.(reason);
    } catch {
      // a throwing hook must never break the relay
    }
  };
}
