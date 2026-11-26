import type { ApplicationService } from '@adonisjs/core/types';
import type { ChannelSelection } from '../relay.js';
import type { DiagnosticsEventJobPayload } from './queue.js';
import type { RedisLike } from './redis.js';
import type { RelaySecret } from './relay_auth.js';

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
}

/**
 * A configured cross-process transport: a thunk the diagnostics provider calls at boot to start the
 * relay, returning a teardown removed on shutdown. Each provider lazily imports its peer dependency
 * (`@adonisjs/redis`, `@adonisjs/queue`) inside the thunk, so the driver is only loaded when it is
 * actually selected — keeping those packages optional.
 */
export type TransportProvider = (ctx: TransportContext) => Promise<() => void>;

/** How the transports authenticate their messages (shared by both). */
export interface TransportAuthConfig {
  /**
   * A secret every relaying process shares (at least 16 characters). Every message carries an HMAC
   * under it. Default: a key derived from the app's `APP_KEY` (`config/app.ts` → `appKey`, else
   * `process.env.APP_KEY`), which every process of the same app shares; set `secret` when processes
   * of different apps relay to each other. Without either, the transport refuses to start.
   */
  secret?: RelaySecret;
  /** How many new channels relayed events may create in each process. Default 256. */
  maxRemoteChannels?: number;
}

/** Options for the Redis pub/sub transport. */
export interface RedisTransportConfig extends TransportAuthConfig {
  /** `@adonisjs/redis` connection name to relay over. Defaults to the default connection. */
  connection?: string;
  /** Redis channel to relay on. Default `agora:diagnostics:relay`. */
  redisChannel?: string;
}

/** Options for the `@adonisjs/queue` transport. */
export interface QueueTransportConfig extends TransportAuthConfig {
  /** How long a dispatched job stays valid, in milliseconds. Default 24 hours. */
  maxJobAgeMs?: number;
  /**
   * `@adonisjs/queue` queue name to dispatch the relay job onto. A worker must process this queue —
   * `queue` is a FLAG on `queue:work`, not a positional argument, so it is
   * `node ace queue:work --queue={queue}`. Omit to use the job's default queue (`default`).
   */
  queue?: string;
}

/** The app's key: `config/app.ts` → `appKey`, else `process.env.APP_KEY`. */
function appKeyOf(app: ApplicationService): RelaySecret | undefined {
  try {
    const configured = app.config.get<unknown>('app.appKey', undefined);
    if (typeof configured === 'string' && configured !== '') return configured;
    if (
      configured &&
      typeof configured === 'object' &&
      typeof (configured as { release?: unknown }).release === 'function'
    ) {
      return configured as { release(): string };
    }
  } catch {
    // no app config: fall back to the environment
  }
  const env = process.env.APP_KEY;
  return env !== undefined && env !== '' ? env : undefined;
}

/** The auth options of a relay: the transport's `secret`, the app key, the channel bound. */
function auth(config: TransportAuthConfig, app: ApplicationService) {
  const appKey = appKeyOf(app);
  return {
    ...(config.secret !== undefined ? { secret: config.secret } : {}),
    ...(appKey !== undefined ? { appKey } : {}),
    ...(config.maxRemoteChannels !== undefined
      ? { maxRemoteChannels: config.maxRemoteChannels }
      : {}),
  };
}

/** Spread the channel selection onto a relay options object, honoring `exactOptionalPropertyTypes`. */
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
      const { createDiagnosticsRedisRelay } = await import('./redis.js');
      const { relayKey } = await import('./relay_auth.js');
      const options = auth(config, ctx.app);
      // Fail before opening a subscriber connection: no key, no relay.
      relayKey(options, 'check', 'the Redis transport');
      const logger = await ctx.app.container.make('logger');

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
        ...selection(ctx.forward),
        ...(config.redisChannel !== undefined ? { redisChannel: config.redisChannel } : {}),
        ...(ctx.nodeId !== undefined ? { nodeId: ctx.nodeId } : {}),
        ...options,
        onReject: (reason) =>
          logger.warn(`[@adonis-agora/diagnostics] dropped a relayed message (${reason})`),
      });

      // The subscriber is a dedicated `duplicate()` connection created and owned
      // here (not tracked by `@adonisjs/redis`), so the relay's own cleanup only
      // unsubscribes it. Close it on teardown too, otherwise the open socket keeps
      // the process alive and graceful shutdown (and test runs) hang forever.
      return () => {
        stop();
        try {
          (sub as unknown as { disconnect?: () => void }).disconnect?.();
        } catch {
          // best-effort teardown — never throw out of a shutdown hook
        }
      };
    };
  },

  /** Relay diagnostics events across processes over `@adonisjs/queue`. */
  queue(config: QueueTransportConfig = {}): TransportProvider {
    return async (ctx) => {
      const { Locator } = await import('@adonisjs/queue');
      const { default: DiagnosticsEventJob } = await import('./diagnostics_event_job.js');
      const { createDiagnosticsQueueRelay } = await import('./queue.js');
      const logger = await ctx.app.container.make('logger');

      // Ensure a worker in this process (or one sharing this registry) can resolve the job by name.
      const jobName = DiagnosticsEventJob.options.name ?? 'agora.diagnostics.event';
      Locator.register(jobName, DiagnosticsEventJob);

      const queueName = config.queue;
      const job = {
        dispatch(payload: DiagnosticsEventJobPayload) {
          const dispatcher = DiagnosticsEventJob.dispatch(payload);
          return queueName ? dispatcher.toQueue(queueName) : dispatcher;
        },
        dispatchMany(payloads: DiagnosticsEventJobPayload[]) {
          const dispatcher = DiagnosticsEventJob.dispatchMany(payloads);
          return queueName ? dispatcher.toQueue(queueName) : dispatcher;
        },
      };

      return createDiagnosticsQueueRelay({
        job,
        ...selection(ctx.forward),
        ...(ctx.nodeId !== undefined ? { nodeId: ctx.nodeId } : {}),
        ...auth(config, ctx.app),
        ...(config.maxJobAgeMs !== undefined ? { maxJobAgeMs: config.maxJobAgeMs } : {}),
        onDispatchError: (error) =>
          logger.error({ err: error }, 'failed to relay diagnostics event to queue'),
        onReject: (reason) =>
          logger.warn(`[@adonis-agora/diagnostics] refused a relayed job (${reason})`),
      });
    };
  },
};
