import { CHANNEL_PREFIX, channelName, getChannel } from './channel.js';
import { onChannelRegistered, registeredChannels } from './registry.js';

/** A parsed `agora:<lib>:<event>` channel reference. */
export interface ChannelRef {
  lib: string;
  event: string;
}

/**
 * Parse an `agora:<lib>:<event>` channel name into its lib/event parts, or `null` when it doesn't
 * match the convention. Splits on the FIRST colon after the prefix — the event segment may itself
 * contain `:` or `.` (e.g. `durable:run.failed`), so everything past the lib boundary is the event.
 *
 * The single source of truth for this convention: the Redis relay, the queue relay and the OTel
 * bridge all parse channel names through here so the lib/event boundary never drifts between them.
 */
export function parseChannelName(name: string): ChannelRef | null {
  const prefix = `${CHANNEL_PREFIX}:`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const idx = rest.indexOf(':');
  if (idx <= 0 || idx === rest.length - 1) return null;
  return { lib: rest.slice(0, idx), event: rest.slice(idx + 1) };
}

/** Which local channels a relay forwards. */
export interface ChannelSelection {
  /** Forward every event of these libs (current + future channels). */
  libs?: string[];
  /** Forward these exact channels, in addition to `libs`. */
  channels?: ChannelRef[];
  /** Forward EVERY agora channel (current + future). Overrides `libs`/`channels`. Default false. */
  all?: boolean;
}

/** A running channel selector. Call {@link ChannelSelector.stop} to unsubscribe everything. */
export interface ChannelSelector {
  stop(): void;
}

/**
 * Subscribe `forward` to every local diagnostics channel matched by `selection`: the exact
 * `channels`, every channel of the wildcard `libs`, or (with `all`) every agora channel — including
 * channels registered in the FUTURE, via {@link onChannelRegistered}. A channel is subscribed at
 * most once. Returns a handle whose {@link ChannelSelector.stop} removes every subscription and the
 * future-registration listener.
 *
 * This is the shared forward-side engine for the Redis and queue relays: they differ ONLY in what
 * `forward` does with each event (publish to Redis vs dispatch a job).
 */
export function createChannelSelector(
  selection: ChannelSelection,
  forward: (msg: unknown) => void,
): ChannelSelector {
  const forwardAll = selection.all === true;
  const libs = selection.libs ?? [];
  const exact = selection.channels ?? [];

  const subscriptions: ChannelRef[] = [];
  const subscribed = new Set<string>();

  const subscribeRef = (ref: ChannelRef): void => {
    const name = channelName(ref.lib, ref.event);
    if (subscribed.has(name)) return;
    getChannel(ref.lib, ref.event).subscribe(forward);
    subscribed.add(name);
    subscriptions.push(ref);
  };

  const wildcardMatches = (name: string): boolean => {
    if (forwardAll) return name.startsWith(`${CHANNEL_PREFIX}:`);
    return libs.some((lib) => name.startsWith(`${CHANNEL_PREFIX}:${lib}:`));
  };

  const subscribeIfMatch = (name: string): void => {
    if (!wildcardMatches(name)) return;
    const ref = parseChannelName(name);
    if (ref) subscribeRef(ref);
  };

  for (const ref of exact) subscribeRef(ref);

  const hasWildcard = forwardAll || libs.length > 0;
  if (hasWildcard) {
    for (const name of registeredChannels()) subscribeIfMatch(name);
  }
  const offRegistered = hasWildcard ? onChannelRegistered(subscribeIfMatch) : null;

  return {
    stop: () => {
      for (const ref of subscriptions) getChannel(ref.lib, ref.event).unsubscribe(forward);
      subscriptions.length = 0;
      subscribed.clear();
      offRegistered?.();
    },
  };
}

/** A queue drained once per event loop turn. See {@link createTurnBatcher}. */
export interface TurnBatcher<T> {
  /** Queue an item; the first push of a turn schedules the drain. */
  push(item: T): void;
  /** Drain whatever is queued right now, synchronously. */
  flush(): void;
}

/**
 * Collect items off the caller's stack and hand them to `drain` in arrival order, once per event
 * loop turn (`setImmediate`). Both relays forward through one of these so `emit()` only enqueues;
 * serialization and I/O run after the emitter returns, batched per turn. `drain` runs outside any
 * caller, so it must not throw.
 */
export function createTurnBatcher<T>(drain: (items: T[]) => void): TurnBatcher<T> {
  const pending: T[] = [];
  let scheduled: ReturnType<typeof setImmediate> | null = null;

  const flush = (): void => {
    if (scheduled !== null) {
      clearImmediate(scheduled);
      scheduled = null;
    }
    if (pending.length === 0) return;
    drain(pending.splice(0));
  };

  return {
    push(item) {
      pending.push(item);
      scheduled ??= setImmediate(flush);
    },
    flush,
  };
}
