/**
 * One "process" of the two-process listener specs (`two-process.spec.ts`). It wires the BUILT
 * package (`dist/`) the way the AdonisJS provider does — listeners, invoker, dispatch, transport —
 * against a real Redis, then talks to the spec over stdio:
 *
 *   stdout: one JSON object per line ({ ready }, { invoked }, { error })
 *   stdin:  `emit <json payload>` to emit `agora:agent:run.finished`, `stop` to shut down
 *
 * argv: <mode: redis | queue> <role: web | worker> <name> <redisUrl> <namespace>
 */
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [mode, role, name, redisUrl, namespace] = process.argv.slice(2);
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

const invoke = createListenerInvoker((target) => new target());
bindListenerInvoker(invoke);
const logger = { error: (obj, msg) => out({ error: msg ?? String(obj) }), warn() {}, info() {} };
const ctx = {
  app: { container: { make: async () => logger } },
  forward: { libs: ['agent'] },
  nodeId: name,
  listeners: { libs: ['agent'] },
  invoke,
};

const cleanups = [];
let deliver;

if (mode === 'redis') {
  const { createDiagnosticsRedisRelay } = await load('transports/redis.js');
  const pub = new Redis(redisUrl);
  const sub = pub.duplicate();
  const redisChannel = `${namespace}:relay`;
  await sub.subscribe(redisChannel);
  const stop = createDiagnosticsRedisRelay({
    pub,
    sub,
    libs: ['agent'],
    nodeId: name,
    redisChannel,
  });
  cleanups.push(
    stop,
    () => pub.quit(),
    () => sub.quit(),
  );
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
  if (role === 'web') await QueueManager.init(config);

  const handle = await transports.queue({ queue: namespace, retries: 3 })(ctx);
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

const stopDispatch = startListenerDispatch({
  invoke,
  deliver,
  onListenerError: (error) => out({ error: `listener: ${error.message}` }),
  onDeliveryError: (error) => out({ error: `delivery: ${error.message}` }),
});
cleanups.unshift(stopDispatch);

out({ ready: true });

for await (const line of createInterface({ input: process.stdin })) {
  if (line.startsWith('emit ')) emit('agent', 'run.finished', JSON.parse(line.slice(5)));
  if (line === 'stop') break;
}
for (const cleanup of cleanups) {
  try {
    await cleanup();
  } catch {}
}
out({ stopped: true });
process.exit(0);
