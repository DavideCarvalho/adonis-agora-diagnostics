import diagnostics_channel from 'node:diagnostics_channel';
import { capability } from './capability.js';
import { CHANNEL_PREFIX, channelName } from './channel.js';
import { globalSlot } from './global-slot.js';
import { onChannelRegistered, registeredChannels } from './registry.js';
import type { DiagnosticEvent } from './types.js';

/**
 * A reaction to a diagnostics event. May be async; a rejected promise is routed
 * to {@link OnDiagnosticOptions.onError} (or swallowed) so a buggy handler can
 * never break the synchronous `emit()`/`trace()` that triggered it.
 */
export type DiagnosticHandler = (event: DiagnosticEvent) => void | Promise<void>;

export interface OnDiagnosticOptions {
  /** Called when a handler throws or rejects. Defaults to a silent swallow. */
  onError?: (err: unknown, event?: DiagnosticEvent) => void;
}

interface ActiveSub {
  name: string;
  listener: (msg: unknown) => void;
}

/**
 * Every live subscription's disposer, so {@link unsubscribeAll} (called by the
 * AdonisJS provider on shutdown) can tear them all down. Backed by a `Symbol.for`
 * slot on `globalThis` — same cross-copy-stable technique as the channel registry
 * — so subscriptions made through any physical copy of the package are disposed.
 */
const DISPOSERS_KEY = capability('diagnostics', 'subscribers');
const disposers = globalSlot<Set<() => void>>(DISPOSERS_KEY, () => new Set<() => void>());

function invokeSafely(
  handler: DiagnosticHandler,
  event: DiagnosticEvent,
  onError?: OnDiagnosticOptions['onError'],
): void {
  try {
    const result = handler(event);
    if (result != null && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).catch((err) => onError?.(err, event));
    }
  } catch (err) {
    onError?.(err, event);
  }
}

/** Subscribe to every `agora:<lib>:*` channel (current and future). */
export function onDiagnostic(
  lib: string,
  handler: DiagnosticHandler,
  opts?: OnDiagnosticOptions,
): () => void;
/** Subscribe to the exact `agora:<lib>:<event>` channel. */
export function onDiagnostic(
  lib: string,
  event: string,
  handler: DiagnosticHandler,
  opts?: OnDiagnosticOptions,
): () => void;
/**
 * Subscribe a handler to diagnostics events. Reads `node:diagnostics_channel`
 * directly and touches no framework state, so it works in any process — HTTP,
 * queue workers, ace commands.
 *
 * - `onDiagnostic('resilience', 'circuit-opened', fn)` — the exact channel.
 * - `onDiagnostic('resilience', fn)` — every `agora:resilience:*` channel,
 *   current and future (auto-subscribes channels registered later).
 *
 * Returns an unsubscribe function. Handler errors never propagate to the emitter.
 */
export function onDiagnostic(
  lib: string,
  eventOrHandler: string | DiagnosticHandler,
  handlerOrOpts?: DiagnosticHandler | OnDiagnosticOptions,
  maybeOpts?: OnDiagnosticOptions,
): () => void {
  const wildcard = typeof eventOrHandler !== 'string';
  const event = wildcard ? undefined : eventOrHandler;
  const handler = (wildcard ? eventOrHandler : handlerOrOpts) as DiagnosticHandler;
  const opts = (wildcard ? (handlerOrOpts as OnDiagnosticOptions) : maybeOpts) ?? {};

  const subs: ActiveSub[] = [];
  let offRegistered: (() => void) | null = null;

  const subscribe = (name: string) => {
    const listener = (msg: unknown) => invokeSafely(handler, msg as DiagnosticEvent, opts.onError);
    diagnostics_channel.channel(name).subscribe(listener);
    subs.push({ name, listener });
  };

  if (event !== undefined) {
    subscribe(channelName(lib, event));
  } else {
    const prefix = `${CHANNEL_PREFIX}:${lib}:`;
    for (const name of registeredChannels()) {
      if (name.startsWith(prefix)) subscribe(name);
    }
    offRegistered = onChannelRegistered((name) => {
      if (name.startsWith(prefix)) subscribe(name);
    });
  }

  const off = () => {
    offRegistered?.();
    offRegistered = null;
    for (const { name, listener } of subs) {
      diagnostics_channel.channel(name).unsubscribe(listener);
    }
    subs.length = 0;
    disposers.delete(off);
  };
  disposers.add(off);
  return off;
}

/** Tear down every live {@link onDiagnostic} subscription. Called on app shutdown. */
export function unsubscribeAll(): void {
  for (const off of [...disposers]) off();
}
