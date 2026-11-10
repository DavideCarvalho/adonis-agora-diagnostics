import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * An ioredis-shaped client: every command returns a promise that stays pending until the
 * connection is ready, and rejects with `Connection is closed.` if the connection is torn down
 * first. That is what ioredis does with its offline queue.
 */
class FakeIoRedis {
  status = 'connecting';
  readonly calls: string[] = [];
  private pending: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];

  private command(name: string): Promise<unknown> {
    this.calls.push(name);
    if (this.status === 'end') return Promise.reject(new Error('Connection is closed.'));
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  publish(_channel: string, _message: string) {
    return this.command('publish');
  }
  subscribe(_channel: string) {
    return this.command('subscribe');
  }
  unsubscribe(_channel: string) {
    return this.command('unsubscribe');
  }
  quit() {
    const result = this.command('quit');
    this.close();
    return result;
  }
  disconnect() {
    this.calls.push('disconnect');
    this.close();
  }
  on() {}
  removeListener() {}
  duplicate() {
    return redis.sub;
  }

  /** The connection goes away with commands still queued: each one rejects. */
  private close() {
    this.status = 'end';
    for (const { reject } of this.pending.splice(0)) reject(new Error('Connection is closed.'));
  }
}

const redis = vi.hoisted(() => ({ sub: null as unknown, pub: null as unknown }));
vi.mock('@adonisjs/redis/services/main', () => ({
  default: { connection: () => ({ ioConnection: redis.pub }) },
}));

import { resetRegistry } from '../src/registry.js';
import type { TransportContext } from '../src/transports/factory.js';
import { transports } from '../src/transports/factory.js';

const context = { app: {}, forward: { libs: ['resilience'] }, nodeId: 'A' } as TransportContext;

/** Collect unhandled rejections raised while `run` executes and a few turns after it. */
async function unhandledRejectionsDuring(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    await run();
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  return seen;
}

describe('transports.redis teardown', () => {
  afterEach(() => resetRegistry());

  it('tears down while SUBSCRIBE is still pending without an unhandled rejection', async () => {
    const sub = new FakeIoRedis();
    redis.pub = new FakeIoRedis();
    redis.sub = sub;

    const seen = await unhandledRejectionsDuring(async () => {
      const stop = await transports.redis()(context);
      stop(); // a short-lived ace command: shutdown right after boot
    });

    expect(seen).toEqual([]);
    expect(sub.calls).toEqual(['subscribe', 'unsubscribe', 'disconnect']);
  });

  it('unsubscribes then QUITs a ready subscriber, and swallows a closed-connection rejection', async () => {
    const sub = new FakeIoRedis();
    sub.status = 'ready';
    redis.pub = new FakeIoRedis();
    redis.sub = sub;

    const seen = await unhandledRejectionsDuring(async () => {
      const stop = await transports.redis()(context);
      stop();
    });

    expect(seen).toEqual([]);
    expect(sub.calls).toEqual(['subscribe', 'unsubscribe', 'quit']);
  });

  it('swallows a teardown on a subscriber whose connection is already closed', async () => {
    const sub = new FakeIoRedis();
    redis.pub = new FakeIoRedis();
    redis.sub = sub;

    const seen = await unhandledRejectionsDuring(async () => {
      const stop = await transports.redis()(context);
      sub.status = 'end';
      expect(() => stop()).not.toThrow();
    });

    expect(seen).toEqual([]);
  });
});
