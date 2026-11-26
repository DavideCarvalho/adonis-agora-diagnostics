/**
 * A process-wide registry of every `agora:<lib>:<event>` channel name created or
 * emitted through this package.
 *
 * `node:diagnostics_channel` has no wildcard subscription: you can only subscribe
 * to a channel by its exact name. A generic observer (the Telescope watcher) that
 * wants to record *all* diagnostics therefore needs to (a) subscribe to every
 * channel that exists now and (b) be told when a new one appears. This registry
 * provides both: {@link registeredChannels} for the current set and
 * {@link onChannelRegistered} for future additions.
 */

import { capability } from './capability.js';
import { globalSlot } from './global-slot.js';

/**
 * The registry state, backed by a `Symbol.for` key on `globalThis`. Even when
 * more than one physical copy of this package is loaded (divergent version ranges
 * that pnpm cannot dedupe into a single instance), every copy resolves the SAME
 * `channels`/`listeners`. The channel objects themselves are already process-global
 * via `node:diagnostics_channel`; this makes their discovery registry equally
 * global, so a generic observer always sees every emitted channel regardless of
 * which copy registered it. Uses the same `Symbol.for` global-registry technique
 * the `@adonis-agora/*` family uses for cross-copy-stable identifiers (e.g. the
 * `CONTEXT_ACCESSOR` token).
 */
interface Registry {
  /** Every channel name seen so far, in insertion order. */
  channels: Set<string>;
  /** Listeners notified once per newly-registered channel name. */
  listeners: Set<(name: string) => void>;
}

const REGISTRY_KEY = capability('diagnostics', 'registry');
const registry = globalSlot<Registry>(REGISTRY_KEY, () => ({
  channels: new Set<string>(),
  listeners: new Set<(name: string) => void>(),
}));
const { channels, listeners } = registry;

/**
 * Record a channel name, notifying {@link onChannelRegistered} listeners the first
 * time it is seen. Idempotent: re-registering an existing name is a no-op.
 * Called by {@link getChannel}/{@link emit} so every channel touched through this
 * package is discoverable.
 */
export function registerChannel(name: string): void {
  if (channels.has(name)) return;
  channels.add(name);
  for (const listener of listeners) {
    try {
      listener(name);
    } catch {
      // A misbehaving observer must never break event emission.
    }
  }
}

/** Whether `name` is already registered (without copying the registry). */
export function isChannelRegistered(name: string): boolean {
  return channels.has(name);
}

/** A snapshot of every `agora:<lib>:<event>` channel registered so far. */
export function registeredChannels(): string[] {
  return [...channels];
}

/**
 * Subscribe to channel registrations. The callback fires once per channel name
 * registered *after* this call. Returns an unsubscribe function.
 *
 * Note: this does NOT replay existing channels — a generic watcher should pair
 * it with {@link registeredChannels} to cover current + future names:
 *
 * ```ts
 * for (const name of registeredChannels()) subscribe(name);
 * const off = onChannelRegistered(subscribe);
 * ```
 */
export function onChannelRegistered(cb: (name: string) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Hooks run by {@link resetRegistry} so other modules can drop registry-derived
 * caches in lockstep. {@link getChannel} memoizes channels and only registers a
 * name on a cache MISS; if `resetRegistry` cleared `channels` without clearing
 * that cache, an already-cached channel would never re-register and would vanish
 * from discovery. Registering its cache-clear here keeps the test-only reset
 * exact: after a reset, the next `getChannel`/`emit` re-registers every channel.
 */
const resetHooks = new Set<() => void>();

/**
 * Register a callback run by {@link resetRegistry}. Used internally by
 * {@link getChannel}'s memo cache; not part of the public contract.
 */
export function onRegistryReset(cb: () => void): void {
  resetHooks.add(cb);
}

/**
 * Test-only: forget every registered channel and listener. Not part of the
 * public contract — exposed so suites can assert registration in isolation.
 */
export function resetRegistry(): void {
  channels.clear();
  listeners.clear();
  for (const hook of resetHooks) {
    try {
      hook();
    } catch {
      // A misbehaving reset hook must never break the reset itself.
    }
  }
}
