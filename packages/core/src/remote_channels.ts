import { channelName } from './channel.js';
import { isChannelRegistered } from './registry.js';

/**
 * The syntax a relayed event's `lib` must match. Every Agora lib name fits (`resilience`, `authz`,
 * `durable`); anything else arriving from another process is dropped before it touches the bus.
 */
export const LIB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The syntax a relayed event's `event` must match: a name like `circuit-opened`, `run.failed` or
 * `cache:hit`, at most 128 characters.
 */
export const EVENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** How many channels a relay may create that this process never registered itself. */
export const DEFAULT_MAX_REMOTE_CHANNELS = 256;

/** Whether `lib`/`event` are names a relay may re-emit on. */
export function isValidRemoteChannel(lib: unknown, event: unknown): boolean {
  return (
    typeof lib === 'string' &&
    typeof event === 'string' &&
    LIB_NAME_PATTERN.test(lib) &&
    EVENT_NAME_PATTERN.test(event)
  );
}

/**
 * Decides which `(lib, event)` pairs received from another process may be re-emitted here.
 *
 * Re-emitting touches `getChannel`, which permanently registers the channel: the channel cache, the
 * registry, and every observer that subscribes to each new channel (the recent-events buffer, the
 * relays, the OTel bridge) grow with it, and none of that is ever released. So a pair already known
 * in this process is always admitted, and a new one only while fewer than `max` have been admitted
 * by this gate. Past the cap, unknown pairs are dropped: remote input can never grow memory without
 * bound. (An evicting LRU would not help: a registered channel and its subscriptions stay.)
 */
export interface RemoteChannelGate {
  /**
   * Whether an event on `(lib, event)` may be re-emitted: `'ok'`, `'invalid'` (not a valid name) or
   * `'full'` (a new channel past the cap).
   */
  admit(lib: unknown, event: unknown): 'ok' | 'invalid' | 'full';
  /** How many new channels this gate has admitted. */
  readonly admitted: number;
}

export function createRemoteChannelGate(
  max: number = DEFAULT_MAX_REMOTE_CHANNELS,
): RemoteChannelGate {
  if (!Number.isInteger(max) || max < 0) {
    throw new TypeError(
      `[@adonis-agora/diagnostics] maxRemoteChannels must be a non-negative integer (got ${String(max)})`,
    );
  }
  const admitted = new Set<string>();
  return {
    admit(lib, event) {
      if (!isValidRemoteChannel(lib, event)) return 'invalid';
      const name = channelName(lib as string, event as string);
      if (admitted.has(name) || isChannelRegistered(name)) return 'ok';
      if (admitted.size >= max) return 'full';
      admitted.add(name);
      return 'ok';
    },
    get admitted() {
      return admitted.size;
    },
  };
}
