import { randomUUID } from 'node:crypto';
import { getChannel } from '../channel.js';
import { type ChannelRef, createChannelSelector, createTurnBatcher } from '../relay.js';
import { isRelayed, publishRelayed } from '../relayed.js';
import { createRemoteChannelGate, DEFAULT_MAX_REMOTE_CHANNELS } from '../remote_channels.js';
import type { DiagnosticEvent } from '../types.js';
import {
  createRelayCodec,
  isThenable,
  type RelayAuthOptions,
  type RelayRejection,
} from './relay_auth.js';

export type {
  RelayAuthOptions,
  RelayCipher,
  RelayCipherSource,
  RelayCryptoOptions,
  RelaySecret,
} from './relay_auth.js';
export { RELAY_CRYPTO_KEY } from './relay_auth.js';
export type { ChannelRef };

/** The minimal Redis pub/sub surface the relay uses. An ioredis instance satisfies it structurally. */
export interface RedisLike {
  publish(channel: string, message: string): unknown;
  /** When present, a turn's forwarded events go out as one pipeline instead of one round trip each. */
  pipeline?(): RedisPipelineLike;
  /**
   * One channel, no callback: ioredis 6 types `subscribe` as variadic channels followed by a
   * required callback (or none), which a single optional-callback signature does not match.
   */
  subscribe(channel: string): unknown;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  removeListener(event: 'message', listener: (channel: string, message: string) => void): unknown;
  unsubscribe(channel: string): unknown;
}

/** The slice of an ioredis pipeline the relay uses to batch publishes. */
export interface RedisPipelineLike {
  publish(channel: string, message: string): unknown;
  exec(): unknown;
}

interface RedisRelayBaseOptions extends RelayAuthOptions {
  /** Publisher connection. */
  pub: RedisLike;
  /** Forward every event of these libs (current + future channels). */
  libs?: string[];
  /** Forward these exact channels, in addition to `libs`. */
  channels?: ChannelRef[];
  /** Forward EVERY agora channel (current + future). Overrides `libs`/`channels`. Default false. */
  all?: boolean;
  /** Redis channel to relay on. Default 'agora:diagnostics:relay'. */
  redisChannel?: string;
  /** Unique id for THIS process, for echo suppression. Default a random id. */
  nodeId?: string;
  /**
   * How many channels events received from other processes may create here, on top of the ones
   * this process registered itself. Past it, events on unknown channels are dropped. Default 256.
   */
  maxRemoteChannels?: number;
  /**
   * Called (once per reason) when a received message is dropped: unauthenticated, stale, replayed,
   * malformed, an invalid channel name, or the remote channel cap reached; and when the crypto
   * cipher fails. Default: a process warning.
   */
  onError?: (error: Error) => void;
}

/**
 * Options of {@link createDiagnosticsRedisRelay}. A relay that receives (the default) needs a `sub`
 * connection; a publish-only relay (`receive: false`, a `role: 'api'` process) does not.
 */
export type DiagnosticsRedisRelayOptions = RedisRelayBaseOptions &
  (
    | {
        /** Subscriber connection (separate from `pub`). For ioredis: `const sub = pub.duplicate()`. */
        sub: RedisLike;
        /** Subscribe and re-emit events from other processes. Default `true`. */
        receive?: true;
      }
    | {
        /** Ignored: a publish-only relay never subscribes. */
        sub?: RedisLike;
        /** Publish only: never subscribe, never re-emit events from other processes. */
        receive: false;
      }
  );

const DEFAULT_REDIS_CHANNEL = 'agora:diagnostics:relay';

/** The code of the errors {@link DiagnosticsRedisRelayOptions.onError} receives for dropped messages. */
export const RELAY_REJECTED = 'AGORA_DIAGNOSTICS_RELAY_REJECTED';

let warnedInsecure = false;

function warn(error: Error): void {
  try {
    process.emitWarning(error.message, {
      code: (error as { code?: string }).code ?? 'AGORA_DIAGNOSTICS_RELAY',
    });
  } catch {
    // a throwing warning listener must not break the relay
  }
}

const REJECTION_MESSAGES: Record<
  RelayRejection | 'invalid-channel' | 'channel-cap' | 'overloaded',
  string
> = {
  unauthenticated:
    'dropped a Redis relay message that failed authentication (is every process configured with the same `secret` / `crypto` key?)',
  stale:
    'dropped a Redis relay message older than a minute (or more than a minute ahead: check clocks)',
  replayed: 'dropped a replayed Redis relay message',
  malformed: 'dropped a malformed Redis relay message',
  'crypto-unavailable': 'the Redis relay could not use its crypto key',
  'invalid-channel':
    'dropped a Redis relay event whose lib or event is not a valid name ([A-Za-z0-9_-] lib, [A-Za-z0-9_.:-] event)',
  'channel-cap':
    'the Redis relay reached maxRemoteChannels: events on channels this process does not know are dropped',
  overloaded:
    'the Redis relay dropped messages: too many were waiting for the crypto server to answer',
};

/** Messages that may wait behind a pending crypto call before new ones are dropped. */
const MAX_QUEUED_MESSAGES = 10_000;

/**
 * Run tasks one after another, synchronously while none is pending: a crypto-mode relay waits for
 * its session key once, and the messages behind it keep their order. At most `max` tasks wait; past
 * that a task is dropped (`false`), so a flood while the crypto server is slow cannot grow memory.
 */
function createSerial(max = MAX_QUEUED_MESSAGES): (task: () => unknown) => boolean {
  let tail: Promise<void> | null = null;
  let waiting = 0;
  const swallow = () => {};
  const track = (promise: Promise<void>) => {
    tail = promise;
    void promise.then(() => {
      if (tail === promise) tail = null;
    });
  };
  return (task) => {
    if (tail !== null) {
      if (waiting >= max) return false;
      waiting += 1;
      track(
        tail
          .then(() => {
            waiting -= 1;
            return task();
          })
          .then(swallow, swallow),
      );
      return true;
    }
    let result: unknown;
    try {
      result = task();
    } catch {
      return true;
    }
    if (isThenable(result)) track(Promise.resolve(result).then(swallow, swallow));
    return true;
  };
}

/**
 * Swallow the rejection of a fire-and-forget Redis command. ioredis returns a promise from every
 * command, and one still pending when its connection closes rejects with `Connection is closed.`;
 * left uncaught, that rejection crashes a short-lived process (an `ace` command) on exit.
 */
export function settle(result: unknown): void {
  if (
    result !== null &&
    (typeof result === 'object' || typeof result === 'function') &&
    typeof (result as { then?: unknown }).then === 'function'
  ) {
    (result as PromiseLike<unknown>).then(undefined, () => {});
  }
}

/**
 * Relay diagnostics events across processes over Redis pub/sub. Forwards selected local
 * `agora:<lib>:<event>` channels to Redis and re-emits Redis-received events onto the local bus, so
 * `onDiagnostic` handlers / `getChannel(...).subscribe(...)` fire cross-process. Loop-safe via nodeId
 * echo suppression and a re-emit guard. Never throws into `emit()` or the Redis handler. Does NOT
 * close the `pub`/`sub` connections — the caller owns them.
 *
 * Forwarding happens off the emitter's call stack: selected events are queued and, once per event
 * loop turn, serialized and published in emit order (one Redis message per event, sent as a single
 * pipeline when `pub` supports it).
 *
 * Every message is authenticated (see {@link RelayAuthOptions}): with a shared `secret`, with an
 * `@adonis-agora/crypto` key (`crypto`), or not at all with an explicit `insecure: true`. Without
 * one of them this throws. A received message that fails authentication, is over a minute old or
 * was already seen is dropped. A received event re-emits only on a valid `lib`/`event` name, and
 * on a channel this process already knows or one of at most `maxRemoteChannels` new ones.
 *
 * Usually you don't call this directly: `config/diagnostics.ts` selects it via
 * `transports.redis({ ... })` and the provider starts it for you.
 *
 * @returns a teardown that publishes any queued events, then removes all local subscriptions and
 *   the Redis message handler.
 */
export function createDiagnosticsRedisRelay(options: DiagnosticsRedisRelayOptions): () => void {
  const { pub } = options;
  const sub = options.receive === false ? undefined : options.sub;
  if (options.receive !== false && !sub) {
    throw new TypeError('createDiagnosticsRedisRelay: `sub` is required unless `receive` is false');
  }
  const redisChannel = options.redisChannel ?? DEFAULT_REDIS_CHANNEL;
  const nodeId = options.nodeId ?? randomUUID();

  const reported = new Set<string>();
  const report = (reason: keyof typeof REJECTION_MESSAGES, cause?: unknown): void => {
    if (reported.has(reason)) return;
    reported.add(reason);
    const error = Object.assign(
      new Error(`[@adonis-agora/diagnostics] ${REJECTION_MESSAGES[reason]}`, { cause }),
      { code: RELAY_REJECTED, reason },
    );
    try {
      (options.onError ?? warn)(error);
    } catch {
      // a throwing hook must not break the relay
    }
  };
  const codec = createRelayCodec(options, redisChannel, {
    onReject: (reason) => report(reason),
    onError: (cause) => report('crypto-unavailable', cause),
  });
  if (codec.mode === 'insecure' && !warnedInsecure) {
    warnedInsecure = true;
    warn(
      Object.assign(
        new Error(
          '[@adonis-agora/diagnostics] the Redis relay runs with `insecure: true`: anyone who can publish on its Redis channel can inject diagnostics events. Set `secret` or `crypto` outside local development.',
        ),
        { code: 'AGORA_DIAGNOSTICS_INSECURE_RELAY' },
      ),
    );
  }
  const gate = createRemoteChannelGate(options.maxRemoteChannels ?? DEFAULT_MAX_REMOTE_CHANNELS);

  const reEmitting = new WeakSet<object>();

  const publishOne = (message: string): void => {
    try {
      settle(pub.publish(redisChannel, message));
    } catch {
      // a failing publish drops only its own event
    }
  };

  const send = (messages: string[]): void => {
    if (messages.length > 1 && typeof pub.pipeline === 'function') {
      try {
        const pipeline = pub.pipeline();
        for (const message of messages) pipeline.publish(redisChannel, message);
        settle(pipeline.exec());
      } catch {
        // never throw out of the drain
      }
      return;
    }
    for (const message of messages) publishOne(message);
  };

  const outgoing = createSerial();
  const batcher = createTurnBatcher<object>((envs) => {
    outgoing(() => {
      // An unserializable event is dropped by the codec without affecting the rest of the batch.
      const encoded = codec.encode(nodeId, envs);
      if (isThenable<string[]>(encoded)) return Promise.resolve(encoded).then(send);
      send(encoded);
      return undefined;
    });
  });

  const forward = (msg: unknown): void => {
    if (typeof msg !== 'object' || msg === null) return;
    // A re-emitted remote event (by this relay or any other in this process): never send it on.
    if (reEmitting.has(msg) || isRelayed(msg)) return;
    batcher.push(msg);
  };

  const selector = createChannelSelector(options, forward);

  let stopped = false;
  const reEmit = (frame: { node: string; env: unknown } | null): void => {
    if (stopped || !frame || frame.node === nodeId) return; // torn down, dropped, or our own echo
    const env = frame.env as DiagnosticEvent;
    if (env === null || typeof env !== 'object' || Array.isArray(env)) return;
    const verdict = gate.admit(env.lib, env.event);
    if (verdict !== 'ok') {
      report(verdict === 'full' ? 'channel-cap' : 'invalid-channel');
      return;
    }
    reEmitting.add(env);
    try {
      publishRelayed(env, () => getChannel(env.lib, env.event).publish(env));
    } catch {
      // a local subscriber threw — never propagate into the message handler
    } finally {
      reEmitting.delete(env);
    }
  };

  const incoming = createSerial();
  const onMessage = (channel: string, raw: string): void => {
    if (channel !== redisChannel || typeof raw !== 'string') return;
    const queued = incoming(() => {
      const frame = codec.decode(raw);
      if (isThenable<{ node: string; env: unknown } | null>(frame)) {
        return Promise.resolve(frame).then(reEmit);
      }
      reEmit(frame);
      return undefined;
    });
    if (!queued) report('overloaded');
  };

  if (sub) {
    sub.on('message', onMessage);
    try {
      settle(sub.subscribe(redisChannel));
    } catch {
      // a subscriber that throws synchronously only stops receiving; forwarding still works
    }
  }

  return () => {
    batcher.flush();
    selector.stop();
    stopped = true;
    if (!sub) return;
    sub.removeListener('message', onMessage);
    try {
      settle(sub.unsubscribe(redisChannel));
    } catch {
      // never throw out of a teardown
    }
  };
}
