import { afterEach, describe, expect, it, vi } from 'vitest';
import { emit, getChannel } from '../src/channel.js';
import { resetRegistry } from '../src/registry.js';
import { createDiagnosticsRedisRelay } from '../src/transports/redis.js';
import type { DiagnosticEvent } from '../src/types.js';
import { FakeHub, FakeRedis } from './fake-redis.js';

const RELAY_CHANNEL = 'agora:diagnostics:relay';

/** Let the relay's per-turn flush run. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Capture envelopes published to the Redis hub on the relay channel. */
function hubCapture(hub: FakeHub) {
  const seen: Array<{ node: string; env: DiagnosticEvent }> = [];
  const spy = new FakeRedis(hub);
  spy.subscribe(RELAY_CHANNEL);
  spy.on('message', (_ch, raw) => seen.push(JSON.parse(raw)));
  return seen;
}

describe('createDiagnosticsRedisRelay', () => {
  const teardowns: Array<() => void> = [];
  afterEach(() => {
    for (const t of teardowns.splice(0)) t();
    resetRegistry();
  });

  it('forwards a selected local event to Redis', async () => {
    const hub = new FakeHub();
    const seen = hubCapture(hub);
    teardowns.push(
      createDiagnosticsRedisRelay({
        pub: new FakeRedis(hub),
        sub: new FakeRedis(hub),
        libs: ['resilience'],
        nodeId: 'A',
      }),
    );

    emit('resilience', 'circuit-opened', { key: 'payments' });
    await nextTurn();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.node).toBe('A');
    expect(seen[0]?.env.lib).toBe('resilience');
    expect(seen[0]?.env.event).toBe('circuit-opened');
    expect(seen[0]?.env.payload).toEqual({ key: 'payments' });
  });

  it('re-emits a Redis-received event onto the local bus', () => {
    const hub = new FakeHub();
    const sub = new FakeRedis(hub);
    teardowns.push(
      createDiagnosticsRedisRelay({
        pub: new FakeRedis(hub),
        sub,
        libs: ['resilience'],
        nodeId: 'B',
      }),
    );
    const local = vi.fn();
    getChannel('resilience', 'circuit-opened').subscribe((m) => local(m));

    // a different node publishes onto the relay channel
    const remote = new FakeRedis(hub);
    const env: DiagnosticEvent = {
      ts: 1,
      lib: 'resilience',
      event: 'circuit-opened',
      payload: { key: 'x' },
    };
    remote.publish(RELAY_CHANNEL, JSON.stringify({ node: 'OTHER', env }));

    expect(local).toHaveBeenCalledTimes(1);
    expect((local.mock.calls[0]?.[0] as DiagnosticEvent | undefined)?.payload).toEqual({
      key: 'x',
    });
  });

  it('suppresses its own echo (node === nodeId)', () => {
    const hub = new FakeHub();
    const sub = new FakeRedis(hub);
    teardowns.push(
      createDiagnosticsRedisRelay({
        pub: new FakeRedis(hub),
        sub,
        libs: ['resilience'],
        nodeId: 'A',
      }),
    );
    const local = vi.fn();
    getChannel('resilience', 'circuit-opened').subscribe(() => local());

    const env: DiagnosticEvent = { ts: 1, lib: 'resilience', event: 'circuit-opened', payload: {} };
    new FakeRedis(hub).publish(RELAY_CHANNEL, JSON.stringify({ node: 'A', env }));

    expect(local).not.toHaveBeenCalled();
  });

  it('round-trips an event through Redis without looping back', async () => {
    const hub = new FakeHub();
    const relayPub = new FakeRedis(hub);
    teardowns.push(
      createDiagnosticsRedisRelay({
        pub: relayPub,
        sub: new FakeRedis(hub),
        libs: ['resilience'],
        nodeId: 'A',
      }),
    );
    const onLocal = vi.fn();
    getChannel('resilience', 'circuit-opened').subscribe(() => onLocal());

    // local emit forwards once to Redis and fires the local subscriber once
    emit('resilience', 'circuit-opened', { key: 'p' });
    await nextTurn();
    expect(relayPub.publishCount).toBe(1);
    expect(onLocal).toHaveBeenCalledTimes(1);

    // the same event arriving from ANOTHER node (relabelled) is re-emitted locally once...
    const env: DiagnosticEvent = {
      ts: 1,
      lib: 'resilience',
      event: 'circuit-opened',
      payload: { key: 'p' },
    };
    new FakeRedis(hub).publish(RELAY_CHANNEL, JSON.stringify({ node: 'B', env }));
    expect(onLocal).toHaveBeenCalledTimes(2);
    // ...and the re-emit is NOT forwarded back to Redis (loop guard held)
    await nextTurn();
    expect(relayPub.publishCount).toBe(1);
  });

  it('honors exact channel selection and dotted event names', async () => {
    const hub = new FakeHub();
    const seen = hubCapture(hub);
    teardowns.push(
      createDiagnosticsRedisRelay({
        pub: new FakeRedis(hub),
        sub: new FakeRedis(hub),
        channels: [{ lib: 'durable', event: 'run.failed' }],
        nodeId: 'A',
      }),
    );

    emit('durable', 'run.failed', { runId: 'r1' });
    emit('durable', 'run.started', { runId: 'r1' });
    await nextTurn();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.env.event).toBe('run.failed');
  });

  it('forwards a future channel of a selected lib (onChannelRegistered)', async () => {
    const hub = new FakeHub();
    const seen = hubCapture(hub);
    teardowns.push(
      createDiagnosticsRedisRelay({
        pub: new FakeRedis(hub),
        sub: new FakeRedis(hub),
        libs: ['authz'],
        nodeId: 'A',
      }),
    );

    // 'authz:decision' channel first registers at this emit, after the relay started
    emit('authz', 'decision', { allow: true });
    await nextTurn();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.env.event).toBe('decision');
  });

  it('ignores malformed Redis messages without throwing', () => {
    const hub = new FakeHub();
    teardowns.push(
      createDiagnosticsRedisRelay({
        pub: new FakeRedis(hub),
        sub: new FakeRedis(hub),
        all: true,
        nodeId: 'A',
      }),
    );
    const sender = new FakeRedis(hub);
    expect(() => sender.publish(RELAY_CHANNEL, 'not json')).not.toThrow();
    expect(() => sender.publish(RELAY_CHANNEL, JSON.stringify({ node: 'X' }))).not.toThrow();
  });

  it('stops forwarding and receiving after teardown', async () => {
    const hub = new FakeHub();
    const relayPub = new FakeRedis(hub);
    const teardown = createDiagnosticsRedisRelay({
      pub: relayPub,
      sub: new FakeRedis(hub),
      libs: ['resilience'],
      nodeId: 'A',
    });

    teardown();

    emit('resilience', 'circuit-opened', { key: 'p' }); // no longer forwarded
    await nextTurn();
    expect(relayPub.publishCount).toBe(0);

    // an incoming Redis message is no longer received/re-emitted
    const onLocal = vi.fn();
    getChannel('resilience', 'circuit-opened').subscribe(() => onLocal());
    new FakeRedis(hub).publish(
      RELAY_CHANNEL,
      JSON.stringify({
        node: 'OTHER',
        env: { ts: 1, lib: 'resilience', event: 'circuit-opened', payload: {} },
      }),
    );
    expect(onLocal).not.toHaveBeenCalled();
  });
  describe('forwarding off the emitter call stack', () => {
    it('returns from emit() before the event is serialized or published', async () => {
      const hub = new FakeHub();
      const relayPub = new FakeRedis(hub);
      teardowns.push(
        createDiagnosticsRedisRelay({
          pub: relayPub,
          sub: new FakeRedis(hub),
          libs: ['resilience'],
          nodeId: 'A',
        }),
      );
      const stringify = vi.spyOn(JSON, 'stringify');
      try {
        emit('resilience', 'circuit-opened', { key: 'p' });
        expect(stringify).not.toHaveBeenCalled();
        expect(relayPub.publishCount).toBe(0);
        expect(relayPub.pipelineExecCount).toBe(0);

        await nextTurn();
        expect(stringify).toHaveBeenCalledTimes(1);
        expect(relayPub.publishCount).toBe(1);
      } finally {
        stringify.mockRestore();
      }
    });

    it('sends N events emitted in one turn as a single pipeline, in emit order', async () => {
      const hub = new FakeHub();
      const seen = hubCapture(hub);
      const relayPub = new FakeRedis(hub);
      teardowns.push(
        createDiagnosticsRedisRelay({
          pub: relayPub,
          sub: new FakeRedis(hub),
          all: true,
          nodeId: 'A',
        }),
      );

      for (let i = 0; i < 50; i++) {
        emit('durable', i % 2 === 0 ? 'run.started' : 'run.failed', { i });
      }
      await nextTurn();

      expect(relayPub.pipelineExecCount).toBe(1);
      expect(relayPub.publishCount).toBe(0);
      // one Redis message per event, unchanged wire format
      expect(seen.map((m) => (m.env.payload as { i: number }).i)).toEqual(
        Array.from({ length: 50 }, (_, i) => i),
      );
      expect(seen.every((m) => m.node === 'A')).toBe(true);
      expect(seen.filter((m) => m.env.event === 'run.started')).toHaveLength(25);
    });

    it('publishes one message per event in order when pub has no pipeline()', async () => {
      const hub = new FakeHub();
      const seen = hubCapture(hub);
      const relayPub = new FakeRedis(hub);
      const plainPub = {
        publish: (channel: string, message: string) => relayPub.publish(channel, message),
        subscribe: () => {},
        on: () => {},
        removeListener: () => {},
        unsubscribe: () => {},
      };
      teardowns.push(
        createDiagnosticsRedisRelay({
          pub: plainPub,
          sub: new FakeRedis(hub),
          libs: ['resilience'],
          nodeId: 'A',
        }),
      );

      emit('resilience', 'circuit-opened', { n: 1 });
      emit('resilience', 'circuit-closed', { n: 2 });
      emit('resilience', 'circuit-opened', { n: 3 });
      expect(relayPub.publishCount).toBe(0);
      await nextTurn();

      expect(relayPub.publishCount).toBe(3);
      expect(seen.map((m) => (m.env.payload as { n: number }).n)).toEqual([1, 2, 3]);
    });

    it('flushes queued events synchronously on teardown', () => {
      const hub = new FakeHub();
      const seen = hubCapture(hub);
      const relayPub = new FakeRedis(hub);
      const teardown = createDiagnosticsRedisRelay({
        pub: relayPub,
        sub: new FakeRedis(hub),
        libs: ['resilience'],
        nodeId: 'A',
      });

      emit('resilience', 'circuit-opened', { n: 1 });
      emit('resilience', 'circuit-closed', { n: 2 });
      teardown();

      expect(seen.map((m) => (m.env.payload as { n: number }).n)).toEqual([1, 2]);
    });

    it('drops only an unserializable event and never throws into emit() or the flush', async () => {
      const hub = new FakeHub();
      const seen = hubCapture(hub);
      teardowns.push(
        createDiagnosticsRedisRelay({
          pub: new FakeRedis(hub),
          sub: new FakeRedis(hub),
          libs: ['resilience'],
          nodeId: 'A',
        }),
      );
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      emit('resilience', 'circuit-opened', { n: 1 });
      expect(() => emit('resilience', 'circuit-opened', circular)).not.toThrow();
      emit('resilience', 'circuit-opened', { n: 3 });
      await nextTurn();

      expect(seen.map((m) => (m.env.payload as { n: number }).n)).toEqual([1, 3]);
    });

    it('swallows a throwing publisher', async () => {
      const hub = new FakeHub();
      const throwing = new FakeRedis(hub);
      throwing.publish = () => {
        throw new Error('down');
      };
      throwing.pipeline = () => {
        throw new Error('down');
      };
      teardowns.push(
        createDiagnosticsRedisRelay({
          pub: throwing,
          sub: new FakeRedis(hub),
          libs: ['resilience'],
          nodeId: 'A',
        }),
      );
      const uncaught = vi.fn();
      process.on('uncaughtException', uncaught);
      try {
        emit('resilience', 'circuit-opened', { n: 1 });
        emit('resilience', 'circuit-opened', { n: 2 });
        await nextTurn();
        emit('resilience', 'circuit-opened', { n: 3 });
        await nextTurn();
        expect(uncaught).not.toHaveBeenCalled();
      } finally {
        process.off('uncaughtException', uncaught);
      }
    });
  });
});
