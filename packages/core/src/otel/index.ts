import { type BridgeOptions, DiagnosticsOtelBridge } from './bridge.js';

export type { BridgeOptions } from './bridge.js';
export { DiagnosticsOtelBridge } from './bridge.js';
export {
  clearTraceparentSlot,
  otelTraceparent,
  publishTraceparentSlot,
  TRACEPARENT_SLOT,
} from './traceparent.js';

/**
 * The process-wide bridge instance used by the module-level {@link start} /
 * {@link stop} helpers (and the AdonisJS provider). `null` until `start`.
 */
let singleton: DiagnosticsOtelBridge | null = null;

/**
 * Activate the bridge: subscribe to all agora channels, begin reconstructing
 * OTel spans from `trace()` activity, and publish the global traceparent slot.
 * Idempotent — a second call with no `stop` in between is a no-op. With no OTel
 * SDK registered every produced span is a no-op, so this is safe to call always.
 */
export function start(opts: BridgeOptions = {}): DiagnosticsOtelBridge {
  if (singleton !== null) return singleton;
  singleton = new DiagnosticsOtelBridge(opts);
  singleton.start();
  return singleton;
}

/** Tear down the bridge started by {@link start}: unsubscribe + clear the slot. */
export function stop(): void {
  if (singleton === null) return;
  singleton.stop();
  singleton = null;
}
