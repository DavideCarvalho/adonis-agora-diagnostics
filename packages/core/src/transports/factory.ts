import type { ApplicationService } from '@adonisjs/core/types';
import type {
  DurableDiagnosticsModule,
  DurableTransportConfig,
  ListenerDelivery,
  ListenerDeliveryTransport,
  ListenerInvoker,
} from '../delivery.js';
import type { ChannelSelection } from '../relay.js';
import type { DiagnosticsListenerPayload } from './diagnostics_listener_job.js';
import type { DiagnosticsEventEnvelope } from './queue.js';
import type { RedisLike } from './redis.js';

/**
 * Runtime context a {@link TransportProvider} receives when the diagnostics provider starts the
 * configured transport at boot.
 */
export interface TransportContext {
  /** The booted application — used to resolve the logger, connections, etc. */
  app: ApplicationService;
  /** Which local channels to forward across processes (libs/channels/all). */
  forward: ChannelSelection;
  /** Unique id for THIS process, for echo suppression. */
  nodeId?: string;
  /**
   * The libs that have listeners in this process. A broadcasting transport relays them on top of
   * `forward`, so the listeners run in every process.
   */
  listeners?: ChannelSelection;
  /** Runs a registered listener in this process (for delivering transports). */
  invoke?: ListenerInvoker;
  /** Ids of the listeners registered in this process at boot. */
  listenerIds?: readonly string[];
}

/**
 * What a started transport hands back: a `stop` for shutdown and, for a delivering transport, a
 * `deliver` that takes over listener execution. See {@link ListenerDeliveryTransport}.
 */
export interface TransportHandle {
  stop?(): void | Promise<void>;
  deliver?(deliveries: readonly ListenerDelivery[]): void | Promise<void>;
}

/**
 * A configured cross-process transport: a thunk the diagnostics provider calls at boot to start the
 * relay, returning a teardown removed on shutdown. Each provider lazily imports its peer dependency
 * (`@adonisjs/redis`, `@adonisjs/queue`) inside the thunk, so the driver is only loaded when it is
 * actually selected — keeping those packages optional.
 */
export type TransportProvider = (ctx: TransportContext) => Promise<(() => void) | TransportHandle>;

/** Options for the Redis pub/sub transport. */
export interface RedisTransportConfig {
  /** `@adonisjs/redis` connection name to relay over. Defaults to the default connection. */
  connection?: string;
  /** Redis channel to relay on. Default `agora:diagnostics:relay`. */
  redisChannel?: string;
}

/** Options for the `@adonisjs/queue` transport. */
export interface QueueTransportConfig {
  /**
   * `@adonisjs/queue` queue name to dispatch the relay job onto. A worker must process this queue —
   * `queue` is a FLAG on `queue:work`, not a positional argument, so it is
   * `node ace queue:work --queue={queue}`. Omit to use the job's default queue (`default`).
   */
  queue?: string;
  /** How many times a listener job is retried after its handler throws. Default `3`. */
  retries?: number;
}

export type { DurableTransportConfig };

const DURABLE_MODULE = '@adonis-agora/durable/diagnostics';
let loadDurable: () => Promise<DurableDiagnosticsModule> = () =>
  import(/* @vite-ignore */ DURABLE_MODULE) as Promise<DurableDiagnosticsModule>;

/** Replace how `transports.durable()` loads `@adonis-agora/durable/diagnostics`. For tests. */
export function setDurableModuleLoader(
  loader: (() => Promise<DurableDiagnosticsModule>) | null,
): void {
  loadDurable =
    loader ??
    (() => import(/* @vite-ignore */ DURABLE_MODULE) as Promise<DurableDiagnosticsModule>);
}

function isMissingDurable(error: unknown): 'missing' | 'outdated' | null {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  const text = typeof message === 'string' ? message : '';
  if (!text.includes('@adonis-agora/durable')) return null;
  if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return 'outdated';
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return 'missing';
  return null;
}

export const DURABLE_NOT_INSTALLED =
  '`transports.durable()` requires @adonis-agora/durable. Install it and run `node ace configure @adonis-agora/durable`, or pick another transport.';
export const DURABLE_OUTDATED =
  '`transports.durable()` requires a version of @adonis-agora/durable that exports `@adonis-agora/durable/diagnostics`. Upgrade @adonis-agora/durable, or pick another transport.';
export const DURABLE_NOT_CONFIGURED =
  '`transports.durable()` requires @adonis-agora/durable to be configured: no durable engine is bound in the container. Run `node ace configure @adonis-agora/durable` and register its provider, or pick another transport.';

/** Spread the channel selection onto a relay options object, honoring `exactOptionalPropertyTypes`. */
/** `forward` plus the libs that have listeners. */
function mergeSelection(forward: ChannelSelection, listeners?: ChannelSelection): ChannelSelection {
  if (!listeners?.libs?.length || forward.all) return forward;
  const libs = [...new Set([...(forward.libs ?? []), ...listeners.libs])];
  return { ...forward, libs };
}

function selection(forward: ChannelSelection) {
  return {
    ...(forward.libs !== undefined ? { libs: forward.libs } : {}),
    ...(forward.channels !== undefined ? { channels: forward.channels } : {}),
    ...(forward.all !== undefined ? { all: forward.all } : {}),
  };
}

/**
 * The transport factory namespace used in `config/diagnostics.ts`:
 *
 * ```ts
 * import { defineConfig, transports } from '@adonis-agora/diagnostics'
 *
 * export default defineConfig({
 *   default: 'redis',
 *   forward: { libs: ['resilience', 'durable'] },
 *   transports: {
 *     redis: transports.redis({ connection: 'main' }),
 *     queue: transports.queue({ queue: 'diagnostics' }),
 *   },
 * })
 * ```
 *
 * Each factory returns a {@link TransportProvider} — a lazy thunk. Calling it in the config file
 * costs nothing; the peer dependency is only imported when the provider starts the selected
 * transport at boot.
 */
export const transports = {
  /** Relay diagnostics events across processes over `@adonisjs/redis` pub/sub. */
  redis(config: RedisTransportConfig = {}): TransportProvider {
    return async (ctx) => {
      const redisService = (await import('@adonisjs/redis/services/main')).default;
      const { createDiagnosticsRedisRelay, settle } = await import('./redis.js');

      const connection = config.connection
        ? redisService.connection(
            config.connection as Parameters<typeof redisService.connection>[0],
          )
        : redisService.connection();
      // The raw ioredis client behind the AdonisJS connection satisfies RedisLike.
      const pub = (connection as unknown as { ioConnection: RedisLike }).ioConnection;
      const sub = (pub as unknown as { duplicate(): RedisLike }).duplicate();

      const stop = createDiagnosticsRedisRelay({
        pub,
        sub,
        ...selection(mergeSelection(ctx.forward, ctx.listeners)),
        ...(config.redisChannel !== undefined ? { redisChannel: config.redisChannel } : {}),
        ...(ctx.nodeId !== undefined ? { nodeId: ctx.nodeId } : {}),
      });

      // The subscriber is a dedicated `duplicate()` connection created and owned
      // here (not tracked by `@adonisjs/redis`), so the relay's own cleanup only
      // unsubscribes it. Close it on teardown too, otherwise the open socket keeps
      // the process alive and graceful shutdown (and test runs) hang forever.
      // A ready connection gets QUIT, queued after the UNSUBSCRIBE above; one that
      // is still connecting or reconnecting is disconnected outright so it stops
      // retrying. Commands left pending then reject, and every one is caught.
      return () => {
        stop();
        const client = sub as unknown as {
          status?: string;
          quit?: () => unknown;
          disconnect?: () => void;
        };
        try {
          if (client.status === 'ready' && typeof client.quit === 'function') {
            settle(client.quit());
          } else {
            client.disconnect?.();
          }
        } catch {
          // best-effort teardown — never throw out of a shutdown hook
        }
      };
    };
  },

  /**
   * Run listeners through `@adonisjs/queue`: one job per `(listener, event)`, retried when the
   * handler throws. Also relays the `forward` channels onto a worker's local bus.
   */
  queue(config: QueueTransportConfig = {}): TransportProvider {
    return async (ctx) => {
      const { Locator } = await import('@adonisjs/queue');
      const { default: DiagnosticsEventJob } = await import('./diagnostics_event_job.js');
      const { default: DiagnosticsListenerJob } = await import('./diagnostics_listener_job.js');
      const { createDiagnosticsQueueRelay } = await import('./queue.js');
      const logger = await ctx.app.container.make('logger');

      // Ensure a worker in this process (or one sharing this registry) can resolve the jobs by name.
      const jobName = DiagnosticsEventJob.options.name ?? 'agora.diagnostics.event';
      Locator.register(jobName, DiagnosticsEventJob);
      DiagnosticsListenerJob.options = {
        ...DiagnosticsListenerJob.options,
        maxRetries: config.retries ?? 3,
      };
      Locator.register(DiagnosticsListenerJob.options.name, DiagnosticsListenerJob);

      const queueName = config.queue;
      const onQueue = <T extends { toQueue(name: string): T }>(dispatcher: T): T =>
        queueName ? dispatcher.toQueue(queueName) : dispatcher;
      const job = {
        dispatch(payload: DiagnosticsEventEnvelope) {
          return onQueue(DiagnosticsEventJob.dispatch(payload));
        },
        dispatchMany(payloads: DiagnosticsEventEnvelope[]) {
          return onQueue(DiagnosticsEventJob.dispatchMany(payloads));
        },
      };

      const stopRelay = createDiagnosticsQueueRelay({
        job,
        ...selection(ctx.forward),
        ...(ctx.nodeId !== undefined ? { nodeId: ctx.nodeId } : {}),
        onDispatchError: (error) =>
          logger.error({ err: error }, 'failed to relay diagnostics event to queue'),
      });

      const handle: ListenerDeliveryTransport = {
        async deliver(deliveries) {
          const payloads: DiagnosticsListenerPayload[] = deliveries.map((delivery) => ({
            listenerId: delivery.listenerId,
            env: delivery.envelope,
          }));
          if (payloads.length === 1) {
            await onQueue(
              DiagnosticsListenerJob.dispatch(payloads[0] as DiagnosticsListenerPayload),
            );
          } else {
            await onQueue(DiagnosticsListenerJob.dispatchMany(payloads));
          }
        },
        stop: stopRelay,
      };
      return handle;
    };
  },

  /**
   * Run listeners as durable runs of `@adonis-agora/durable`: one run per `(listener, event)`,
   * retried with backoff and idempotent per event id. `@adonis-agora/durable` is imported only when
   * this transport is the selected `default`; boot fails with a clear error when it is missing or
   * not configured.
   */
  durable(config: DurableTransportConfig = {}): TransportProvider {
    return async (ctx) => {
      let durable: DurableDiagnosticsModule;
      try {
        durable = await loadDurable();
      } catch (error) {
        const missing = isMissingDurable(error);
        if (missing === 'missing') throw new Error(DURABLE_NOT_INSTALLED, { cause: error });
        if (missing === 'outdated') throw new Error(DURABLE_OUTDATED, { cause: error });
        throw error;
      }
      if (
        typeof durable?.isConfigured !== 'function' ||
        typeof durable.createDeliveryTransport !== 'function'
      ) {
        throw new Error(DURABLE_OUTDATED);
      }
      if (!(await durable.isConfigured(ctx.app))) throw new Error(DURABLE_NOT_CONFIGURED);
      if (!ctx.invoke) {
        throw new Error('`transports.durable()` must be started by the diagnostics provider');
      }
      return durable.createDeliveryTransport(
        {
          app: ctx.app,
          nodeId: ctx.nodeId ?? 'unknown',
          invoke: ctx.invoke,
          listenerIds: ctx.listenerIds ?? [],
        },
        config,
      );
    };
  },
};
