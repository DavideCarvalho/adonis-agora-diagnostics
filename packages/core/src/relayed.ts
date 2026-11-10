import { capability } from './capability.js';
import { globalSlot } from './global-slot.js';

/**
 * Envelopes currently being re-emitted by a relay (Redis, queue), i.e. copies of an event that was
 * emitted in ANOTHER process. Delivering transports read it to deliver only at the origin: the
 * process that called `emit` hands each `(listener, event)` pair to the transport once, and a
 * relayed copy of the same event must not be handed over again.
 *
 * Held on a cross-copy-stable global slot so relays and listener dispatch agree even when more
 * than one copy of this package is loaded.
 */
const RELAYED = globalSlot<WeakSet<object>>(
  capability('diagnostics', 'relayed'),
  () => new WeakSet<object>(),
);

/** Publish `env` on the local bus as a relayed copy: listener dispatch sees it as non-origin. */
export function publishRelayed(env: object, publish: () => void): void {
  RELAYED.add(env);
  try {
    publish();
  } finally {
    RELAYED.delete(env);
  }
}

/** Whether `env` is a relayed copy currently being re-emitted (not emitted in this process). */
export function isRelayed(env: object): boolean {
  return RELAYED.has(env);
}
