import type { ChannelSelection } from './relay.js';
import type { DiagnosticsRole } from './role.js';
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
  /**
   * Which half of a split deployment this process is.
   *
   * - `'all'` (default) — one process emits, forwards, consumes and runs listeners.
   * - `'api'` — emit and forward through the `default` transport, and hand listener work to it
   *   (`queue`, `durable`); never consume what other processes forward, never run a listener here.
   *   With `redis` this process publishes and does not subscribe.
   * - `'worker'` — consume and run listeners. Diagnostics mounts no HTTP route, so a worker does
   *   everything `'all'` does.
   *
   * Splitting needs a transport between the halves, so `'api'`/`'worker'` without a `default`
   * transport are refused at boot.
   */
  role?: DiagnosticsRole;
  /** Which local channels to forward across processes: `libs`, exact `channels`, or `all`. */
  forward?: ChannelSelection;
  /** Unique id for THIS process, for echo suppression. Default a random id per process. */
  nodeId?: string;
  /**
   * Directory (relative to the app root) whose modules default-export listener classes with
   * `@OnDiagnostic` methods. Default `app/listeners/diagnostics`; `false` turns discovery off.
   */
  listenersPath?: string | false;
  /** Named cross-process transports, built with the {@link transports} factory. */
  transports?: Record<string, TransportProvider>;
  /**
   * Keep the last events of this process in memory, for `recentEvents()` and the
   * `diagnostics_list_recent_events` dev tool. It subscribes to every channel, so `emit` always
   * builds its envelope while it runs.
   *
   * Default: on outside production when `@adonis-agora/agent`'s dev tools are installed, off
   * otherwise. `true` or `{ size }` turns it on everywhere (default size 500); `false` turns it off.
   */
  recent?: boolean | { size?: number };
  /**
   * Developer tools on `@adonis-agora/agent`'s dev MCP endpoint (`/mcp/agora`), gated by its
   * `devTools.authorize`. Default `true`; `false` leaves them out (and the default recent-events
   * buffer with them).
   */
  devTools?: boolean;
}

/** Identity helper giving `config/diagnostics.ts` full type-checking. */
export function defineConfig(config: DiagnosticsConfig): DiagnosticsConfig {
  return config;
}

export type { DiagnosticsRole } from './role.js';
export type {
  DurableTransportConfig,
  QueueTransportConfig,
  RedisTransportConfig,
  TransportContext,
  TransportHandle,
  TransportProvider,
} from './transports/factory.js';
export { transports };
