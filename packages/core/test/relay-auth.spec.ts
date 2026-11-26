import { afterEach, describe, expect, it, vi } from 'vitest';
import { emit, getChannel } from '../src/channel.js';
import { registeredChannels, resetRegistry } from '../src/registry.js';
import DiagnosticsEventJob from '../src/transports/diagnostics_event_job.js';
import { createDiagnosticsQueueRelay } from '../src/transports/queue.js';
import { createDiagnosticsRedisRelay } from '../src/transports/redis.js';
import { MAX_RELAY_SKEW_MS, relayKey, signFrame } from '../src/transports/relay_auth.js';
import type { DiagnosticEvent } from '../src/types.js';
import { FakeJob } from './fake-queue.js';
import { FakeHub, FakeRedis } from './fake-redis.js';
import { jobPayload, TEST_APP_KEY, wire } from './relay-wire.js';

const RELAY_CHANNEL = 'agora:diagnostics:relay';
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const env = (event = 'circuit-opened', lib = 'resilience'): DiagnosticEvent => ({
  ts: 1,
  lib,
  event,
  payload: { key: 'p' },
});

describe('authenticated Redis relay', () => {
  const teardowns: Array<() => void> = [];
  afterEach(() => {
    for (const t of teardowns.splice(0)) t();
    resetRegistry();
    vi.useRealTimers();
  });

  function listening(options: Record<string, unknown> = {}) {
    const hub = new FakeHub();
    const rejected: string[] = [];
    teardowns.push(
      createDiagnosticsRedisRelay({
        appKey: TEST_APP_KEY,
        pub: new FakeRedis(hub),
        sub: new FakeRedis(hub),
        libs: ['resilience'],
        nodeId: 'B',
        onReject: (reason) => rejected.push(reason),
        ...options,
      }),
    );
    const received: unknown[] = [];
    getChannel('resilience', 'circuit-opened').subscribe((m) => received.push(m));
    return { sender: new FakeRedis(hub), received, rejected };
  }

  it('re-emits a signed message once, and drops a replay of it', () => {
    const { sender, received, rejected } = listening();
    const message = wire('A', env());
    sender.publish(RELAY_CHANNEL, message);
    sender.publish(RELAY_CHANNEL, message);
    expect(received).toHaveLength(1);
    expect(rejected).toEqual(['replayed']);
  });

  it('drops unsigned, forged, wrongly keyed and stale messages without throwing', () => {
    const { sender, received, rejected } = listening();
    // The old 0.x wire format.
    sender.publish(RELAY_CHANNEL, JSON.stringify({ node: 'A', env: env() }));
    // Signed, then the event swapped.
    const tampered = JSON.parse(wire('A', env()));
    tampered.env.payload = { key: 'forged' };
    sender.publish(RELAY_CHANNEL, JSON.stringify(tampered));
    // Signed with another key.
    const other = relayKey({ secret: 'another-secret-0123456789' }, 'redis:x', 'test');
    sender.publish(RELAY_CHANNEL, JSON.stringify(signFrame(other, 'A', env())));
    // Signed, but captured more than a minute ago.
    vi.useFakeTimers({ now: Date.now() - MAX_RELAY_SKEW_MS - 5_000 });
    const stale = wire('A', env());
    vi.useRealTimers();
    sender.publish(RELAY_CHANNEL, stale);
    expect(() => sender.publish(RELAY_CHANNEL, 'not json')).not.toThrow();
    expect(received).toEqual([]);
    expect(rejected).toEqual(['unsigned', 'forged', 'stale', 'malformed']);
  });

  it('bounds the channels relayed events may create, and refuses malformed names', () => {
    const { sender, rejected } = listening({ maxRemoteChannels: 2 });
    const before = registeredChannels().length;
    for (let i = 0; i < 10; i++) sender.publish(RELAY_CHANNEL, wire('A', env(`flood-${i}`)));
    sender.publish(RELAY_CHANNEL, wire('A', env('ok', 'bad lib name')));
    sender.publish(RELAY_CHANNEL, wire('A', env('x'.repeat(500))));
    expect(registeredChannels().length - before).toBe(2);
    expect(rejected).toEqual(['too-many-channels', 'invalid-channel']);
  });

  it('a relay keyed by a shared secret accepts that secret only (not the app key)', () => {
    const hub = new FakeHub();
    const rejected: string[] = [];
    teardowns.push(
      createDiagnosticsRedisRelay({
        secret: 'shared-relay-secret-0123',
        appKey: TEST_APP_KEY,
        pub: new FakeRedis(hub),
        sub: new FakeRedis(hub),
        libs: [],
        nodeId: 'B',
        onReject: (reason) => rejected.push(reason),
      }),
    );
    const received: unknown[] = [];
    getChannel('resilience', 'circuit-opened').subscribe((m) => received.push(m));
    const sender = new FakeRedis(hub);
    // Signed with the app key: refused, the secret takes precedence.
    sender.publish(RELAY_CHANNEL, wire('A', env()));
    expect(rejected).toEqual(['forged']);
    // Signed with the shared secret: accepted.
    const shared = relayKey(
      { secret: 'shared-relay-secret-0123' },
      `redis:${RELAY_CHANNEL}`,
      'test',
    );
    sender.publish(RELAY_CHANNEL, JSON.stringify(signFrame(shared, 'A', env())));
    expect(received).toHaveLength(1);
  });

  it('refuses to start without a key, naming what to set', () => {
    const hub = new FakeHub();
    const make = (options: Record<string, unknown>) => () =>
      createDiagnosticsRedisRelay({ pub: new FakeRedis(hub), sub: new FakeRedis(hub), ...options });
    expect(make({})).toThrow(/APP_KEY.*`secret`/);
    expect(make({ appKey: 'short' })).toThrow(/APP_KEY/);
    expect(make({ secret: 'short' })).toThrow(/at least 16/);
  });
});

describe('authenticated queue jobs', () => {
  const teardowns: Array<() => void> = [];
  afterEach(() => {
    for (const t of teardowns.splice(0)) t();
    resetRegistry();
    vi.useRealTimers();
  });

  async function run(payload: unknown, jobId = 'j1') {
    const job = new DiagnosticsEventJob();
    job.$hydrate(payload as never, {
      jobId,
      name: 'agora.diagnostics.event',
      attempt: 1,
      queue: 'default',
      priority: 5,
      acquiredAt: new Date(),
      stalledCount: 0,
    });
    await job.execute();
  }

  function worker(options: Record<string, unknown> = {}) {
    const rejected: string[] = [];
    const job = new FakeJob();
    teardowns.push(
      createDiagnosticsQueueRelay({
        appKey: TEST_APP_KEY,
        job,
        libs: ['resilience'],
        nodeId: 'W',
        onReject: (reason) => rejected.push(reason),
        ...options,
      }),
    );
    const received: unknown[] = [];
    getChannel('resilience', 'circuit-opened').subscribe((m) => received.push(m));
    return { job, received, rejected };
  }

  it('dispatches signed jobs and re-emits an authentic one', async () => {
    const { job, received } = worker();
    emit('resilience', 'circuit-opened', { key: 'p' });
    await nextTurn();
    expect(job.dispatched[0]).toMatchObject({ v: 1, node: 'W', mac: expect.any(String) });
    await run(jobPayload('A', env()));
    expect(received).toHaveLength(2);
  });

  it('refuses unsigned and forged jobs, and the same message in another job', async () => {
    const { received, rejected } = worker();
    await run({ node: 'A', env: env() });
    const forged = jobPayload('A', env());
    (forged.env as DiagnosticEvent).payload = { key: 'forged' };
    await run(forged);
    const payload = jobPayload('A', env());
    await run(payload, 'job-1');
    // A retry of the same job runs again; the same message in a different job is a replay.
    await run(payload, 'job-1');
    await run(payload, 'job-2');
    expect(received).toHaveLength(2);
    expect(rejected).toEqual(['unsigned', 'forged', 'replayed']);
  });

  it('refuses a job older than maxJobAgeMs', async () => {
    const { received, rejected } = worker({ maxJobAgeMs: 1_000 });
    vi.useFakeTimers({ now: Date.now() - 5_000 });
    const old = jobPayload('A', env());
    vi.useRealTimers();
    await run(old);
    expect(received).toEqual([]);
    expect(rejected).toEqual(['stale']);
  });

  it('a job runs nothing when no queue relay is bound, and the relay needs a key', async () => {
    await expect(run(jobPayload('A', env()))).resolves.toBeUndefined();
    expect(() => createDiagnosticsQueueRelay({ job: new FakeJob(), libs: [] })).toThrow(/APP_KEY/);
  });
});
