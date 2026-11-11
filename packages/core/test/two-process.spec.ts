import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Two real processes, one real Redis, one event: the listener guarantees per transport.
 *
 * Redis comes from `REDIS_URL` (CI runs a Redis service), or from a throwaway `redis-server` this
 * spec starts. Under CI a missing Redis is a failure, not a skip.
 */
const node = fileURLToPath(new URL('./fixtures/two-process/node.mjs', import.meta.url));
const built = existsSync(fileURLToPath(new URL('../dist/src/listeners.js', import.meta.url)));

interface Message {
  name: string;
  ready?: boolean;
  stopped?: boolean;
  invoked?: { id: string; payload: unknown; attempt: number };
  error?: string;
}

class Peer {
  readonly messages: Message[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private waiters: Array<() => void> = [];

  constructor(args: string[]) {
    this.child = spawn(process.execPath, [node, ...args], { stdio: 'pipe' });
    let stderr = '';
    this.child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    this.child.on('exit', (code) => {
      if (code !== 0)
        this.messages.push({ name: args[2] ?? '?', error: `exit ${code}: ${stderr}` });
      this.notify();
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      this.messages.push(JSON.parse(line) as Message);
      this.notify();
    });
  }

  private notify() {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async until(predicate: (messages: Message[]) => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.messages)) {
      const errors = this.messages.filter((m) => m.error);
      if (errors.length > 0) throw new Error(errors.map((m) => m.error).join('\n'));
      if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(this.messages)}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  send(line: string) {
    this.child.stdin.write(`${line}\n`);
  }

  async stop() {
    if (this.child.exitCode !== null) return;
    this.send('stop');
    await this.until((m) => m.some((x) => x.stopped)).catch(() => this.child.kill());
  }

  invocations() {
    return this.messages.flatMap((m) => (m.invoked ? [m.invoked] : []));
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(),
      );
    });
  });
}

let redisUrl = process.env.REDIS_URL;
let redisServer: ChildProcessWithoutNullStreams | undefined;

beforeAll(async () => {
  if (redisUrl || !built) return;
  const port = await freePort();
  try {
    redisServer = spawn(
      'redis-server',
      ['--port', String(port), '--save', '', '--appendonly', 'no'],
      {
        stdio: 'pipe',
      },
    );
    await new Promise<void>((resolve, reject) => {
      redisServer?.on('error', reject);
      redisServer?.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('Ready to accept connections')) resolve();
      });
      setTimeout(() => reject(new Error('redis-server did not start')), 5000);
    });
    redisUrl = `redis://127.0.0.1:${port}`;
  } catch {
    redisServer?.kill();
    redisServer = undefined;
  }
});

afterAll(() => {
  redisServer?.kill();
});

const peers: Peer[] = [];
async function start(mode: string, role: string, name: string, namespace: string) {
  const peer = new Peer([mode, role, name, redisUrl as string, namespace]);
  peers.push(peer);
  await peer.until((m) => m.some((x) => x.ready));
  return peer;
}

describe('listeners across two processes on a real Redis', () => {
  it('has a build and a Redis to run against', () => {
    if (process.env.CI) {
      expect(built, 'run `pnpm build` before `pnpm test`').toBe(true);
      expect(redisUrl, 'set REDIS_URL (CI runs a Redis service)').toBeDefined();
    }
  });

  const run = built ? it : it.skip;

  run(
    'redis: every process runs the listener, with the same event id',
    async (ctx) => {
      if (!redisUrl) return ctx.skip();
      const ns = `diag-test-${randomUUID()}`;
      try {
        const web = await start('redis', 'web', 'web', ns);
        const other = await start('redis', 'web', 'other', ns);
        await new Promise((resolve) => setTimeout(resolve, 100));

        web.send(`emit ${JSON.stringify({ n: 1 })}`);
        await web.until((m) => m.some((x) => x.invoked));
        await other.until((m) => m.some((x) => x.invoked));
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(web.invocations()).toHaveLength(1);
        expect(other.invocations()).toHaveLength(1);
        expect(other.invocations()[0]?.id).toBe(web.invocations()[0]?.id);
        expect(other.invocations()[0]?.payload).toEqual({ n: 1 });
      } finally {
        await Promise.all(peers.splice(0).map((p) => p.stop()));
      }
    },
    30_000,
  );

  run(
    "redis, role 'api' + 'worker': the worker runs the listener, the api process never does",
    async (ctx) => {
      if (!redisUrl) return ctx.skip();
      const ns = `diag-test-${randomUUID()}`;
      try {
        const api = await start('redis', 'api', 'api', ns);
        const worker = await start('redis', 'web', 'worker', ns);
        await new Promise((resolve) => setTimeout(resolve, 100));

        api.send(`emit ${JSON.stringify({ n: 3 })}`);
        worker.send(`emit ${JSON.stringify({ n: 4 })}`);
        await worker.until((m) => m.filter((x) => x.invoked).length >= 2);
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(api.invocations()).toEqual([]);
        expect(worker.invocations().map((r) => r.payload)).toEqual(
          expect.arrayContaining([{ n: 3 }, { n: 4 }]),
        );
        expect(worker.invocations()).toHaveLength(2);
      } finally {
        await Promise.all(peers.splice(0).map((p) => p.stop()));
      }
    },
    30_000,
  );

  run(
    "queue, role 'api': hands the listener to the worker and never runs it",
    async (ctx) => {
      if (!redisUrl) return ctx.skip();
      const ns = `diag-test-${randomUUID()}`;
      try {
        const worker = await start('queue', 'worker', 'worker', ns);
        const api = await start('queue', 'api', 'api', ns);

        api.send(`emit ${JSON.stringify({ n: 5 })}`);
        await worker.until((m) => m.filter((x) => x.invoked).length >= 2, 15_000);
        await new Promise((resolve) => setTimeout(resolve, 500));

        expect(api.invocations()).toEqual([]);
        expect(worker.invocations().map((r) => r.attempt)).toEqual([1, 2]);
        expect(worker.invocations()[0]?.payload).toEqual({ n: 5 });
      } finally {
        await Promise.all(peers.splice(0).map((p) => p.stop()));
      }
    },
    30_000,
  );

  run(
    'queue: the listener runs once in a worker, retried after a throw, never at the origin',
    async (ctx) => {
      if (!redisUrl) return ctx.skip();
      const ns = `diag-test-${randomUUID()}`;
      try {
        const worker = await start('queue', 'worker', 'worker', ns);
        const web = await start('queue', 'web', 'web', ns);

        web.send(`emit ${JSON.stringify({ n: 2 })}`);
        await worker.until((m) => m.filter((x) => x.invoked).length >= 2, 15_000);
        // Give a duplicate delivery (a relayed copy handed over again) time to show up.
        await new Promise((resolve) => setTimeout(resolve, 1000));

        expect(web.invocations()).toEqual([]);
        const runs = worker.invocations();
        expect(runs.map((r) => r.attempt)).toEqual([1, 2]);
        expect(new Set(runs.map((r) => r.id)).size).toBe(1);
        expect(runs[0]?.payload).toEqual({ n: 2 });
      } finally {
        await Promise.all(peers.splice(0).map((p) => p.stop()));
      }
    },
    30_000,
  );
});
