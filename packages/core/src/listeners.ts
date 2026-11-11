import { capability } from './capability.js';
import { globalSlot } from './global-slot.js';
import type { DiagnosticEvent, EventOf, LibOf, PayloadOf } from './types.js';

/** Any class a listener can be built from. The container (or `new`) instantiates it. */
export type ListenerClass = abstract new (...args: never[]) => object;

/** A lazily imported listener module, as in `() => import('#listeners/track_agent_run')`. */
export type LazyListener = () => Promise<{ default: ListenerClass }>;

/**
 * A listener reference for {@link import('./subscriber.js').onDiagnostic onDiagnostic}: a class
 * (or a lazy import of one) and the name of the method to call, like the AdonisJS emitter's
 * `[Listener, 'method']` tuples.
 */
export type ListenerRef = readonly [ListenerClass | LazyListener, string];

/** Which events of a lib a listener receives: one exact name, a pattern, or every event. */
export type ListenerEventMatcher = string | RegExp | undefined;

/** The envelope a listener for `(TLib, TEvent)` receives, typed from the `ChannelRegistry`. */
export type DiagnosticEventOf<TLib extends string, TEvent extends string> = DiagnosticEvent<
  PayloadOf<TLib, TEvent>
>;

/** Options for registering a listener reference. */
export interface ListenerOptions {
  /**
   * Stable listener id. Defaults to `<ClassName>#<method>`. Delivering transports (`queue`,
   * `durable`) route work by this id, so it must be the same in every process and must not
   * change while deliveries for it may still be pending.
   */
  id?: string;
}

/** A listener method as recorded by the {@link OnDiagnostic} decorator. */
interface DecoratedMethod {
  lib: string;
  event: ListenerEventMatcher;
  method: string;
}

/** A registered listener: where it listens and what to call. */
export interface RegisteredListener {
  /** Stable id, e.g. `app/listeners/diagnostics/track_agent_run#handle` or `TrackAgentRun#handle`. */
  readonly id: string;
  readonly lib: string;
  readonly event: ListenerEventMatcher;
  readonly target: ListenerClass;
  readonly method: string;
}

interface PendingRef {
  lib: string;
  event: ListenerEventMatcher;
  ref: ListenerRef;
  id: string | undefined;
  settled: boolean;
}

interface ListenerState {
  listeners: Map<string, RegisteredListener>;
  pending: Set<PendingRef>;
  changeHandlers: Set<() => void>;
  /** `lib\0event` → matching listeners, rebuilt lazily after any registry change. */
  matchCache: Map<string, RegisteredListener[]>;
}

const state = globalSlot<ListenerState>(capability('diagnostics', 'listeners'), () => ({
  listeners: new Map(),
  pending: new Set(),
  changeHandlers: new Set(),
  matchCache: new Map(),
}));

const DECORATED = Symbol.for('@agora/diagnostics:listener-methods');
const METADATA: symbol =
  (Symbol as { metadata?: symbol }).metadata ?? Symbol.for('Symbol.metadata');

function changed(): void {
  state.matchCache.clear();
  for (const handler of [...state.changeHandlers]) handler();
}

function describeEvent(event: ListenerEventMatcher): string {
  if (event === undefined) return '*';
  return typeof event === 'string' ? event : event.toString();
}

/** Register a resolved listener. Throws on an id collision with a different listener. */
function add(listener: RegisteredListener): () => void {
  const existing = state.listeners.get(listener.id);
  if (existing) {
    const same =
      existing.target === listener.target &&
      existing.method === listener.method &&
      existing.lib === listener.lib &&
      describeEvent(existing.event) === describeEvent(listener.event);
    if (same) return () => {};
    throw new Error(
      `@adonis-agora/diagnostics: two listeners share the id "${listener.id}". Listener ids must be unique; pass { id } to onDiagnostic to name one explicitly.`,
    );
  }
  if (
    typeof (listener.target.prototype as Record<string, unknown>)[listener.method] !== 'function'
  ) {
    throw new Error(
      `@adonis-agora/diagnostics: listener "${listener.id}" points at ${listener.target.name}.${listener.method}, which is not a method.`,
    );
  }
  state.listeners.set(listener.id, listener);
  changed();
  return () => {
    if (state.listeners.get(listener.id) === listener) {
      state.listeners.delete(listener.id);
      changed();
    }
  };
}

function isClass(fn: unknown): fn is ListenerClass {
  return typeof fn === 'function' && fn.prototype !== undefined;
}

/**
 * Register a `[Listener, 'method']` reference for `(lib, event)`. A class is registered at once; a
 * lazy import is resolved by {@link loadListeners} at boot (or right away, when registered after
 * boot).
 */
export function registerListenerRef(
  lib: string,
  event: ListenerEventMatcher,
  ref: ListenerRef,
  options: ListenerOptions = {},
): () => void {
  const [target, method] = ref;
  if (isClass(target)) {
    return add({ id: options.id ?? `${target.name}#${method}`, lib, event, target, method });
  }
  const pending: PendingRef = { lib, event, ref, id: options.id, settled: false };
  state.pending.add(pending);
  let off: (() => void) | null = null;
  let cancelled = false;
  if (booted)
    void resolvePending(pending).then((unregister) => {
      if (cancelled) unregister();
      else off = unregister;
    }, reportLateError);
  return () => {
    cancelled = true;
    state.pending.delete(pending);
    off?.();
  };
}

let booted = false;
let reportLateError: (error: unknown) => void = () => {};

async function resolvePending(pending: PendingRef): Promise<() => void> {
  const [load, method] = pending.ref;
  const loaded = await (load as LazyListener)();
  const target = loaded?.default;
  if (!isClass(target)) {
    throw new Error(
      `@adonis-agora/diagnostics: the lazy listener for "${pending.lib}" does not default-export a class.`,
    );
  }
  pending.settled = true;
  state.pending.delete(pending);
  return add({
    id: pending.id ?? `${target.name}#${method}`,
    lib: pending.lib,
    event: pending.event,
    target,
    method,
  });
}

/**
 * Register every `@OnDiagnostic` method of `target` under the id prefix `idPrefix`
 * (`<idPrefix>#<method>`). Returns how many methods were registered.
 */
export function registerListenerClass(target: ListenerClass, idPrefix: string): number {
  const methods = decoratedMethodsOf(target);
  for (const { lib, event, method } of methods) {
    add({ id: `${idPrefix}#${method}`, lib, event, target, method });
  }
  return methods.length;
}

/** The `@OnDiagnostic` methods declared on `target` (and its parent classes). */
export function decoratedMethodsOf(target: ListenerClass): DecoratedMethod[] {
  const out: DecoratedMethod[] = [];
  const legacy = (target as unknown as Record<symbol, DecoratedMethod[] | undefined>)[DECORATED];
  if (legacy) out.push(...legacy);
  const metadata = (target as unknown as Record<symbol, Record<symbol, unknown> | undefined>)[
    METADATA
  ];
  const standard = metadata?.[DECORATED] as DecoratedMethod[] | undefined;
  if (standard) out.push(...standard);
  return out;
}

/**
 * Resolve every pending lazy listener reference. Called by the provider at boot, after preload
 * files ran; later registrations resolve on their own. `onLateError` receives the failure of a
 * lazy reference registered after boot.
 */
export async function loadListeners(onLateError?: (error: unknown) => void): Promise<void> {
  await Promise.all([...state.pending].map((pending) => resolvePending(pending)));
  booted = true;
  if (onLateError) reportLateError = onLateError;
}

/** Every registered listener. */
export function registeredListeners(): RegisteredListener[] {
  return [...state.listeners.values()];
}

/** The registered listener with this id, if any. */
export function getListener(id: string): RegisteredListener | undefined {
  return state.listeners.get(id);
}

function matches(listener: RegisteredListener, lib: string, event: string): boolean {
  if (listener.lib !== lib) return false;
  const matcher = listener.event;
  if (matcher === undefined) return true;
  if (typeof matcher === 'string') return matcher === event;
  matcher.lastIndex = 0;
  return matcher.test(event);
}

/** The listeners that receive an event on `agora:<lib>:<event>`. */
export function listenersFor(lib: string, event: string): RegisteredListener[] {
  const key = `${lib}\0${event}`;
  let hit = state.matchCache.get(key);
  if (hit === undefined) {
    hit = registeredListeners().filter((listener) => matches(listener, lib, event));
    state.matchCache.set(key, hit);
  }
  return hit;
}

/** Be told when listeners are added or removed. Returns an unsubscribe function. */
export function onListenersChanged(handler: () => void): () => void {
  state.changeHandlers.add(handler);
  return () => state.changeHandlers.delete(handler);
}

/** Remove every listener and pending reference. For tests. */
export function resetListeners(): void {
  state.listeners.clear();
  state.pending.clear();
  booted = false;
  reportLateError = () => {};
  changed();
}

type ListenerMethod<TEvent> = (event: TEvent) => unknown;

/**
 * The decorator {@link OnDiagnostic} returns. It accepts both decorator flavours: TypeScript's
 * `experimentalDecorators` (what AdonisJS apps use) and standard decorators. The method's
 * parameter must accept `TEvent`.
 */
export interface ListenerMethodDecorator<TEvent> {
  <M extends ListenerMethod<TEvent>>(
    target: object,
    key: string | symbol,
    descriptor: TypedPropertyDescriptor<M>,
  ): void;
  <M extends ListenerMethod<TEvent>>(value: M, context: ClassMethodDecoratorContext): void;
}

/**
 * Mark a method of a listener class as a diagnostics listener for `lib` (every event), for one
 * exact `event`, or for every event whose name matches a `RegExp`. The listener class is picked up
 * from the listeners directory (`app/listeners/diagnostics` by default); see the Listeners docs.
 *
 * For a channel declared in the `ChannelRegistry`, annotate the parameter with
 * {@link DiagnosticEventOf}: the decorator rejects a parameter type that does not match.
 *
 * ```ts
 * export default class TrackAgentRun {
 *   @OnDiagnostic('agent', 'run.finished')
 *   async handle(event: DiagnosticEventOf<'agent', 'run.finished'>) {}
 * }
 * ```
 */
export function OnDiagnostic<TLib extends LibOf>(
  lib: TLib,
): ListenerMethodDecorator<DiagnosticEvent<unknown>>;
export function OnDiagnostic<TLib extends LibOf, TEvent extends EventOf<TLib>>(
  lib: TLib,
  event: TEvent,
): ListenerMethodDecorator<DiagnosticEventOf<TLib, TEvent>>;
export function OnDiagnostic<TLib extends LibOf>(
  lib: TLib,
  event: RegExp,
): ListenerMethodDecorator<DiagnosticEvent<unknown>>;
export function OnDiagnostic(
  lib: string,
  event?: string | RegExp,
): ListenerMethodDecorator<DiagnosticEvent<never>> {
  const decorator = (targetOrValue: unknown, keyOrContext: unknown): void => {
    if (typeof keyOrContext === 'object' && keyOrContext !== null && 'kind' in keyOrContext) {
      const context = keyOrContext as ClassMethodDecoratorContext;
      if (context.kind !== 'method' || context.static || typeof context.name !== 'string') {
        throw new TypeError('@OnDiagnostic decorates instance methods only');
      }
      const metadata = context.metadata as Record<symbol, unknown> | undefined;
      if (!metadata) {
        throw new TypeError(
          '@OnDiagnostic needs decorator metadata (Symbol.metadata); enable `experimentalDecorators` or use TypeScript 5.2+',
        );
      }
      // Copy-on-write so a subclass never appends to its parent's list.
      const inherited = metadata[DECORATED] as DecoratedMethod[] | undefined;
      const own =
        Object.hasOwn(metadata, DECORATED) && inherited ? inherited : [...(inherited ?? [])];
      own.push({ lib, event, method: context.name });
      metadata[DECORATED] = own;
      return;
    }
    if (typeof keyOrContext !== 'string') {
      throw new TypeError('@OnDiagnostic decorates instance methods with a string name');
    }
    const ctor = (targetOrValue as { constructor?: unknown }).constructor;
    if (typeof ctor !== 'function' || targetOrValue === ctor) {
      throw new TypeError('@OnDiagnostic decorates instance methods only');
    }
    const slots = ctor as unknown as Record<symbol, DecoratedMethod[] | undefined>;
    const inherited = slots[DECORATED] ?? [];
    const own = Object.hasOwn(slots, DECORATED) ? inherited : [...inherited];
    own.push({ lib, event, method: keyOrContext });
    slots[DECORATED] = own;
  };
  return decorator as ListenerMethodDecorator<DiagnosticEvent<never>>;
}
