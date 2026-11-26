/**
 * One "process" of the two-process listener specs (`two-process.spec.ts`). It wires the BUILT
 * package (`dist/`) the way the AdonisJS provider does — listeners, invoker, dispatch, transport —
 * against a real Redis, then talks to the spec over stdio:
 *
 *   stdout: one JSON object per line ({ ready }, { invoked }, { error }, { warned })
 *   stdin:  `emit <json payload>` to emit `agora:agent:run.finished`, `stop` to shut down,
 *           `forge <json payload>` (queue mode) to write listener jobs into the queue the way an
 *           attacker with access to the backend would: one unsealed, one sealed with another
 *           secret, and one genuine sealed payload dispatched twice (a copied job).
 *
 * argv: <mode: redis | queue> <role: web | worker | api> <name> <redisUrl> <namespace> [appKey]
 *
 * With an `appKey`, the relay authenticates with it (the automatic mode of an AdonisJS app: a key
 * derived from APP_KEY) instead of the shared secret.
 *
 * `api` wires a `role: 'api'` process as the provider does: a publish-only relay, no re-emitter,
 * no process invoker, and listeners never run here.
 */
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [mode, role, name, redisUrl, namespace, appKey] = process.argv.slice(2);
const dist = new URL('../../../dist/src/', import.meta.url);
const load = (path) => import(new URL(path, dist).href);

const { emit } = await load('channel.js');
const { OnDiagnostic, registerListenerClass, loadListeners } = await load('listeners.js');
const { createListenerInvoker, bindListenerInvoker, startListenerDispatch } =
  await load('listener_dispatch.js');
const { Redis } = await import('ioredis');

const out = (message) => process.stdout.write(`${JSON.stringify({ name, ...message })}\n`);

// The listener every process registers, as an app would from app/listeners/diagnostics. In the
// queue mode it throws on its first attempt so the spec can see the retry.
let attempts = 0;
class TrackRun {
  async handle(event) {
    attempts += 1;
    out({ invoked: { id: event.id, payload: event.payload, attempt: attempts } });
    if (mode === 'queue' && attempts === 1) throw new Error('first attempt fails');
  }
}
OnDiagnostic('agent', 'run.finished')(TrackRun.prototype, 'handle');
registerListenerClass(TrackRun, 'app/listeners/diagnostics/track_run');
await loadListeners();

const api = role === 'api';
const invoke = createListenerInvoker((target) => new target());
if (!api) bindListenerInvoker(invoke);
const SECRET = 'two-process-relay-secret';
const auth = appKey ? { appKey } : { secret: SECRET };
const logger = {
  error: (obj, msg) => out({ error: msg ?? String(obj) }),
  warn: (obj, msg) => out({ warned: msg ?? String(obj) }),
  info() {},
};
const ctx = {
  app: { container: { make: async () => logger } },
  forward: { libs: ['agent'] },
  nodeId: name,
  ...(api ? { role: 'api' } : {}),
  listeners: { libs: ['agent'] },
  invoke,
};

const cleanups = [];
let deliver;

if (mode === 'redis') {
  const { createDiagnosticsRedisRelay } = await load('transports/redis.js');
  const pub = new Redis(redisUrl);
  const sub = api ? undefined : pub.duplicate();
  const redisChannel = `${namespace}:relay`;
  await sub?.subscribe(redisChannel);
  const stop = createDiagnosticsRedisRelay({
    pub,
    ...(sub ? { sub } : { receive: false }),
    libs: ['agent'],
    nodeId: name,
    redisChannel,
    ...auth,
    onError: (error) => out({ warned: error.message }),
  });
  cleanups.push(stop, () => pub.quit());
  if (sub) cleanups.push(() => sub.quit());
} else {
  const queuePkg = realpathSync(
    fileURLToPath(new URL('../../../node_modules/@adonisjs/queue', import.meta.url)),
  );
  const { QueueManager, Worker } = await import('@adonisjs/queue');
  const { redis } = await import(
    pathToFileURL(`${queuePkg}/../../@boringnode/queue/build/src/drivers/redis_adapter.js`).href
  );
  const { transports } = await load('transports/factory.js');
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const config = {
    default: 'redis',
    adapters: { redis: redis(connection) },
    worker: { idleDelay: '20ms', concurrency: 1, gracefulShutdown: false },
  };
  if (role !== 'worker') await QueueManager.init(config);

  const handle = await transports.queue({ queue: namespace, retries: 3, ...auth })(ctx);
  deliver = handle.deliver.bind(handle);
  cleanups.push(() => handle.stop());

  if (role === 'worker') {
    const worker = new Worker(config);
    const running = worker.start([namespace]);
    cleanups.push(async () => {
      await worker.stop();
      await running;
    });
  }
  cleanups.push(
    () => QueueManager.destroy(),
    () => connection.quit(),
  );
}

if (!api || deliver) {
  const stopDispatch = startListenerDispatch({
    invoke,
    deliver,
    onListenerError: (error) => out({ error: `listener: ${error.message}` }),
    onDeliveryError: (error) => out({ error: `delivery: ${error.message}` }),
  });
  cleanups.unshift(stopDispatch);
}

out({ ready: true });

async function forge(payload) {
  const { default: ListenerJob } = await load('transports/diagnostics_listener_job.js');
  const { createQueueJobAuth } = await load('transports/queue_auth.js');
  const { registeredListeners } = await load('listeners.js');
  const listenerId = registeredListeners()[0].id;
  const env = {
    v: 1,
    id: `forged-${Date.now()}`,
    ts: Date.now(),
    lib: 'agent',
    event: 'run.finished',
    payload,
  };
  const hooks = { onReject() {}, onError() {} };
  const item = { listenerId, env };
  // 1. unsealed, 2. sealed with a secret the workers do not hold
  await ListenerJob.dispatch(item).toQueue(namespace);
  const wrong = createQueueJobAuth({ secret: 'not-the-relay-secret-000' }, hooks);
  await ListenerJob.dispatch(wrong.seal('listener', 'attacker', [item])[0]).toQueue(namespace);
  // 3. a genuine sealed payload, written into the backend twice
  const genuine = createQueueJobAuth({ secret: SECRET }, hooks);
  const [sealed] = genuine.seal('listener', 'web', [{ listenerId, env: { ...env, id: 'copied' } }]);
  await ListenerJob.dispatch(sealed).toQueue(namespace);
  await ListenerJob.dispatch(sealed).toQueue(namespace);
}

for await (const line of createInterface({ input: process.stdin })) {
  if (line.startsWith('emit ')) emit('agent', 'run.finished', JSON.parse(line.slice(5)));
  if (line.startsWith('forge ')) await forge(JSON.parse(line.slice(6)));
  if (line === 'stop') break;
}
for (const cleanup of cleanups) {
  try {
    await cleanup();
  } catch {}
}
out({ stopped: true });
process.exit(0);
