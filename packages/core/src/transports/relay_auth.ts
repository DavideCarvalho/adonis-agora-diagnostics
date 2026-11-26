import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Authentication of the relays (Redis pub/sub messages, queue jobs). Neither Redis nor a queue
 * backend is a trust boundary: whoever can publish on the relay channel or write a job (another app
 * on a shared instance, a leaked password, an SSRF) could otherwise inject events every process
 * shows as its own, or run listeners with input of their choosing. So each message is authenticated
 * with one of:
 *
 * - **appKey** (the automatic mode of the AdonisJS transports): the processes of one app share its
 *   `APP_KEY`; an AES-256-GCM key derived from it (HKDF-SHA256, purpose `agora:diagnostics:relay`)
 *   encrypts and authenticates each message, its AAD bound to the channel. Nothing to configure.
 * - **secret**: every relaying process holds the same shared secret; each message carries an
 *   HMAC-SHA256 over its body (sender node, message id, timestamp, event), under a key derived from
 *   the secret and the Redis channel.
 * - **crypto** (explicit only, for relays across apps): an `@adonis-agora/crypto` key
 *   (`console-diagnostics` by default), or any KMS with `encrypt`/`decrypt`. Each process seals a
 *   random session key with it (one `encrypt` per process per hour) and encrypts its messages with
 *   that session key (AES-256-GCM, locally); receivers open each session key once (one `decrypt`)
 *   and cache it. Whoever may encrypt and decrypt with the crypto key is a relay peer, and nothing
 *   of an event is readable on Redis.
 * - **insecure**: the unauthenticated wire of earlier versions, only on explicit opt-in.
 *
 * Redis messages older than a minute (or more than a minute ahead) are refused, and a message id
 * seen within the window is refused as a replay. Queue jobs wait in a backlog and are retried, so
 * they get a longer window and their own replay rule (see `queue_auth.ts`).
 */

/** A shared secret: a string, or a Secret-like object (`env.get('X')` in AdonisJS). */
export type RelaySecret = string | { release(): string };

/** The `encrypt`/`decrypt` pair `@adonis-agora/crypto` exposes (`crypto.client`, `serviceCipher`). */
export interface RelayCipher {
  encrypt(input: {
    key: string;
    plaintext: string;
    aad?: string;
    context?: string;
  }): Promise<{ ciphertext: string }>;
  decrypt(input: {
    key: string;
    ciphertext: string;
    aad?: string;
    context?: string;
  }): Promise<{ plaintext: string }>;
}

/**
 * A cipher, or a function returning one: `config/diagnostics.ts` is read before
 * `@adonis-agora/crypto` is ready, so `() => crypto.client!` defers it to the first message.
 */
export type RelayCipherSource = RelayCipher | (() => RelayCipher | Promise<RelayCipher>);

/** The `@adonis-agora/crypto` key relay messages are authenticated with, unless another is named. */
export const RELAY_CRYPTO_KEY = 'console-diagnostics';

/** The `crypto` mode: a cipher (`@adonis-agora/crypto`, or any KMS with the same two calls). */
export interface RelayCryptoOptions {
  /** `encrypt` / `decrypt` of `@adonis-agora/crypto`, or of your own KMS / HSM / Vault transit wrapper. */
  cipher: RelayCipherSource;
  /** The key name. Default `console-diagnostics`. */
  key?: string | undefined;
  /**
   * Whether `ciphertext` is one of this key's. Default: it starts with `agora:ct1:<key>:` (the
   * `@adonis-agora/crypto` format). Override it for a cipher with another ciphertext format.
   */
  owns?: ((ciphertext: string) => boolean) | undefined;
}

/** How the relay authenticates its messages. Exactly one of `appKey`, `secret`, `crypto`, `insecure`. */
export interface RelayAuthOptions {
  /**
   * The app's `APP_KEY` (at least 16 characters): a key derived from it encrypts and authenticates
   * every message. The AdonisJS transports use it by themselves when nothing else is set; pass it
   * to the bare relays (`createDiagnosticsRedisRelay`) to do the same outside AdonisJS.
   */
  appKey?: RelaySecret | undefined;
  /** Shared secret (at least 16 characters), the same in every relaying process. */
  secret?: RelaySecret | undefined;
  /**
   * Authenticate with an `@adonis-agora/crypto` key (or your own KMS) every relaying process may
   * encrypt and decrypt with: for relays between apps that don't share an `APP_KEY`. Never picked
   * by itself. `false` turns the automatic `APP_KEY` mode off (then `secret`, `crypto` or `insecure`
   * is required).
   */
  crypto?: RelayCryptoOptions | false | undefined;
  /**
   * Relay without authentication: anyone who can publish on the Redis channel can inject events.
   * Only for local development on a private Redis. Warns at boot.
   */
  insecure?: boolean | undefined;
}

/** How far a message's timestamp may be from this clock (and so how long a replay could live). */
export const MAX_RELAY_SKEW_MS = 60_000;
/** How long a crypto-mode session key is used before the sender seals a new one. */
const SESSION_KEY_TTL_MS = 60 * 60_000;
/** Session keys older than this are refused (bounds how long a revoked peer's key keeps working). */
const SESSION_KEY_MAX_AGE_MS = 2 * SESSION_KEY_TTL_MS + MAX_RELAY_SKEW_MS;

/** How a codec judges a message's age and repeats. */
export interface RelayPolicy {
  /** How old a message may be. Default {@link MAX_RELAY_SKEW_MS}. A message ahead of this clock by more than the skew is always refused. */
  maxAgeMs?: number;
  /**
   * Refuse a message id already seen (default `true`). A queue job is retried with the same
   * message, so the queue transport turns this off and applies its own rule.
   */
  replayGuard?: boolean;
}
/** Opened session keys kept per relay. */
const SESSION_KEY_CACHE = 128;
/** Unknown session keys a relay will try to open per minute (each is a call to the crypto server). */
const OPEN_BUDGET_PER_MINUTE = 30;
/** Message ids remembered for replay detection, at most. */
const MAX_SEEN_IDS = 100_000;

/** One relayed event, as the receiving side gets it after authentication. */
export interface RelayFrame {
  node: string;
  env: unknown;
  /** The message id (authenticated modes only). */
  id?: string;
  /** When the message was made (authenticated modes only). */
  ts?: number;
}

/** Why a relay message was dropped. */
export type RelayRejection =
  | 'unauthenticated'
  | 'stale'
  | 'replayed'
  | 'malformed'
  | 'crypto-unavailable';

/** Encodes and decodes relay messages for one Redis channel (or one kind of queue job). */
export interface RelayCodec {
  readonly mode: 'appKey' | 'secret' | 'crypto' | 'insecure';
  /** Encode a turn's events, synchronously when it can. Unserializable events are left out. */
  encode(node: string, envs: readonly object[]): string[] | Promise<string[]>;
  /** Authenticate and decode one message: `null` drops it (and reports why). */
  decode(raw: string): RelayFrame | null | Promise<RelayFrame | null>;
}

const isThenable = <T>(value: unknown): value is PromiseLike<T> =>
  value !== null &&
  (typeof value === 'object' || typeof value === 'function') &&
  typeof (value as { then?: unknown }).then === 'function';

function sameMac(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

const mac = (key: Buffer, label: string, body: string): string =>
  createHmac('sha256', key).update(`${label}\n${body}`).digest('base64url');

/** Refuses message ids already seen within the freshness window. */
class ReplayGuard {
  readonly #seen = new Map<string, number>();

  /** `true` the first time `id` is seen (and remembers it until its window passes). */
  accept(id: string, now: number): boolean {
    // Entries are inserted in arrival order, so the expired ones sit at the front.
    for (const [seenId, expires] of this.#seen) {
      if (expires > now && this.#seen.size < MAX_SEEN_IDS) break;
      this.#seen.delete(seenId);
    }
    if (this.#seen.has(id)) return false;
    this.#seen.set(id, now + 2 * MAX_RELAY_SKEW_MS);
    return true;
  }
}

interface Body {
  node: string;
  id: string;
  ts: number;
  env: unknown;
}

/** Serialize one event's body, or `null` when it cannot be (a circular payload). */
function body(node: string, env: object): string | null {
  try {
    return JSON.stringify({ node, id: randomUUID(), ts: Date.now(), env });
  } catch {
    return null;
  }
}

/** Split `raw` into `parts` newline-separated fields; the last one takes the rest. */
function fields(raw: string, parts: number): string[] | null {
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < parts - 1; i++) {
    const at = raw.indexOf('\n', from);
    if (at === -1) return null;
    out.push(raw.slice(from, at));
    from = at + 1;
  }
  out.push(raw.slice(from));
  return out;
}

type Reject = (reason: RelayRejection) => null;

/** Parse an authenticated body and check its freshness and id. */
function openBody(
  text: string,
  guard: ReplayGuard | null,
  maxAgeMs: number,
  reject: Reject,
): Body | null {
  let parsed: Partial<Body>;
  try {
    parsed = JSON.parse(text) as Partial<Body>;
  } catch {
    return reject('malformed');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof parsed.node !== 'string' ||
    typeof parsed.id !== 'string' ||
    typeof parsed.ts !== 'number'
  ) {
    return reject('malformed');
  }
  const now = Date.now();
  if (now - parsed.ts > maxAgeMs || parsed.ts - now > MAX_RELAY_SKEW_MS) return reject('stale');
  if (guard && !guard.accept(parsed.id, now)) return reject('replayed');
  return parsed as Body;
}

function releaseSecret(secret: RelaySecret, name = 'secret'): string {
  const raw = typeof secret === 'string' ? secret : secret?.release?.();
  if (typeof raw !== 'string' || raw.length < 16) {
    throw new TypeError(
      name === 'secret'
        ? "[@adonis-agora/diagnostics] the relay `secret` must be at least 16 characters (generate one with `node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"`)"
        : '[@adonis-agora/diagnostics] the relay needs an APP_KEY of at least 16 characters (`node ace generate:key`)',
    );
  }
  return raw;
}

/** The purpose the relay key is derived from `APP_KEY` under. */
export const APP_KEY_RELAY_PURPOSE = 'agora:diagnostics:relay';

/** The AES-256-GCM key the relays derive from `APP_KEY`. */
export function deriveRelayKey(appKey: RelaySecret): Buffer {
  return Buffer.from(
    hkdfSync('sha256', releaseSecret(appKey, 'appKey'), '', APP_KEY_RELAY_PURPOSE, 32),
  );
}

/** `APP_KEY` mode: `k1\n<iv | tag | AES-256-GCM(body)>`, the AAD bound to the channel. */
function appKeyCodec(
  appKey: RelaySecret,
  redisChannel: string,
  policy: ResolvedPolicy,
  reject: Reject,
): RelayCodec {
  const key = deriveRelayKey(appKey);
  const aad = Buffer.from(JSON.stringify(['agora:diagnostics-relay', 'k1', redisChannel]));
  const guard = policy.replayGuard ? new ReplayGuard() : null;
  return {
    mode: 'appKey',
    encode(node, envs) {
      const out: string[] = [];
      for (const env of envs) {
        const text = body(node, env);
        if (text === null) continue;
        const iv = randomBytes(12);
        const gcm = createCipheriv('aes-256-gcm', key, iv);
        gcm.setAAD(aad);
        const sealed = Buffer.concat([gcm.update(text, 'utf8'), gcm.final()]);
        out.push(`k1\n${Buffer.concat([iv, gcm.getAuthTag(), sealed]).toString('base64url')}`);
      }
      return out;
    },
    decode(raw) {
      const parts = fields(raw, 2);
      if (parts?.[0] !== 'k1') return reject('unauthenticated');
      let text: string;
      try {
        const wire = Buffer.from(parts[1] as string, 'base64url');
        if (wire.length < 29) return reject('unauthenticated');
        const gcm = createDecipheriv('aes-256-gcm', key, wire.subarray(0, 12));
        gcm.setAAD(aad);
        gcm.setAuthTag(wire.subarray(12, 28));
        text = Buffer.concat([gcm.update(wire.subarray(28)), gcm.final()]).toString('utf8');
      } catch {
        return reject('unauthenticated');
      }
      const parsed = openBody(text, guard, policy.maxAgeMs, reject);
      return parsed && { node: parsed.node, env: parsed.env, id: parsed.id, ts: parsed.ts };
    },
  };
}

interface ResolvedPolicy {
  maxAgeMs: number;
  replayGuard: boolean;
}

/** Shared-secret mode: `s1\n<mac>\n<body>`. */
function secretCodec(
  secret: RelaySecret,
  redisChannel: string,
  policy: ResolvedPolicy,
  reject: Reject,
): RelayCodec {
  const key = createHmac('sha256', releaseSecret(secret))
    .update(`agora:diagnostics-relay:${redisChannel}`)
    .digest();
  const guard = policy.replayGuard ? new ReplayGuard() : null;
  return {
    mode: 'secret',
    encode(node, envs) {
      const out: string[] = [];
      for (const env of envs) {
        const text = body(node, env);
        if (text !== null) out.push(`s1\n${mac(key, 's1', text)}\n${text}`);
      }
      return out;
    },
    decode(raw) {
      const parts = fields(raw, 3);
      if (parts?.[0] !== 's1') return reject('unauthenticated');
      const [, tag, text] = parts as [string, string, string];
      if (!sameMac(mac(key, 's1', text), tag)) return reject('unauthenticated');
      const parsed = openBody(text, guard, policy.maxAgeMs, reject);
      return parsed && { node: parsed.node, env: parsed.env, id: parsed.id, ts: parsed.ts };
    },
  };
}

interface SessionKey {
  sealed: string;
  key: Buffer;
  node: string;
  iat: number;
}

/**
 * Crypto mode: `c1\n<sealed session key>\n<iv | tag | AES-256-GCM(body)>`. The session key is sealed
 * with the crypto key (AAD bound to the Redis channel) together with the sender's node id and issue
 * time; each body is encrypted with it, its AAD bound to the channel and the sealed session key.
 */
function cryptoCodec(
  options: RelayCryptoOptions,
  redisChannel: string,
  policy: ResolvedPolicy,
  reject: Reject,
  onError: (error: unknown) => void,
): RelayCodec {
  // A session key must outlive the oldest message it may still have to open.
  const sessionMaxAge = Math.max(
    SESSION_KEY_MAX_AGE_MS,
    SESSION_KEY_TTL_MS + policy.maxAgeMs + MAX_RELAY_SKEW_MS,
  );
  const cryptoKey = options.key ?? RELAY_CRYPTO_KEY;
  if (typeof cryptoKey !== 'string' || cryptoKey.length === 0) {
    throw new TypeError('[@adonis-agora/diagnostics] the relay `crypto.key` must be a name');
  }
  const source = options.cipher;
  if (source === undefined || source === null) {
    throw new TypeError('[@adonis-agora/diagnostics] the relay `crypto.cipher` is required');
  }
  const aad = JSON.stringify(['agora:diagnostics-relay', redisChannel]);
  const prefix = `agora:ct1:${cryptoKey}:`;
  if (options.owns !== undefined && typeof options.owns !== 'function') {
    throw new TypeError('[@adonis-agora/diagnostics] the relay `crypto.owns` must be a function');
  }
  const owns = (ciphertext: string): boolean => {
    if (!options.owns) return ciphertext.startsWith(prefix);
    try {
      return options.owns(ciphertext) === true;
    } catch {
      return false;
    }
  };
  const cipher = async (): Promise<RelayCipher> => {
    const resolved = typeof source === 'function' ? await source() : source;
    if (
      !resolved ||
      typeof resolved.encrypt !== 'function' ||
      typeof resolved.decrypt !== 'function'
    ) {
      throw new Error(
        '[@adonis-agora/diagnostics] the relay `crypto.cipher` is not ready (is @adonis-agora/crypto booted?)',
      );
    }
    return resolved;
  };

  // Sending side: this process's current session key.
  let current: SessionKey | null = null;
  let sealing: Promise<SessionKey> | null = null;
  const seal = (node: string): SessionKey | Promise<SessionKey> => {
    if (current && current.node === node && Date.now() - current.iat < SESSION_KEY_TTL_MS) {
      return current;
    }
    if (sealing) return sealing;
    const key = randomBytes(32);
    const iat = Date.now();
    const promise = cipher()
      .then((c) =>
        c.encrypt({
          key: cryptoKey,
          plaintext: JSON.stringify({ v: 1, k: key.toString('base64url'), node, iat }),
          aad,
          context: aad,
        }),
      )
      .then(({ ciphertext }) => {
        if (typeof ciphertext !== 'string' || ciphertext.includes('\n') || !owns(ciphertext)) {
          throw new Error(
            `[@adonis-agora/diagnostics] the crypto cipher did not return a "${cryptoKey}" ciphertext`,
          );
        }
        current = { sealed: ciphertext, key, node, iat };
        // This process hears its own messages back: it knows the key without asking crypto.
        remember(current);
        return current;
      })
      .finally(() => {
        sealing = null;
      });
    sealing = promise;
    return promise;
  };

  const frameAad = (sealed: string) => Buffer.from(`${aad}\n${sealed}`);
  const frame = (session: SessionKey, envs: readonly object[]): string[] => {
    const out: string[] = [];
    for (const env of envs) {
      const text = body(session.node, env);
      if (text === null) continue;
      const iv = randomBytes(12);
      const gcm = createCipheriv('aes-256-gcm', session.key, iv);
      gcm.setAAD(frameAad(session.sealed));
      const sealedBody = Buffer.concat([gcm.update(text, 'utf8'), gcm.final()]);
      const wire = Buffer.concat([iv, gcm.getAuthTag(), sealedBody]).toString('base64url');
      out.push(`c1\n${session.sealed}\n${wire}`);
    }
    return out;
  };

  // Receiving side: session keys already opened, and the budget for opening unknown ones.
  const opened = new Map<string, SessionKey>();
  function remember(session: SessionKey): void {
    if (opened.size >= SESSION_KEY_CACHE) {
      const oldest = opened.keys().next().value;
      if (oldest !== undefined) opened.delete(oldest);
    }
    opened.set(session.sealed, session);
  }
  const opening = new Map<string, Promise<SessionKey | null>>();
  let budget = OPEN_BUDGET_PER_MINUTE;
  let budgetResetAt = 0;
  const guard = policy.replayGuard ? new ReplayGuard() : null;

  const open = (sealed: string): SessionKey | null | Promise<SessionKey | null> => {
    const known = opened.get(sealed);
    if (known) {
      if (Date.now() - known.iat > sessionMaxAge) {
        opened.delete(sealed);
        return null;
      }
      return known;
    }
    const pending = opening.get(sealed);
    if (pending) return pending;
    const now = Date.now();
    if (now >= budgetResetAt) {
      budget = OPEN_BUDGET_PER_MINUTE;
      budgetResetAt = now + 60_000;
    }
    if (budget <= 0) return null;
    budget -= 1;
    const promise = cipher()
      .then((c) => c.decrypt({ key: cryptoKey, ciphertext: sealed, aad, context: aad }))
      .then(({ plaintext }): SessionKey | null => {
        const parsed = JSON.parse(plaintext) as {
          v?: unknown;
          k?: unknown;
          node?: unknown;
          iat?: unknown;
        };
        if (
          parsed?.v !== 1 ||
          typeof parsed.k !== 'string' ||
          typeof parsed.node !== 'string' ||
          typeof parsed.iat !== 'number'
        ) {
          return null;
        }
        const key = Buffer.from(parsed.k, 'base64url');
        if (key.length !== 32) return null;
        const session = { sealed, key, node: parsed.node, iat: parsed.iat };
        remember(session);
        return session;
      })
      .catch((error: unknown) => {
        // A key that does not open (forged, or another key's ciphertext) is just refused; a crypto
        // server that is down is reported too.
        onError(error);
        return null;
      })
      .finally(() => {
        opening.delete(sealed);
      });
    opening.set(sealed, promise);
    return promise;
  };

  const check = (session: SessionKey | null, wire: string): RelayFrame | null => {
    if (!session) return reject('unauthenticated');
    if (Date.now() - session.iat > sessionMaxAge) return reject('stale');
    let text: string;
    try {
      const raw = Buffer.from(wire, 'base64url');
      if (raw.length < 29) return reject('unauthenticated');
      const gcm = createDecipheriv('aes-256-gcm', session.key, raw.subarray(0, 12));
      gcm.setAAD(frameAad(session.sealed));
      gcm.setAuthTag(raw.subarray(12, 28));
      text = Buffer.concat([gcm.update(raw.subarray(28)), gcm.final()]).toString('utf8');
    } catch {
      return reject('unauthenticated');
    }
    const parsed = openBody(text, guard, policy.maxAgeMs, reject);
    if (!parsed) return null;
    // A session key speaks only for the node that sealed it.
    if (parsed.node !== session.node) return reject('unauthenticated');
    return { node: parsed.node, env: parsed.env, id: parsed.id, ts: parsed.ts };
  };

  return {
    mode: 'crypto',
    encode(node, envs) {
      const session = seal(node);
      if (isThenable<SessionKey>(session)) {
        return session.then(
          (s) => frame(s, envs),
          (error: unknown) => {
            onError(error);
            return [];
          },
        );
      }
      return frame(session, envs);
    },
    decode(raw) {
      const parts = fields(raw, 3);
      if (parts?.[0] !== 'c1') return reject('unauthenticated');
      const [, sealed, wire] = parts as [string, string, string];
      if (!owns(sealed)) return reject('unauthenticated');
      const session = open(sealed);
      if (isThenable<SessionKey | null>(session)) {
        return Promise.resolve(session).then((s) => check(s, wire));
      }
      return check(session, wire);
    },
  };
}

/** The wire of earlier versions: `{ node, env }`, unauthenticated. */
function insecureCodec(reject: Reject): RelayCodec {
  return {
    mode: 'insecure',
    encode(node, envs) {
      const out: string[] = [];
      for (const env of envs) {
        try {
          out.push(JSON.stringify({ node, env }));
        } catch {
          // an unserializable event is dropped without affecting the rest of the batch
        }
      }
      return out;
    },
    decode(raw) {
      let parsed: { node?: unknown; env?: unknown };
      try {
        parsed = JSON.parse(raw) as { node?: unknown; env?: unknown };
      } catch {
        return reject('malformed');
      }
      if (parsed === null || typeof parsed !== 'object') return reject('malformed');
      return { node: typeof parsed.node === 'string' ? parsed.node : '', env: parsed.env };
    },
  };
}

/**
 * The error a relay without authentication fails with: the zero-configuration path first, then the
 * explicit ones. `what` names the relay (`the Redis relay`, `the queue transport`).
 */
export function missingRelayAuth(what = 'the Redis relay', automaticOff = false): string {
  return `[@adonis-agora/diagnostics] ${what} needs authentication. ${
    automaticOff
      ? "The automatic APP_KEY mode is off (`crypto: false`): remove it to authenticate with the app's APP_KEY (nothing else to configure for the processes of one app)"
      : 'Set APP_KEY in this app (automatic for the processes of one app: nothing else to configure; `node ace generate:key`)'
  }, or set \`secret\` (a shared secret, at least 16 characters, the same in every process: transports.redis/queue({ secret: env.get('DIAGNOSTICS_RELAY_SECRET') })), or \`crypto: { cipher }\` (@adonis-agora/crypto or your own KMS, for relays across apps). For local development only, \`insecure: true\` relays without authentication.`;
}

export const MISSING_RELAY_AUTH = missingRelayAuth();

/** Which mode `options` select (`'none'` when none is set). */
export function relayAuthMode(
  options: RelayAuthOptions,
): 'appKey' | 'secret' | 'crypto' | 'insecure' | 'none' {
  if (options.appKey !== undefined) return 'appKey';
  if (options.secret !== undefined) return 'secret';
  if (options.crypto !== undefined && options.crypto !== false) return 'crypto';
  if (options.insecure === true) return 'insecure';
  return 'none';
}

/** The codec for `options`; throws when no (or more than one) mode is configured. */
export function createRelayCodec(
  options: RelayAuthOptions,
  redisChannel: string,
  hooks: { onReject: (reason: RelayRejection) => void; onError: (error: unknown) => void },
  policy: RelayPolicy & { what?: string } = {},
): RelayCodec {
  const modes = [
    options.appKey !== undefined,
    options.secret !== undefined,
    options.crypto !== undefined && options.crypto !== false,
    options.insecure === true,
  ].filter(Boolean).length;
  const what = policy.what ?? 'the Redis relay';
  if (modes === 0) throw new TypeError(missingRelayAuth(what, options.crypto === false));
  if (modes > 1) {
    throw new TypeError(
      `[@adonis-agora/diagnostics] ${what} takes one of \`appKey\`, \`secret\`, \`crypto\` or \`insecure\`, not several`,
    );
  }
  const maxAgeMs = policy.maxAgeMs ?? MAX_RELAY_SKEW_MS;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new TypeError(
      `[@adonis-agora/diagnostics] the maximum message age must be a positive number of milliseconds (got ${String(maxAgeMs)})`,
    );
  }
  const resolved: ResolvedPolicy = { maxAgeMs, replayGuard: policy.replayGuard ?? true };
  const reject: Reject = (reason) => {
    hooks.onReject(reason);
    return null;
  };
  if (options.appKey !== undefined) {
    return appKeyCodec(options.appKey, redisChannel, resolved, reject);
  }
  if (options.secret !== undefined) {
    return secretCodec(options.secret, redisChannel, resolved, reject);
  }
  if (options.crypto !== undefined && options.crypto !== false) {
    return cryptoCodec(options.crypto, redisChannel, resolved, reject, hooks.onError);
  }
  return insecureCodec(reject);
}

export { isThenable };
