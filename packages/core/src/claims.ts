/**
 * A process-wide registry of which `agora:<lib>:<event>` channels are already
 * handled as a first-class, typed observation by a lib-specific consumer (e.g.
 * a lib's own OTel span shape for `agora:agent:*`, or its own Telescope-style
 * watcher for `agora:media:*`). The generic {@link DiagnosticsOtelBridge} and
 * relays auto-subscribe to EVERY registered channel (see {@link registerChannel}),
 * so without this registry every event a claiming lib emits would be handled
 * TWICE: once as its own typed observation, once as a generic one. Claiming a
 * key tells the generic bridge "I already handle this — skip it by default."
 *
 * ## RAW convention (no dependency on this package required)
 * The registry is a plain `Map<string, number>` behind a well-known
 * `Symbol.for` key, so a package that does NOT want to depend on
 * `@adonis-agora/diagnostics` can still participate by replicating this
 * structure exactly, without importing anything from here:
 *
 * - `Symbol.for('@agora/diagnostics:claims')` resolves to a
 *   `Map<string, number>` stored on `globalThis`.
 * - Each key is `` `${lib}:${event}` `` — the same `lib:event` label the relay
 *   and bridge parse channel names into.
 * - The value is a reference count, always `>= 1` while the key is claimed by
 *   at least one caller. Claiming an already-claimed key increments the count;
 *   releasing decrements it; the key is deleted (unclaimed again) only once the
 *   count reaches `0`. This is what lets two independent consumers claim the
 *   same key without one's release un-claiming it for the other.
 * - A key is "claimed" iff the map has it; "unclaimed" iff absent (or its count
 *   reached `0` and was deleted).
 *
 * ## Record-time-check contract
 * A generic observer (like the OTel bridge) MUST call {@link isDiagnosticClaimed}
 * at RECORD time — when an event is actually published — not at subscribe time.
 * This makes claiming order-independent: a lib-specific consumer may call
 * {@link claimDiagnostics} before or after the generic bridge's `start()` runs,
 * and every event handled after the claim exists is skipped either way. Checking
 * once at subscribe time would miss claims registered later and could not
 * un-skip a released claim either.
 */

import { capability } from './capability.js';
import { globalSlot } from './global-slot.js';

/** The registry state: `lib:event` key → active claim count (`>= 1`). */
type ClaimStore = Map<string, number>;

/**
 * The claim registry, held under the well-known `Symbol.for('@agora/diagnostics:claims')`
 * slot on `globalThis` — same cross-copy-stable technique as the channel/subscriber
 * registries — so claims made through any physical copy of the package are shared.
 */
const CLAIMS_KEY = capability('diagnostics', 'claims');
const claims = globalSlot<ClaimStore>(CLAIMS_KEY, () => new Map<string, number>());

/** The `lib:event` label used as the claim-store key, same shape the relay/bridge parse into. */
function claimKey(lib: string, event: string): string {
  return `${lib}:${event}`;
}

/**
 * Claim `lib:event` for every event in `events`, so a generic observer skips
 * them by default (see the record-time-check contract above). Call this once
 * when a lib-specific consumer starts, passing every event it handles as a
 * typed observation.
 *
 * Reference-counted: claiming a key already claimed by a different call (e.g.
 * two bridge instances, or overlapping event lists) increments its count
 * instead of overwriting it, so releasing one caller's claim never un-claims a
 * key another caller still holds.
 *
 * Returns a release function that removes EXACTLY the keys this call added —
 * decrementing each of `events`' counts by one, deleting the key only once its
 * count reaches `0`. Idempotent: calling the release function more than once
 * has no additional effect.
 *
 * ```ts
 * const release = claimDiagnostics('agent', ['chat-request', 'tool-call']);
 * // ... later, e.g. on consumer cleanup:
 * release();
 * ```
 */
export function claimDiagnostics(lib: string, events: readonly string[]): () => void {
  const keys = events.map((event) => claimKey(lib, event));
  for (const key of keys) {
    claims.set(key, (claims.get(key) ?? 0) + 1);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const count = claims.get(key);
      if (count === undefined) continue;
      if (count <= 1) claims.delete(key);
      else claims.set(key, count - 1);
    }
  };
}

/**
 * Whether `lib:event` is currently claimed by at least one
 * {@link claimDiagnostics} call. Intended to be checked at record time by a
 * generic observer, per the contract above.
 */
export function isDiagnosticClaimed(lib: string, event: string): boolean {
  return claims.has(claimKey(lib, event));
}
