/**
 * Local, structural mirror of `@adonis-agora/context`'s public accessor
 * (`packages/core/src/accessor.ts`).
 *
 * We deliberately do NOT import @adonis-agora/context (it is an OPTIONAL peer). Instead
 * we declare the same shape here; any object that structurally satisfies this
 * interface — including @adonis-agora/context's real accessor — can be registered via
 * {@link setContextAccessor} so {@link emit} can auto-fill `traceId`.
 *
 * Kept byte-aligned with @adonis-agora/context's `ContextAccessor`: `traceId()` /
 * `tenantId()` / `userRef()` / `get()` are all present so the structural match
 * stays exact and a future use of any of them is type-safe.
 */

import { capability } from './capability.js';
import { globalSlot } from './global-slot.js';

export interface UserRef {
  type: string;
  id: string | number;
}

/** Opaque shape of the context store. diagnostics never reads it; mirrors the upstream surface. */
export type ContextStore = Record<string, unknown>;

export interface ContextAccessor {
  /** Trace id for the current request, or `undefined` when unavailable. */
  traceId(): string | undefined;
  /** Current tenant id, or `undefined` when no multi-tenant context is populated. */
  tenantId(): string | undefined;
  /** Reference to the current user, or `undefined` when unauthenticated. */
  userRef(): UserRef | undefined;
  /** The raw context store for the current request, or `undefined`. */
  get(): ContextStore | undefined;
}

/**
 * The shared capability token `@adonis-agora/context` publishes its accessor under — a process-global
 * `globalThis` slot, not an IoC binding. Exposed so a consumer can read the current accessor via
 * {@link getContextAccessor} (or install one with {@link setContextAccessor}) — symmetric with how the
 * rest of the `@adonis-agora/*` family wires the optional context peer.
 */
export const CONTEXT_ACCESSOR = capability('context', 'accessor');

/**
 * The accessor used by {@link emit} to auto-fill `traceId`. `null` until something
 * calls {@link setContextAccessor} — `@adonis-agora/context` does this at module
 * init (soft-detecting this package), so `traceId` correlates automatically when
 * context is installed. Kept out of the hot path: when unset, `emit` leaves
 * `traceId` undefined.
 *
 * Backed by a `Symbol.for` slot on `globalThis` — same technique as the channel
 * {@link registerChannel registry} — so the accessor registered through one
 * physical copy of this package is visible to `emit()` in every copy, even when
 * divergent versions prevent pnpm from deduping to a single instance. Held inside
 * an object (`{ current }`) so all copies share one mutable cell.
 */
interface AccessorHolder {
  current: ContextAccessor | null;
}

const ACCESSOR_KEY = capability('diagnostics', 'accessor');
const accessorHolder = globalSlot<AccessorHolder>(ACCESSOR_KEY, () => ({ current: null }));

/** Register (or clear, with `null`) the accessor {@link emit} reads `traceId` from. */
export function setContextAccessor(next: ContextAccessor | null): void {
  accessorHolder.current = next;
}

/** The currently registered accessor, or `null`. */
export function getContextAccessor(): ContextAccessor | null {
  return accessorHolder.current;
}

/** Resolve the current trace id from the registered accessor, never throwing. */
export function resolveTraceId(): string | undefined {
  const accessor = accessorHolder.current;
  if (accessor == null) return undefined;
  try {
    return accessor.traceId();
  } catch {
    return undefined;
  }
}
