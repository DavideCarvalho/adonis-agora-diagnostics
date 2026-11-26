import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeHub, FakeRedis } from './fake-redis.js';

/** `@adonisjs/redis`: the app's connection is a FakeRedis on a per-test hub. */
const redis = vi.hoisted(() => ({ pub: null as unknown }));
vi.mock('@adonisjs/redis/services/main', () => ({
  default: { connection: () => ({ ioConnection: redis.pub }) },
}));

/** `@adonisjs/queue`: records each dispatch with the job name; jobs carry `payload` and `context`. */
const queue = vi.hoisted(() => {
  const calls: Array<{ job: string; payload: unknown }> = [];
  const pending = (): Promise<void> & { toQueue(): unknown } =>
    Object.assign(Promise.resolve(), { toQueue: () => pending() });
  class Job {
    static options: { name?: string } = {};
    payload: unknown;
    context: unknown;
    static dispatch(payload: unknown) {
      // biome-ignore lint/complexity/noThisInStatic: the subclass's options name the job
      calls.push({ job: this.options?.name ?? '?', payload });
      return pending();
    }
    static dispatchMany(payloads: unknown[]) {
      // biome-ignore lint/complexity/noThisInStatic: the subclass's options name the job
      for (const payload of payloads) calls.push({ job: this.options?.name ?? '?', payload });
      return pending();
    }
  }
  return { calls, Job, Locator: { register: () => {} } };
});
vi.mock('@adonisjs/queue', () => ({ Job: queue.Job, Locator: queue.Locator }));

import { join } from 'node:path';
import DiagnosticsProvider from '../providers/diagnostics_provider.js';
import { emit, getChannel } from '../src/channel.js';
import { diagnosticsDoctorChecks } from '../src/doctor/checks.js';
import { bindListenerInvoker } from '../src/listener_dispatch.js';
import { resetRegistry } from '../src/registry.js';
import { resolveRelayAuth } from '../src/transports/auto_auth.js';
import DiagnosticsEventJob from '../src/transports/diagnostics_event_job.js';
import DiagnosticsListenerJob from '../src/transports/diagnostics_listener_job.js';
import {
  type TransportContext,
  type TransportHandle,
  transportInfo,
  transports,
} from '../src/transports/factory.js';
import { createDiagnosticsQueueRelay } from '../src/transports/queue.js';
import {
  createQueueJobAuth,
  DEFAULT_MAX_JOB_AGE_MS,
  type QueueJobAuth,
  type SealedJobPayload,
} from '../src/transports/queue_auth.js';
import type { RelayCipher } from '../src/transports/relay_auth.js';
import type { DiagnosticEvent } from '../src/types.js';
import { appWith, embeddedCrypto, FakeCryptoService, operationsOf } from './fake-crypto-runtime.js';
import { TEST_RELAY_SECRET as SECRET } from './relay-wire.js';

const APP_KEY = 'this-app-key-0123456789abcdef';

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const settled = async () => {
  for (let i = 0; i < 6; i++) await nextTurn();
};

const env = (over: Partial<DiagnosticEvent> = {}): DiagnosticEvent => ({
  v: 1,
  id: 'e1',
  ts: 1,
  lib: 'agent',
  event: 'run.finished',
  payload: { n: 1 },
  ...over,
});

type Rejection = { reason: string; kind: string };
function auth(options: Parameters<typeof createQueueJobAuth>[0] = { secret: SECRET }) {
  const rejected: Rejection[] = [];
  const errors: unknown[] = [];
  const jobAuth = createQueueJobAuth(options, {
    onReject: (reason, kind) => void rejected.push({ reason, kind }),
    onError: (error) => void errors.push(error),
  });
  return { jobAuth, rejected, errors };
}

const sealOne = async (jobAuth: QueueJobAuth, kind: 'event' | 'listener', item: object) =>
  (await jobAuth.seal(kind, 'web', [item]))[0] as SealedJobPayload;

afterEach(() => {
  queue.calls.length = 0;
  resetRegistry();
  bindListenerInvoker(null);
  vi.restoreAllMocks();
});

describe('queue job authentication (secret)', () => {
  it('seals a job so nothing but the sealed message travels, and opens it', async () => {
    const { jobAuth } = auth();
    const payload = await sealOne(jobAuth, 'listener', { listenerId: 'a#b', env: env() });
    expect(Object.keys(payload)).toEqual(['sealed']);
    expect(payload.sealed.startsWith('s1\n')).toBe(true);
    const opened = await jobAuth.open('listener', payload, 'job-1');
    expect(opened?.item).toEqual({ listenerId: 'a#b', env: env() });
    expect(opened?.node).toBe('web');
  });

  it('refuses unsealed, tampered and foreign-secret jobs', async () => {
    const { jobAuth, rejected } = auth();
    expect(await jobAuth.open('listener', { listenerId: 'a#b', env: env() }, 'j1')).toBeNull();
    const payload = await sealOne(jobAuth, 'listener', { listenerId: 'a#b', env: env() });
    const tampered = { sealed: payload.sealed.replace('"a#b"', '"x#y"') };
    expect(await jobAuth.open('listener', tampered, 'j2')).toBeNull();
    const other = auth({ secret: 'another-secret-0123456789' }).jobAuth;
    expect(await jobAuth.open('listener', await sealOne(other, 'listener', {}), 'j3')).toBeNull();
    expect(rejected.map((r) => r.reason)).toEqual([
      'unsealed',
      'unauthenticated',
      'unauthenticated',
    ]);
  });

  it('does not take an event job for a listener job, or the reverse', async () => {
    const { jobAuth, rejected } = auth();
    const event = await sealOne(jobAuth, 'event', env());
    expect(await jobAuth.open('listener', event, 'j1')).toBeNull();
    const listener = await sealOne(jobAuth, 'listener', { listenerId: 'a#b', env: env() });
    expect(await jobAuth.open('event', listener, 'j2')).toBeNull();
    expect(rejected.map((r) => r.reason)).toEqual(['unauthenticated', 'unauthenticated']);
  });

  it('lets the same job be retried, and refuses its message in another job (a copy)', async () => {
    const { jobAuth, rejected } = auth();
    const payload = await sealOne(jobAuth, 'listener', { listenerId: 'a#b', env: env() });
    expect(await jobAuth.open('listener', payload, 'job-1')).not.toBeNull();
    // attempt 2, 3 of the same job: same job id, same payload
    expect(await jobAuth.open('listener', payload, 'job-1')).not.toBeNull();
    expect(await jobAuth.open('listener', payload, 'job-1')).not.toBeNull();
    expect(await jobAuth.open('listener', payload, 'job-2')).toBeNull();
    expect(rejected).toEqual([{ reason: 'replayed', kind: 'listener' }]);
  });

  it('accepts a job that waited in a backlog for hours, refuses one past maxJobAge', async () => {
    const { jobAuth, rejected } = auth();
    const payload = await sealOne(jobAuth, 'event', env());
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60 * 60_000);
    expect(await jobAuth.open('event', payload, 'j1')).not.toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(now + DEFAULT_MAX_JOB_AGE_MS + 1000);
    expect(await jobAuth.open('event', payload, 'j1')).toBeNull();
    expect(rejected.map((r) => r.reason)).toEqual(['stale']);

    const short = auth({ secret: SECRET, maxJobAgeMs: 60_000 });
    const quick = await sealOne(short.jobAuth, 'event', env());
    vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
    expect(await short.jobAuth.open('event', quick, 'j1')).toBeNull();
  });

  it('refuses to start without a mode, naming APP_KEY first', () => {
    expect(() => auth({})).toThrow(
      /^\[@adonis-agora\/diagnostics\] the queue transport needs authentication\. Set APP_KEY in this app/,
    );
    expect(() => auth({ crypto: false })).toThrow(
      /The automatic APP_KEY mode is off \(`crypto: false`\)/,
    );
    expect(() => createDiagnosticsQueueRelay({ job: { dispatch: () => {} } })).toThrow(
      /needs authentication/,
    );
  });
});

describe('queue job authentication (APP_KEY)', () => {
  it('encrypts the job with a key derived from APP_KEY; another APP_KEY cannot open it', async () => {
    const sender = auth({ appKey: APP_KEY }).jobAuth;
    const payload = await sealOne(sender, 'listener', {
      listenerId: 'a#b',
      env: env({ payload: { card: 'secret-card' } }),
    });
    expect(payload.sealed).toMatch(/^k1\n/);
    expect(payload.sealed).not.toContain('secret-card');
    expect(await auth({ appKey: APP_KEY }).jobAuth.open('listener', payload, 'j1')).toMatchObject({
      item: { listenerId: 'a#b' },
    });
    const other = auth({ appKey: 'another-app-key-0123456789abcdef' });
    expect(await other.jobAuth.open('listener', payload, 'j1')).toBeNull();
    expect(other.rejected).toEqual([{ reason: 'unauthenticated', kind: 'listener' }]);
  });

  it('keeps the queue rules: retry passes, a copy is refused, the labels are separate', async () => {
    const { jobAuth, rejected } = auth({ appKey: APP_KEY });
    const payload = await sealOne(jobAuth, 'listener', { listenerId: 'a#b', env: env() });
    expect(await jobAuth.open('listener', payload, 'job-1')).not.toBeNull();
    expect(await jobAuth.open('listener', payload, 'job-1')).not.toBeNull();
    expect(await jobAuth.open('listener', payload, 'job-2')).toBeNull();
    expect(await jobAuth.open('event', payload, 'job-3')).toBeNull();
    expect(rejected.map((r) => r.reason)).toEqual(['replayed', 'unauthenticated']);
  });

  it('refuses a short APP_KEY', () => {
    expect(() => auth({ appKey: 'short' })).toThrow(/APP_KEY of at least 16 characters/);
  });
});

describe('queue job authentication (crypto)', () => {
  it('encrypts the job (nothing readable in the backend) and opens it after a long backlog', async () => {
    const { runtime, service } = embeddedCrypto();
    await service.createKey(
      { partition: 'shop', capabilities: ['crypto:*'], actor: 't' },
      { name: 'console-diagnostics', type: 'aes256-gcm' },
    );
    const sender = auth({ crypto: { cipher: runtime.operations } }).jobAuth;
    const worker = auth({ crypto: { cipher: runtime.operations } });
    const payload = await sealOne(sender, 'listener', {
      listenerId: 'a#b',
      env: env({ payload: { card: 'secret-card' } }),
    });
    expect(payload.sealed).toMatch(/^c1\nagora:ct1:console-diagnostics:/);
    expect(payload.sealed).not.toContain('secret-card');
    // Hours later (a backlog), past the Redis relay's session-key age: still opens.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60 * 60_000);
    const opened = await worker.jobAuth.open('listener', payload, 'j1');
    expect(opened?.item).toMatchObject({ listenerId: 'a#b' });
  });

  it('works with any KMS: crypto.owns accepts its ciphertext format', async () => {
    const kms: RelayCipher = {
      encrypt: async ({ plaintext }) => ({
        ciphertext: `kms:v1:${Buffer.from(plaintext).toString('base64url')}`,
      }),
      decrypt: async ({ ciphertext }) => ({
        plaintext: Buffer.from(ciphertext.slice(7), 'base64url').toString(),
      }),
    };
    const owns = (ciphertext: string) => ciphertext.startsWith('kms:v1:');
    const { jobAuth } = auth({ crypto: { cipher: kms, key: 'relay', owns } });
    const payload = await sealOne(jobAuth, 'event', env());
    expect(await jobAuth.open('event', payload, 'j1')).not.toBeNull();
    // Without `owns`, the default agora:ct1 check refuses that format.
    const strict = auth({ crypto: { cipher: kms, key: 'relay' } });
    expect(await strict.jobAuth.seal('event', 'web', [env()])).toEqual([]);
  });
});

/** Start a transport the way the provider does, in an app with (or without) an APP_KEY. */
async function start(
  provider: ReturnType<typeof transports.queue>,
  appKey?: string,
  runtime?: unknown,
): Promise<{ handle: TransportHandle; logs: string[] }> {
  const logs: string[] = [];
  const logger = {
    info: (msg: string) => void logs.push(`info ${msg}`),
    warn: (obj: unknown, msg?: string) => void logs.push(`warn ${msg ?? String(obj)}`),
    error: (obj: unknown, msg?: string) => void logs.push(`error ${msg ?? String(obj)}`),
  };
  const ctx = {
    app: {
      ...appWith(runtime, logger),
      config: {
        get: (key: string, fallback?: unknown) =>
          key === 'app.appKey' && appKey !== undefined ? { release: () => appKey } : fallback,
      },
    },
    forward: { libs: ['agent'] },
    nodeId: 'web',
    listeners: { libs: ['agent'] },
    invoke: async () => {},
  } as unknown as TransportContext;
  const started = await provider(ctx);
  const handle = typeof started === 'function' ? { stop: started } : started;
  stops.push(handle);
  return { handle, logs };
}
const stops: TransportHandle[] = [];
afterEach(async () => {
  for (const handle of stops.splice(0)) await handle.stop?.();
});

const workerJob = <T extends { payload: unknown; context: unknown; execute(): Promise<void> }>(
  JobClass: new () => T,
  payload: unknown,
  jobId: string,
) => Object.assign(new JobClass(), { payload, context: { jobId, attempt: 1 } });

describe("automatic mode: the app's APP_KEY", () => {
  const savedEnv = process.env.APP_KEY;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.APP_KEY;
    else process.env.APP_KEY = savedEnv;
  });

  it('needs no configuration and logs the mode', async () => {
    const { logs } = await start(transports.queue(), APP_KEY);
    expect(logs).toEqual(['info [@adonis-agora/diagnostics] queue jobs: app key (auto)']);
  });

  it('relays events and runs listeners between processes of the same app', async () => {
    const { handle } = await start(transports.queue(), APP_KEY);
    emit('agent', 'run.finished', { n: 7 });
    await handle.deliver?.([{ listenerId: 'Track#handle', envelope: env({ payload: { n: 8 } }) }]);
    await settled();
    const event = queue.calls.find((c) => c.job === 'agora.diagnostics.event');
    const listener = queue.calls.find((c) => c.job === 'agora.diagnostics.listener');
    expect((event?.payload as SealedJobPayload | undefined)?.sealed).toMatch(/^k1\n/);
    expect((listener?.payload as SealedJobPayload | undefined)?.sealed).toMatch(/^k1\n/);

    // An event job from another process of the same app (same APP_KEY, another node).
    const got: unknown[] = [];
    getChannel('agent', 'run.finished').subscribe((m) => void got.push(m));
    const hooks = { onReject: () => {}, onError: () => {} };
    const forwarded = await Promise.resolve(
      createQueueJobAuth({ appKey: APP_KEY }, hooks).seal('event', 'other', [
        env({ payload: { n: 9 } }),
      ]),
    );
    await workerJob(DiagnosticsEventJob, forwarded[0], 'job-e').execute();
    expect(got.map((m) => (m as DiagnosticEvent).payload)).toEqual([{ n: 9 }]);
    // ...and one from an app with another APP_KEY is refused.
    const foreign = await Promise.resolve(
      createQueueJobAuth({ appKey: 'another-app-key-0123456789abcdef' }, hooks).seal(
        'event',
        'other',
        [env({ payload: { n: 10 } })],
      ),
    );
    await workerJob(DiagnosticsEventJob, foreign[0], 'job-f').execute();
    expect(got).toHaveLength(1);

    const ran: unknown[] = [];
    bindListenerInvoker(
      async (listenerId, delivered) => void ran.push([listenerId, delivered.payload]),
    );
    await workerJob(DiagnosticsListenerJob, listener?.payload, 'job-l').execute();
    expect(ran).toEqual([['Track#handle', { n: 8 }]]);
    await workerJob(DiagnosticsListenerJob, listener?.payload, 'job-copy').execute();
    expect(ran).toHaveLength(1);
    await workerJob(
      DiagnosticsListenerJob,
      { listenerId: 'Track#handle', env: env() },
      'job-forged',
    ).execute();
    expect(ran).toHaveLength(1);
  });

  it('takes appKey from config as a string or an AdonisJS Secret, and never shows it', async () => {
    const { Secret } = await import('@adonisjs/core/helpers');
    delete process.env.APP_KEY;
    const hooks = { onReject: () => {}, onError: () => {} };
    for (const value of [APP_KEY, new Secret(APP_KEY)]) {
      const app = { config: { get: (key: string) => (key === 'app.appKey' ? value : undefined) } };
      const resolved = await resolveRelayAuth(app, {}, 'the queue transport');
      expect(resolved.description).toBe('app key (auto)');
      // The same derived key whichever form config/app.ts uses.
      const sealed = await Promise.resolve(
        createQueueJobAuth(resolved.options, hooks).seal('event', 'other', [env()]),
      );
      expect(
        await createQueueJobAuth({ appKey: APP_KEY }, hooks).open('event', sealed[0], 'j1'),
      ).not.toBeNull();
      expect(JSON.stringify(sealed)).not.toContain(APP_KEY);
    }
    // Nothing logged, printed or reported carries it.
    const logs: string[] = [];
    const logger = {
      info: (m: string) => void logs.push(m),
      warn: (_o: unknown, m?: string) => void logs.push(m ?? ''),
      error: (_o: unknown, m?: string) => void logs.push(m ?? ''),
    };
    const ctx = {
      app: {
        ...appWith(undefined, logger),
        config: { get: (key: string) => (key === 'app.appKey' ? new Secret(APP_KEY) : undefined) },
      },
      forward: { libs: ['agent'] },
      nodeId: 'web',
    } as unknown as TransportContext;
    const provider = transports.queue();
    const handle = await provider(ctx);
    stops.push(typeof handle === 'function' ? { stop: handle } : handle);
    expect(logs.join('\n')).not.toContain(APP_KEY);
    expect(JSON.stringify(transportInfo(provider))).not.toContain(APP_KEY);
    expect(JSON.stringify(transportInfo(transports.redis({ appKey: APP_KEY })))).not.toContain(
      APP_KEY,
    );
    const doctor = await diagnosticsDoctorChecks()
      .find((c) => c.id === 'diagnostics.relay-auth')
      ?.run({
        ...ctx.app,
        config: {
          get: (key: string) =>
            key === 'diagnostics'
              ? { default: 'q', transports: { q: provider } }
              : key === 'app.appKey'
                ? new Secret(APP_KEY)
                : undefined,
        },
      } as never);
    expect(doctor).toMatchObject({
      status: 'ok',
      message: 'default transport "q" (queue): app key (auto)',
    });
    expect(JSON.stringify(doctor)).not.toContain(APP_KEY);
  });

  it('works for the Redis relay too, and reads APP_KEY from the environment as a fallback', async () => {
    const hub = new FakeHub();
    redis.pub = Object.assign(new FakeRedis(hub), { duplicate: () => new FakeRedis(hub) });
    process.env.APP_KEY = APP_KEY;
    const { logs } = await start(transports.redis());
    expect(logs).toContain('info [@adonis-agora/diagnostics] redis relay: app key (auto)');
  });

  it('never picks @adonis-agora/crypto by itself, even when it is booted', async () => {
    const { runtime, service } = embeddedCrypto('shop');
    const { logs } = await start(transports.queue(), APP_KEY, runtime);
    expect(logs).toEqual(['info [@adonis-agora/diagnostics] queue jobs: app key (auto)']);
    expect(service.calls).toEqual([]);
  });

  it('explicit options win: secret and explicit crypto are used as given', async () => {
    const secret = await start(transports.queue({ secret: SECRET }), APP_KEY);
    expect(secret.logs).toEqual(['info [@adonis-agora/diagnostics] queue jobs: secret']);
    const { runtime } = embeddedCrypto('shop');
    const crypto = await start(
      transports.queue({ crypto: { cipher: runtime.operations } }),
      APP_KEY,
    );
    expect(crypto.logs).toEqual([
      'info [@adonis-agora/diagnostics] queue jobs: crypto (key console-diagnostics)',
    ]);
  });

  it('crypto: false turns the APP_KEY mode off; without APP_KEY boot fails naming it first', async () => {
    delete process.env.APP_KEY;
    await expect(start(transports.queue({ crypto: false }), APP_KEY)).rejects.toThrow(
      /needs authentication\. The automatic APP_KEY mode is off/,
    );
    await expect(start(transports.queue())).rejects.toThrow(
      /the queue transport needs authentication\. Set APP_KEY in this app/,
    );
    await expect(start(transports.redis())).rejects.toThrow(
      /the Redis relay needs authentication\. Set APP_KEY in this app/,
    );
  });
});

describe('the APP_KEY mode through the provider boot', () => {
  it('boots a queue transport with no auth line in config/diagnostics.ts', async () => {
    const logs: string[] = [];
    const logger = {
      info: (msg: string) => void logs.push(msg),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const app = {
      config: {
        get: (key: string, fallback: unknown) =>
          key === 'diagnostics'
            ? { otel: false, default: 'queue', transports: { queue: transports.queue() } }
            : key === 'app.appKey'
              ? { release: () => APP_KEY }
              : fallback,
      },
      container: {
        hasBinding: () => false,
        make: async (binding: unknown) =>
          binding === 'logger' ? logger : new (binding as new () => object)(),
      },
      makePath: (...parts: string[]) => join('/nonexistent-app-root', ...parts),
      inProduction: false,
    } as never;
    const provider = new DiagnosticsProvider(app);
    await provider.boot();
    await provider.ready();
    try {
      expect(logs).toContain('[@adonis-agora/diagnostics] queue jobs: app key (auto)');
    } finally {
      await provider.shutdown();
    }
  });
});

describe('where "no authentication" fails', () => {
  const savedEnv = process.env.APP_KEY;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.APP_KEY;
    else process.env.APP_KEY = savedEnv;
  });
  const providerFor = (diagnostics: Record<string, unknown>) => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return new DiagnosticsProvider({
      config: {
        get: (key: string, fallback: unknown) =>
          key === 'diagnostics' ? { otel: false, ...diagnostics } : fallback,
      },
      container: {
        hasBinding: () => false,
        make: async (binding: unknown) =>
          binding === 'logger' ? logger : new (binding as new () => object)(),
      },
      makePath: (...parts: string[]) => join('/nonexistent-app-root', ...parts),
      inProduction: false,
    } as never);
  };

  it('only where the transport starts: boot (every ace command) passes, ready (the app starts) throws', async () => {
    delete process.env.APP_KEY;
    const unauthenticated = { default: 'queue', transports: { queue: transports.queue() } };
    const provider = providerFor(unauthenticated);
    // An ace command that does not start the app only boots providers.
    await expect(provider.boot()).resolves.toBeUndefined();
    // A process that starts the app (web server, queue:work, a command with startApp) starts the
    // transport, and refuses to relay unauthenticated.
    await expect(provider.ready()).rejects.toThrow(
      /\[@adonis-agora\/diagnostics\] the queue transport needs authentication/,
    );
    await provider.shutdown();
  });

  it('a transport that is declared but not selected never throws', async () => {
    delete process.env.APP_KEY;
    const provider = providerFor({
      transports: { queue: transports.queue(), redis: transports.redis() },
    });
    await provider.boot();
    await expect(provider.ready()).resolves.toBeUndefined();
    await provider.shutdown();
  });
});

describe('doctor: diagnostics.relay-auth and diagnostics.relay-auth-key', () => {
  const savedEnv = process.env.APP_KEY;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.APP_KEY;
    else process.env.APP_KEY = savedEnv;
  });
  const byId = (id: string) => diagnosticsDoctorChecks().find((c) => c.id === id);
  const doctorApp = (config: unknown, appKey?: string, isBooted = true) =>
    ({
      ...appWith(undefined),
      isBooted,
      config: {
        get: (key: string, fallback: unknown) =>
          key === 'diagnostics'
            ? config
            : key === 'app.appKey' && appKey !== undefined
              ? { release: () => appKey }
              : fallback,
      },
    }) as never;
  const runCheck = async (id: string, app: never) => {
    const out = await byId(id)?.run(app);
    return Array.isArray(out) ? out[0] : out;
  };
  const mode = (app: never) => runCheck('diagnostics.relay-auth', app);
  const key = (app: never) => runCheck('diagnostics.relay-auth-key', app);

  it('the key probe is a separate deep check', () => {
    expect(byId('diagnostics.relay-auth')?.cost).toBeUndefined();
    expect(byId('diagnostics.relay-auth-key')?.cost).toBe('deep');
  });

  it('auto mode: app key (auto), nothing to probe; no APP_KEY is an error naming it', async () => {
    delete process.env.APP_KEY;
    const config = { default: 'q', transports: { q: transports.queue() } };
    expect(await mode(doctorApp(config, APP_KEY))).toMatchObject({
      status: 'ok',
      message: 'default transport "q" (queue): app key (auto)',
    });
    expect(await key(doctorApp(config, APP_KEY))).toMatchObject({ status: 'skip' });
    const missing = await mode(doctorApp(config));
    expect(missing).toMatchObject({ status: 'error' });
    expect(missing?.fix).toMatch(/^the queue transport needs authentication\. Set APP_KEY/);
    expect(await mode(doctorApp(config, 'short'))).toMatchObject({ status: 'error' });
  });

  it('explicit crypto is probed; insecure warns; crypto: false without another mode is an error', async () => {
    delete process.env.APP_KEY;
    const server = new FakeCryptoService();
    const cipher = operationsOf(server, { partition: 'p', capabilities: ['crypto:*'], actor: 'a' });
    const explicit = { default: 'q', transports: { q: transports.queue({ crypto: { cipher } }) } };
    expect(await mode(doctorApp(explicit))).toMatchObject({
      status: 'ok',
      message: 'default transport "q" (queue): crypto (key console-diagnostics)',
    });
    expect(await key(doctorApp(explicit))).toMatchObject({ status: 'error' }); // no key yet
    await server.createKey(
      { partition: 'p', capabilities: ['crypto:*'], actor: 'a' },
      { name: 'console-diagnostics', type: 'aes256-gcm' },
    );
    expect(await key(doctorApp(explicit))).toMatchObject({ status: 'ok' });
    expect(await key(doctorApp(explicit, undefined, false))).toMatchObject({ status: 'skip' });
    const insecure = { default: 'q', transports: { q: transports.queue({ insecure: true }) } };
    expect(await mode(doctorApp(insecure))).toMatchObject({ status: 'warn' });
    const off = { default: 'q', transports: { q: transports.queue({ crypto: false }) } };
    expect(await mode(doctorApp(off, APP_KEY))).toMatchObject({ status: 'error' });
    expect(await mode(doctorApp({}))).toMatchObject({ status: 'skip' });
  });
});
