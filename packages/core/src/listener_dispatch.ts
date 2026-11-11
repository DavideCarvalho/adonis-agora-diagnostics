import { randomUUID } from 'node:crypto';
import diagnostics_channel from 'node:diagnostics_channel';
import { capability } from './capability.js';
import { CHANNEL_PREFIX, channelName } from './channel.js';
import type { ListenerDelivery, ListenerInvoker } from './delivery.js';
import {
  getListener,
  type ListenerClass,
  listenersFor,
  onListenersChanged,
  registeredListeners,
} from './listeners.js';
import { onChannelRegistered, registeredChannels } from './registry.js';
import { createTurnBatcher } from './relay.js';
import { isRelayed } from './relayed.js';
import type { DiagnosticEvent } from './types.js';

/** Thrown by a {@link ListenerInvoker} for a listener id this process does not know. */
export class UnknownListenerError extends Error {
  readonly code = 'E_UNKNOWN_DIAGNOSTICS_LISTENER';
  constructor(readonly listenerId: string) {
    super(
      `@adonis-agora/diagnostics: no listener "${listenerId}" is registered in this process. Every process that runs deliveries must register the same listeners.`,
    );
  }
}

/**
 * Build the invoker that runs a registered listener: it instantiates the listener class with
 * `make` (the AdonisJS container in an app) and awaits the method. A handler error rejects the
 * returned promise unchanged, so a delivering transport can retry it.
 */
export function createListenerInvoker(
  make: (target: ListenerClass) => object | Promise<object>,
): ListenerInvoker {
  return async (listenerId, envelope) => {
    const listener = getListener(listenerId);
    if (!listener) throw new UnknownListenerError(listenerId);
    const instance = (await make(listener.target)) as Record<string, unknown>;
    const method = instance[listener.method];
    if (typeof method !== 'function') {
      throw new TypeError(
        `@adonis-agora/diagnostics: listener "${listenerId}" has no method "${listener.method}"`,
      );
    }
    await method.call(instance, envelope);
  };
}

/**
 * Cross-copy-stable slot holding this process's {@link ListenerInvoker} once the provider has
 * booted. Delivering transports receive the invoker in their context; this slot is for code that
 * runs deliveries without that context (a job class loaded by a worker, for example).
 */
export const LISTENER_INVOKER_SLOT = capability('diagnostics', 'listener-invoker');

/** Publish (or clear, with `null`) the process invoker. Returns a function that clears it. */
export function bindListenerInvoker(invoker: ListenerInvoker | null): () => void {
  const slots = globalThis as Record<symbol, unknown>;
  slots[LISTENER_INVOKER_SLOT] = invoker ?? undefined;
  return () => {
    if (slots[LISTENER_INVOKER_SLOT] === invoker) slots[LISTENER_INVOKER_SLOT] = undefined;
  };
}

/** The invoker bound in this process, or `null` before the provider booted. */
export function getListenerInvoker(): ListenerInvoker | null {
  return (
    ((globalThis as Record<symbol, unknown>)[LISTENER_INVOKER_SLOT] as ListenerInvoker) ?? null
  );
}

/** A diagnostics POINT event (from `emit`). Span phase events from `trace` are not delivered. */
function isPointEvent(msg: unknown): msg is DiagnosticEvent {
  if (typeof msg !== 'object' || msg === null) return false;
  const env = msg as Partial<DiagnosticEvent> & { phase?: unknown; spanId?: unknown };
  if (typeof env.lib !== 'string' || typeof env.event !== 'string') return false;
  return env.phase === undefined || env.spanId === undefined;
}

export interface ListenerDispatchOptions {
  invoke: ListenerInvoker;
  /**
   * The delivering transport's `deliver`. When set, events emitted in THIS process are handed to
   * it (once per matching listener, batched per event loop turn) and relayed copies are skipped.
   * When unset, listeners run here, in every process the event reaches.
   */
  deliver?: ((deliveries: readonly ListenerDelivery[]) => void | Promise<void>) | undefined;
  /** A local listener threw or rejected. */
  onListenerError: (error: unknown, listenerId: string, envelope: DiagnosticEvent) => void;
  /** `deliver` threw or rejected: those deliveries are lost. */
  onDeliveryError: (error: unknown, deliveries: readonly ListenerDelivery[]) => void;
}

/**
 * Subscribe registered listeners to the bus. Every channel of every lib that has a listener is
 * subscribed once (current and future channels); each point event is matched against the listener
 * registry and either invoked locally or handed to the delivering transport.
 *
 * Returns a teardown that hands over any queued deliveries and unsubscribes everything.
 */
export function startListenerDispatch(options: ListenerDispatchOptions): () => void {
  const { invoke, deliver, onListenerError, onDeliveryError } = options;

  const batcher = createTurnBatcher<ListenerDelivery>((deliveries) => {
    try {
      const result = deliver?.(deliveries);
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        (result as PromiseLike<unknown>).then(undefined, (error) =>
          safely(() => onDeliveryError(error, deliveries)),
        );
      }
    } catch (error) {
      safely(() => onDeliveryError(error, deliveries));
    }
  });

  const onEvent = (msg: unknown): void => {
    if (!isPointEvent(msg)) return;
    const matched = listenersFor(msg.lib, msg.event);
    if (matched.length === 0) return;
    if (deliver) {
      // Delivery happens once, at the origin. A relayed copy was already handed over there.
      if (isRelayed(msg)) return;
      const envelope = (
        typeof msg.id === 'string' ? msg : { ...msg, id: randomUUID() }
      ) as ListenerDelivery['envelope'];
      for (const listener of matched) batcher.push({ listenerId: listener.id, envelope });
      return;
    }
    for (const listener of matched) {
      invoke(listener.id, msg).then(undefined, (error) =>
        safely(() => onListenerError(error, listener.id, msg)),
      );
    }
  };

  const subscribed = new Set<string>();
  const libs = new Set<string>();
  const subscribe = (name: string): void => {
    if (subscribed.has(name)) return;
    diagnostics_channel.channel(name).subscribe(onEvent);
    subscribed.add(name);
  };
  const libOf = (name: string): string | undefined => {
    if (!name.startsWith(`${CHANNEL_PREFIX}:`)) return undefined;
    const rest = name.slice(CHANNEL_PREFIX.length + 1);
    const idx = rest.indexOf(':');
    return idx > 0 ? rest.slice(0, idx) : undefined;
  };

  const sync = (): void => {
    for (const listener of registeredListeners()) {
      if (typeof listener.event === 'string') subscribe(channelName(listener.lib, listener.event));
      if (libs.has(listener.lib)) continue;
      libs.add(listener.lib);
      for (const name of registeredChannels()) if (libOf(name) === listener.lib) subscribe(name);
    }
  };

  const offRegistered = onChannelRegistered((name) => {
    const lib = libOf(name);
    if (lib !== undefined && libs.has(lib)) subscribe(name);
  });
  const offChanged = onListenersChanged(sync);
  sync();

  return () => {
    batcher.flush();
    offChanged();
    offRegistered();
    for (const name of subscribed) diagnostics_channel.channel(name).unsubscribe(onEvent);
    subscribed.clear();
    libs.clear();
  };
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // error hooks run outside any caller; a throwing hook must not become an uncaught exception
  }
}
