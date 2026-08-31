import type { ChannelSelection } from './relay.js';
import { type TransportProvider, transports } from './transports/factory.js';

/**
 * Shape of `config/diagnostics.ts`. Diagnostics is local-only by default — `emit`/`trace` work with
 * zero config. Pick a `default` transport to fan events out across processes, and list the
 * transports you use under `transports`, built with the {@link transports} factory.
 */
export interface DiagnosticsConfig {
  /**
   * Auto-bridge `trace()` spans to OpenTelemetry when an OTel SDK is resolvable. Default `true`; set
   * `false` to keep the `emit`/`trace` hot path OTel-free even when an SDK is present.
   */
  otel?: boolean;
  /**
   * Name of the transport (a key of `transports`) whose relay starts at boot. Omit for local-only
   * diagnostics (no cross-process fan-out).
   */
  default?: string;
  /** Which local channels to forward across processes: `libs`, exact `channels`, or `all`. */
  forward?: ChannelSelection;
  /** Unique id for THIS process, for echo suppression. Default a random id per process. */
  nodeId?: string;
  /** Named cross-process transports, built with the {@link transports} factory. */
  transports?: Record<string, TransportProvider>;
}

/** Identity helper giving `config/diagnostics.ts` full type-checking. */
export function defineConfig(config: DiagnosticsConfig): DiagnosticsConfig {
  return config;
}

export type {
  QueueTransportConfig,
  RedisTransportConfig,
  TransportContext,
  TransportProvider,
} from './transports/factory.js';
export { transports };
