import { randomUUID } from 'node:crypto';
import diagnostics_channel, { type Channel } from 'node:diagnostics_channel';
import { capability } from './capability.js';
import { resolveTraceId } from './context_accessor.js';
import { onRegistryReset, registerChannel } from './registry.js';
import type { DiagnosticEvent, EmitOptions, EventOf, LibOf, PayloadOf } from './types.js';

/** The prefix all channels created by this convention share. */
export const CHANNEL_PREFIX = 'agora';

/**
 * Current envelope schema version, stamped onto every emitted
 * {@link DiagnosticEvent} as `v`. Bump this only when the wire shape changes in a
 * way observers must adapt to. Observers should tolerate envelopes without `v`
 * (legacy emitters published before versioning) and treat them as version `1`.
 */
export const SCHEMA_VERSION = 1;

/**
 * The channel name for a `<lib>`/`<event>` pair: `agora:<lib>:<event>`. This is
 * the cross-repo wire contract — keep it identical on producer and observer.
 */
export function channelName(lib: string, event: string): string {
  return `${CHANNEL_PREFIX}:${lib}:${event}`;
}

/**
 * Per-`(lib, event)` cache of the resolved {@link Channel}, keyed by `lib` then
 * `event`. The first {@link getChannel}/{@link emit} for a pair pays the string
 * concat + `diagnostics_channel.channel()` lookup + registry insert; every call
 * after that is a pair of `Map.get`s and returns the SAME object — no string is
 * allocated on the steady state. A nested map (rather than one keyed by the full
 * `agora:<lib>:<event>` name) is what lets us skip the concat entirely.
 *
 * Node already returns a process-stable {@link Channel} per name, so caching it
 * here changes nothing observable: `getChannel(a,b)` still returns
 * `diagnostics_channel.channel('agora:a:b')`. The registry is still fed exactly
 * once per pair (on the cache miss), so discovery is unchanged.
 */
const channelCache = new Map<string, Map<string, Channel>>();

// Drop the memo cache whenever the registry is reset (test-only), so the next
// getChannel re-registers every channel. See onRegistryReset in registry.ts.
onRegistryReset(() => channelCache.clear());

/**
 * The memoized `node:diagnostics_channel` for a `<lib>`/`<event>` pair. Node
 * returns the same {@link Channel} object for the same name, so reading
 * `.hasSubscribers` is the cheap gate before building an envelope. Touching the
 * channel also records its name in the {@link registerChannel registry} so a
 * generic observer can discover it.
 *
 * Memoized via {@link channelCache}: only the first call for a `(lib, event)`
 * pair builds the name, resolves the channel, and registers it; subsequent calls
 * return the cached object after two map lookups.
 */
export function getChannel(lib: string, event: string): Channel {
  let byEvent = channelCache.get(lib);
  if (byEvent !== undefined) {
    const cached = byEvent.get(event);
    if (cached !== undefined) return cached;
  } else {
    byEvent = new Map<string, Channel>();
    channelCache.set(lib, byEvent);
  }
  const name = channelName(lib, event);
  const channel = diagnostics_channel.channel(name);
  registerChannel(name);
  byEvent.set(event, channel);
  return channel;
}

/**
 * Emit a diagnostics event on `agora:<lib>:<event>`.
 *
 * - The envelope's `ts` is `Date.now()` evaluated *inside* this call (never at
 *   module load).
 * - `traceId` is taken from `opts.traceId` if given, else auto-filled from the
 *   registered context accessor (if resolvable), else left undefined.
 * - The envelope is built and published ONLY when the channel `hasSubscribers`,
 *   so emitting is effectively free when nothing is listening.
 * - When `opts.sample` is given, it is consulted AFTER the `hasSubscribers` gate
 *   and BEFORE the envelope is built: a falsy result sheds this event without
 *   allocating anything. Default (no `sample`) always publishes when subscribed.
 * - The envelope carries the current {@link SCHEMA_VERSION} as `v` and a unique `id` (UUID).
 * - Never throws: emitting observability must not break the caller.
 *
 * ```ts
 * emit('billing', 'invoice-paid', { invoiceId: 'inv_123', amount: 4200 });
 * // Shed 90% of a hot event:
 * emit('authz', 'decision', payload, { sample: () => Math.random() < 0.1 });
 * ```
 *
 * When `(lib, event)` is declared in the typed
 * {@link import('./types.js').ChannelRegistry ChannelRegistry}, `payload` is
 * checked against the declared type at compile time; every other pair keeps the
 * untyped `unknown` payload. The runtime behavior is identical either way.
 */
export function emit<TLib extends LibOf, TEvent extends EventOf<TLib>>(
  lib: TLib,
  event: TEvent,
  payload: PayloadOf<TLib, TEvent>,
  opts?: EmitOptions,
): void {
  const channel = getChannel(lib, event);
  if (!channel.hasSubscribers) return;
  try {
    // Load-shedding gate: consulted only when subscribed, before any allocation.
    // A throwing sampler is treated as a skip (caught below) — never published.
    if (opts?.sample !== undefined && !opts.sample()) return;
    const traceId = opts?.traceId ?? resolveTraceId();
    const envelope: DiagnosticEvent = {
      v: SCHEMA_VERSION,
      id: randomUUID(),
      ts: Date.now(),
      lib,
      event,
      traceId,
      payload,
      // Only set the key when a duration was provided — omitting it keeps the
      // envelope shape monomorphic (no undefined-valued key on common events).
      ...(opts?.durationMs !== undefined && { durationMs: opts.durationMs }),
    };
    channel.publish(envelope);
  } catch {
    // Observability must never break the emitting code path.
  }
}

/**
 * Cross-copy-stable global slot the ecosystem reads `emit` from. Other Agora libs
 * (e.g. `@adonis-agora/resilience`) republish their events through
 * `globalThis[Symbol.for('@agora/diagnostics:emit')]` STRUCTURALLY, so they never
 * import `@adonis-agora/diagnostics` and no-op when it is absent. Published at module
 * load — merely importing this package (which the provider does) wires it. Same
 * decoupling contract as `@adonis-agora/context`'s accessor slot.
 */
export const EMIT_SLOT = capability('diagnostics', 'emit');
(globalThis as Record<symbol, unknown>)[EMIT_SLOT] = emit;
