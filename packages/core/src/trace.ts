import diagnostics_channel, { type Channel } from 'node:diagnostics_channel';
import { capability } from './capability.js';
import { channelName } from './channel.js';
import { resolveTraceId } from './context_accessor.js';
import { onRegistryReset, registerChannel } from './registry.js';
import type { EventOf, LibOf, PayloadOf, SpanEvent, SpanPhase, TraceOptions } from './types.js';

/**
 * Span envelope schema version, stamped onto every {@link SpanEvent} as `v`.
 * Versioned independently of the POINT `SCHEMA_VERSION` so the two wire shapes
 * can evolve apart. Observers should treat an absent `v` as version `1`.
 */
export const SPAN_SCHEMA_VERSION = 1;

/**
 * The five span sub-channel names for a `(lib, event)` pair. They extend the
 * POINT `agora:<lib>:<event>` name with a `:<phase>` suffix, mirroring Node's
 * own `tracingChannel` sub-channels (start/end/asyncStart/asyncEnd/error) while
 * staying inside the `agora:` convention so the same generic observer can read
 * both POINT and SPAN traffic.
 */
export interface TraceChannelNames {
  start: string;
  end: string;
  asyncStart: string;
  asyncEnd: string;
  error: string;
}

/** Build the five span sub-channel names for a `(lib, event)` pair. */
export function traceChannelNames(lib: string, event: string): TraceChannelNames {
  const base = channelName(lib, event);
  return {
    start: `${base}:start`,
    end: `${base}:end`,
    asyncStart: `${base}:asyncStart`,
    asyncEnd: `${base}:asyncEnd`,
    error: `${base}:error`,
  };
}

/** The resolved, memoized {@link Channel}s for one span. */
interface SpanChannels {
  base: string;
  start: Channel;
  end: Channel;
  asyncStart: Channel;
  asyncEnd: Channel;
  error: Channel;
}

/**
 * Per-`(lib, event)` cache of the resolved span {@link Channel}s, keyed by `lib`
 * then `event` — the same two-level memo strategy `getChannel` uses, so the
 * steady state is two `Map.get`s with no string allocation. The first trace of a
 * pair pays the name builds + `diagnostics_channel.channel()` lookups + registry
 * insert; every call after returns the cached object.
 */
const spanCache = new Map<string, Map<string, SpanChannels>>();

// Drop the memo cache whenever the registry is reset (test-only), so the next
// trace re-registers the base channel. Mirrors channel.ts.
onRegistryReset(() => spanCache.clear());

function getSpanChannels(lib: string, event: string): SpanChannels {
  let byEvent = spanCache.get(lib);
  if (byEvent !== undefined) {
    const cached = byEvent.get(event);
    if (cached !== undefined) return cached;
  } else {
    byEvent = new Map<string, SpanChannels>();
    spanCache.set(lib, byEvent);
  }
  const names = traceChannelNames(lib, event);
  const channels: SpanChannels = {
    base: channelName(lib, event),
    start: diagnostics_channel.channel(names.start),
    end: diagnostics_channel.channel(names.end),
    asyncStart: diagnostics_channel.channel(names.asyncStart),
    asyncEnd: diagnostics_channel.channel(names.asyncEnd),
    error: diagnostics_channel.channel(names.error),
  };
  // Register the BASE channel name for discovery: a generic observer that knows
  // the base name can derive all five span sub-channels via traceChannelNames.
  registerChannel(channels.base);
  byEvent.set(event, channels);
  return channels;
}

/** True when ANY of the five span sub-channels currently has a subscriber. */
function anySubscribed(ch: SpanChannels): boolean {
  return (
    ch.start.hasSubscribers ||
    ch.end.hasSubscribers ||
    ch.asyncStart.hasSubscribers ||
    ch.asyncEnd.hasSubscribers ||
    ch.error.hasSubscribers
  );
}

let spanCounter = 0;

/** A cheap, process-unique span id. Allocated only when a span is observed. */
function nextSpanId(): string {
  spanCounter = (spanCounter + 1) >>> 0;
  return `${Date.now().toString(36)}-${spanCounter.toString(36)}`;
}

/** Publish one phase event on its sub-channel, never throwing. */
function publishPhase(
  channel: Channel,
  phase: SpanPhase,
  lib: string,
  event: string,
  spanId: string,
  traceId: string | undefined,
  extra: { payload?: unknown; result?: unknown; error?: unknown; durationMs?: number },
): void {
  if (!channel.hasSubscribers) return;
  try {
    const envelope: SpanEvent = {
      v: SPAN_SCHEMA_VERSION,
      ts: Date.now(),
      lib,
      event,
      phase,
      spanId,
      traceId,
      ...extra,
    };
    channel.publish(envelope);
  } catch {
    // Observability must never break the traced code path.
  }
}

/** Detect a thenable so a sync `fn` returning a promise is traced as async. */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Wrap an (async) operation and publish span-like start / end / asyncStart /
 * asyncEnd / error events over `node:diagnostics_channel`, so consumers get real
 * start/end/error pairing with timing for authz decisions, durable steps, etc.
 *
 * Naming follows the existing convention: events ride
 * `agora:<lib>:<event>:<phase>` (see {@link traceChannelNames}). `emit` is
 * unchanged — `trace` is the additional span surface.
 *
 * Lifecycle:
 * - Sync `fn`: publishes `start` then, on return, `end` (with `result`); on
 *   throw, `error`. The value/throw is propagated to the caller unchanged.
 * - Async `fn` (returns a promise): publishes `start` synchronously, `asyncStart`
 *   when the promise settles begins resolving, then `asyncEnd` (with `result`)
 *   on fulfilment or `error` on rejection. The promise is returned to the caller.
 *
 * Cost: when NO span sub-channel has a subscriber, `trace` calls `fn` and returns
 * its value directly — no span id, no envelope, no timing — so the hot path is a
 * handful of `hasSubscribers` reads.
 *
 * Trace id: resolved once at span start from `opts.traceId` (wins) else the
 * registered context accessor, and stamped on every phase event.
 *
 * ```ts
 * const decision = trace('authz', 'decision', () => evaluate(req), { subject });
 * const out = await trace('durable', 'step', () => runStep(), { name });
 * ```
 */
export function trace<TLib extends LibOf, TEvent extends EventOf<TLib>, R>(
  lib: TLib,
  event: TEvent,
  fn: () => R,
  payload?: PayloadOf<TLib, TEvent>,
  opts?: TraceOptions,
): R {
  const channels = getSpanChannels(lib, event);

  // Hot path: nothing is listening → run fn directly, allocate nothing.
  if (!anySubscribed(channels)) {
    return fn();
  }

  const spanId = nextSpanId();
  const traceId = opts?.traceId ?? resolveTraceId();
  const startedAt = performance.now();

  publishPhase(channels.start, 'start', lib, event, spanId, traceId, { payload });

  let result: R;
  try {
    result = fn();
  } catch (error) {
    publishPhase(channels.error, 'error', lib, event, spanId, traceId, {
      error,
      durationMs: performance.now() - startedAt,
    });
    throw error;
  }

  if (isPromiseLike(result)) {
    // Async op: end marks the synchronous portion completing; asyncStart marks
    // the continuation; asyncEnd carries the settled result/error + duration.
    publishPhase(channels.end, 'end', lib, event, spanId, traceId, {
      durationMs: performance.now() - startedAt,
    });
    publishPhase(channels.asyncStart, 'asyncStart', lib, event, spanId, traceId, {});
    const settled = Promise.resolve(result).then(
      (value) => {
        publishPhase(channels.asyncEnd, 'asyncEnd', lib, event, spanId, traceId, {
          result: value,
          durationMs: performance.now() - startedAt,
        });
        return value;
      },
      (error) => {
        publishPhase(channels.error, 'error', lib, event, spanId, traceId, {
          error,
          durationMs: performance.now() - startedAt,
        });
        throw error;
      },
    );
    return settled as unknown as R;
  }

  // Sync success.
  publishPhase(channels.end, 'end', lib, event, spanId, traceId, {
    result,
    durationMs: performance.now() - startedAt,
  });
  return result;
}

/** A {@link trace} bound to one `(lib, event)` pair — see {@link tracingChannel}. */
export interface TracingChannel<TPayload = unknown> {
  /** The base `agora:<lib>:<event>` channel name. */
  readonly name: string;
  /** The five span sub-channel names. */
  readonly channels: TraceChannelNames;
  /** Trace an operation on this channel; same semantics as {@link trace}. */
  trace<R>(fn: () => R, payload?: TPayload, opts?: TraceOptions): R;
}

/**
 * A {@link trace} factory bound to a single `(lib, event)` pair — the ergonomic,
 * reusable form for a hot call site that always traces the same operation. Named
 * after Node's `diagnostics_channel.tracingChannel()` (whose sub-channels we
 * mirror) but kept inside the `agora:` convention.
 *
 * ```ts
 * const decision = tracingChannel('authz', 'decision');
 * decision.trace(() => evaluate(req), { subject });
 * ```
 */
export function tracingChannel<TLib extends LibOf, TEvent extends EventOf<TLib>>(
  lib: TLib,
  event: TEvent,
): TracingChannel<PayloadOf<TLib, TEvent>> {
  return {
    name: channelName(lib, event),
    channels: traceChannelNames(lib, event),
    trace: (fn, payload, opts) => trace(lib, event, fn, payload, opts),
  };
}

/**
 * Cross-copy-stable global slot the ecosystem reads `trace` from. Other Agora libs
 * (e.g. `@adonis-agora/media`) republish their spans through
 * `globalThis[Symbol.for('@agora/diagnostics:trace')]` STRUCTURALLY, so they never
 * import `@adonis-agora/diagnostics` and no-op when it is absent. Published at module
 * load — merely importing this package (which the provider does) wires it. Same
 * decoupling contract as `EMIT_SLOT` (which publishes `emit`).
 */
export const TRACE_SLOT = capability('diagnostics', 'trace');
(globalThis as Record<symbol, unknown>)[TRACE_SLOT] = trace;
