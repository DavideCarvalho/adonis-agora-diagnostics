import { randomUUID } from 'node:crypto';
import type { ApplicationService } from '@adonisjs/core/types';
import type { DiagnosticsConfig } from '../src/define_config.js';
import { DEV_TOOLS_BINDING } from '../src/dev_tools/contract.js';
import { registerDiagnosticsDevTools } from '../src/dev_tools/tools.js';
import { discoverListeners } from '../src/listener_discovery.js';
import {
  bindListenerInvoker,
  createListenerInvoker,
  startListenerDispatch,
} from '../src/listener_dispatch.js';
import { loadListeners, registeredListeners } from '../src/listeners.js';
import { DEFAULT_RECENT_SIZE, startRecentEvents, stopRecentEvents } from '../src/recent.js';
import { assertRoleHasTransport, resolveRole } from '../src/role.js';
import { unsubscribeAll } from '../src/subscriber.js';
import type { TransportHandle } from '../src/transports/factory.js';

/** Where listener classes are discovered by default, relative to the app root. */
export const DEFAULT_LISTENERS_PATH = 'app/listeners/diagnostics';

/**
 * Wires `@adonis-agora/diagnostics` into the AdonisJS application.
 *
 * 1. **OpenTelemetry auto-bridge** (boot) — when `@opentelemetry/api` is resolvable, load the OTel
 *    bridge and start it. Opt out with `otel: false` in `config/diagnostics.ts`.
 * 2. **Listeners** (ready, after preload files ran) — discover `@OnDiagnostic` classes in the
 *    listeners directory, resolve the lazy `[() => import(...), 'method']` references registered in
 *    preloads, and subscribe them to the bus.
 * 3. **Transport** (ready) — start the transport named by `config.default`. A delivering transport
 *    (`queue`, `durable`) takes over listener execution; otherwise listeners run in-process.
 *    `config.role: 'api'` forwards and delivers but never consumes: no relay subscription, no
 *    re-emitter, no process invoker, and listeners never run here.
 * 4. **Dev tools** (boot) — register the diagnostics tools on `@adonis-agora/agent`'s dev MCP
 *    endpoint when it is installed, and start the recent-events buffer (see `recent`).
 * 5. **Lifecycle** (shutdown) — stop the transport and every subscription.
 *
 * The trace-id auto-fill is wired from the other side: `@adonis-agora/context`'s provider
 * soft-detects this package at boot and registers its accessor via `setContextAccessor`.
 */
export default class DiagnosticsProvider {
  #stopOtel: (() => void) | null = null;
  #transport: TransportHandle | null = null;
  #stopDispatch: (() => void) | null = null;
  #unbindInvoker: (() => void) | null = null;

  constructor(protected app: ApplicationService) {}

  async boot() {
    const config = this.app.config.get<DiagnosticsConfig | undefined>('diagnostics', {}) ?? {};
    await this.#bootDevTools(config);
    if (config.otel === false) return;
    // Dynamic so the @opentelemetry/api-importing bridge never loads without an
    // OTel SDK present — keeping emit/trace OTel-free by default. Only the IMPORT
    // is allowed to fail (module-not-found = OTel absent); a real bug inside
    // start() must surface, not be silently swallowed as "OTel not installed".
    let otel: typeof import('../src/otel/index.js');
    try {
      otel = await import('../src/otel/index.js');
    } catch {
      return;
    }
    otel.start();
    this.#stopOtel = otel.stop;
  }

  /**
   * Start the recent-events buffer (on outside production with the dev tools hub, or as `recent`
   * says) and register the dev tools.
   */
  async #bootDevTools(config: DiagnosticsConfig) {
    const container = this.app.container as { hasBinding?: (binding: string) => boolean };
    const hub =
      config.devTools !== false &&
      typeof container.hasBinding === 'function' &&
      container.hasBinding(DEV_TOOLS_BINDING);
    const recent = config.recent;
    if (recent === true || (typeof recent === 'object' && recent !== null)) {
      startRecentEvents(
        typeof recent === 'object' ? (recent.size ?? DEFAULT_RECENT_SIZE) : DEFAULT_RECENT_SIZE,
      );
    } else if (recent === undefined && hub && !this.app.inProduction) {
      startRecentEvents();
    }
    if (!hub) return;
    const outcome = await registerDiagnosticsDevTools(this.app.container as never, {
      config: () => this.app.config.get<DiagnosticsConfig>('diagnostics', {}) ?? {},
    });
    if (outcome === 'unsupported' || outcome === 'failed') {
      const logger = (await this.app.container.make('logger').catch(() => undefined)) as
        | { debug(msg: string): void }
        | undefined;
      logger?.debug(
        outcome === 'unsupported'
          ? '[@adonis-agora/diagnostics] dev tools not registered: the installed @adonis-agora/agent cannot gate libs without a console (needs devTools.authorize support)'
          : '[@adonis-agora/diagnostics] dev tools could not be registered',
      );
    }
  }

  async ready() {
    const config = this.app.config.get<DiagnosticsConfig>('diagnostics', {});
    const role = resolveRole(config);
    assertRoleHasTransport(role, config.default);
    const logger = await this.app.container.make('logger');

    const listenersPath = config.listenersPath ?? DEFAULT_LISTENERS_PATH;
    if (listenersPath !== false) {
      await discoverListeners(this.app.makePath(), this.app.makePath(listenersPath), (message) =>
        logger.warn(`@adonis-agora/diagnostics: ${message}`),
      );
    }
    await loadListeners((error) =>
      logger.error({ err: error }, 'failed to load a diagnostics listener'),
    );

    const invoke = createListenerInvoker((target) =>
      this.app.container.make(target as unknown as new () => object),
    );
    // The process invoker is what a queue worker runs listener jobs with. An 'api' process never
    // runs one, so it publishes none (a delivering transport still gets `invoke` in its context).
    if (role !== 'api') this.#unbindInvoker = bindListenerInvoker(invoke);

    const name = config.default;
    if (name) {
      const provider = config.transports?.[name];
      if (!provider) {
        throw new Error(
          `@adonis-agora/diagnostics: config.default is "${name}", but config.transports.${name} is not defined`,
        );
      }
      const listeners = registeredListeners();
      const started = await provider({
        app: this.app,
        forward: config.forward ?? {},
        role,
        nodeId: config.nodeId ?? randomUUID(),
        listeners: { libs: [...new Set(listeners.map((listener) => listener.lib))] },
        listenerIds: listeners.map((listener) => listener.id),
        invoke,
      });
      this.#transport = typeof started === 'function' ? { stop: started } : started;
    }

    const deliver = this.#transport?.deliver?.bind(this.#transport);
    // Without a delivering transport, listeners run in the process that sees the event. An 'api'
    // process never runs them: a 'worker' (or 'all') process receives the event and runs them.
    if (role === 'api' && !deliver) return;
    this.#stopDispatch = startListenerDispatch({
      invoke,
      deliver,
      onListenerError: (error, listenerId, envelope) =>
        logger.error(
          { err: error, listenerId, lib: envelope.lib, event: envelope.event, id: envelope.id },
          'diagnostics listener failed',
        ),
      onDeliveryError: (error, deliveries) =>
        logger.error(
          { err: error, deliveries: deliveries.length },
          'failed to hand diagnostics events to the transport',
        ),
    });
  }

  async shutdown() {
    this.#stopDispatch?.();
    this.#stopDispatch = null;
    const transport = this.#transport;
    this.#transport = null;
    try {
      await transport?.stop?.();
    } catch {
      // best-effort teardown
    }
    this.#unbindInvoker?.();
    this.#unbindInvoker = null;
    this.#stopOtel?.();
    this.#stopOtel = null;
    stopRecentEvents();
    unsubscribeAll();
  }
}
