import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emit, getChannel } from '../src/channel.js';
import { registeredChannels, resetRegistry } from '../src/registry.js';
import {
  EVENT_NAME_PATTERN,
  isValidRemoteChannel,
  LIB_NAME_PATTERN,
} from '../src/remote_channels.js';
import { transportInfo, transports } from '../src/transports/factory.js';
import { createDiagnosticsQueueRelay, getActiveReEmitter } from '../src/transports/queue.js';
import {
  createDiagnosticsRedisRelay,
  type DiagnosticsRedisRelayOptions,
  RELAY_REJECTED,
} from '../src/transports/redis.js';
import type { RelayCipher } from '../src/transports/relay_auth.js';
import type { DiagnosticEvent } from '../src/types.js';
import { FakeHub, FakeRedis } from './fake-redis.js';
import {
  bodyOf,
  RELAY_CHANNEL,
  TEST_RELAY_SECRET as SECRET,
  signBody,
  signed,
} from './relay-wire.js';

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Let pending crypto calls (promises) and the turn batcher settle. */
const settled = async () => {
  for (let i = 0; i < 5; i++) await nextTurn();
};

const event = (over: Partial<DiagnosticEvent> = {}): DiagnosticEvent => ({
  v: 1,
  id: 'e1',
  ts: 1,
  lib: 'resilience',
  event: 'circuit-opened',
  payload: { key: 'x' },
  ...over,
});

type Errors = Array<Error & { reason?: string; code?: string }>;

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const t of teardowns.splice(0)) t();
  resetRegistry();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A receiving relay on `hub`, with its dropped-message reports and a local subscriber. */
function receiver(
  hub: FakeHub,
  auth: Partial<DiagnosticsRedisRelayOptions> = { secret: SECRET },
  channel: [string, string] = ['resilience', 'circuit-opened'],
) {
  const errors: Errors = [];
  teardowns.push(
    createDiagnosticsRedisRelay({
      pub: new FakeRedis(hub),
      sub: new FakeRedis(hub),
      nodeId: 'B',
      onError: (error) => void errors.push(error),
      ...auth,
    } as DiagnosticsRedisRelayOptions),
  );
  const got: DiagnosticEvent[] = [];
  getChannel(...channel).subscribe((m) => void got.push(m as DiagnosticEvent));
  return { errors, got };
}

const inject = (hub: FakeHub, raw: string) => new FakeRedis(hub).publish(RELAY_CHANNEL, raw);

describe('Redis relay configuration', () => {
  it('refuses to start without a way to authenticate its messages', () => {
    const hub = new FakeHub();
    const base = { pub: new FakeRedis(hub), sub: new FakeRedis(hub) };
    expect(() => createDiagnosticsRedisRelay(base)).toThrow(/needs authentication/);
    expect(() => createDiagnosticsRedisRelay({ ...base, insecure: false })).toThrow(
      /needs authentication/,
    );
    expect(() => createDiagnosticsRedisRelay({ ...base, secret: 'short' })).toThrow(
      /at least 16 characters/,
    );
    expect(() =>
      createDiagnosticsRedisRelay({
        ...base,
        secret: SECRET,
        crypto: { cipher: () => ({}) as RelayCipher },
      }),
    ).toThrow(/not several/);
    expect(() =>
      createDiagnosticsRedisRelay({ ...base, maxRemoteChannels: -1, secret: SECRET }),
    ).toThrow(/maxRemoteChannels/);
  });

  it('accepts a Secret-like object (env.get) and never exposes it through transportInfo', () => {
    const hub = new FakeHub();
    const secret = { release: () => SECRET };
    teardowns.push(
      createDiagnosticsRedisRelay({ pub: new FakeRedis(hub), sub: new FakeRedis(hub), secret }),
    );
    const info = transportInfo(transports.redis({ secret }));
    expect(info?.options).toEqual({ auth: 'secret' });
    expect(JSON.stringify(info)).not.toContain(SECRET);
  });

  it('insecure: true relays the old unauthenticated wire and warns once', async () => {
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const hub = new FakeHub();
    const { got } = receiver(hub, { insecure: true });
    inject(hub, JSON.stringify({ node: 'A', env: event() }));
    expect(got).toHaveLength(1);
    // The warning is per process: a second insecure relay does not repeat it.
    receiver(hub, { insecure: true });
    const insecureWarnings = warning.mock.calls.filter((call) =>
      String(call[0]).includes('insecure: true'),
    );
    expect(insecureWarnings.length).toBeLessThanOrEqual(1);
  });
});

describe('Redis relay, shared secret', () => {
  it('delivers a message signed with the shared secret', () => {
    const hub = new FakeHub();
    const { got, errors } = receiver(hub);
    inject(hub, signed('A', event()));
    expect(got).toHaveLength(1);
    expect(got[0]?.payload).toEqual({ key: 'x' });
    expect(errors).toEqual([]);
  });

  it('round-trips between two relays holding the same secret', async () => {
    const hub = new FakeHub();
    const { got } = receiver(hub);
    teardowns.push(
      createDiagnosticsRedisRelay({
        pub: new FakeRedis(hub),
        sub: new FakeRedis(hub),
        libs: ['billing'],
        nodeId: 'A',
        secret: SECRET,
      }),
    );
    const billing: unknown[] = [];
    getChannel('billing', 'paid').subscribe(
      (m) => void billing.push((m as DiagnosticEvent).payload),
    );
    emit('billing', 'paid', { n: 1 });
    await nextTurn();
    // The local emit, then B's re-emit of what A relayed (both relays share this process's bus).
    expect(billing).toEqual([{ n: 1 }, { n: 1 }]);
    expect(got).toEqual([]);
  });

  it('drops an unsigned message (the old wire) and reports it', () => {
    const hub = new FakeHub();
    const { got, errors } = receiver(hub);
    inject(hub, JSON.stringify({ node: 'A', env: event() }));
    expect(got).toEqual([]);
    expect(errors[0]).toMatchObject({ code: RELAY_REJECTED, reason: 'unauthenticated' });
  });

  it('drops a message signed with another secret, or for another Redis channel', () => {
    const hub = new FakeHub();
    const { got } = receiver(hub);
    inject(hub, signed('A', event(), { secret: 'another-secret-0123456789' }));
    inject(hub, signed('A', event(), { channel: 'other:relay' }));
    expect(got).toEqual([]);
  });

  it('drops a tampered message', () => {
    const hub = new FakeHub();
    const { got } = receiver(hub);
    const raw = signed('A', event({ payload: { amount: 1 } }));
    inject(hub, raw.replace('"amount":1', '"amount":9'));
    // A valid tag moved onto another body is refused too.
    const [, tag] = raw.split('\n');
    inject(
      hub,
      `s1\n${tag}\n${JSON.stringify({ node: 'A', id: 'x', ts: Date.now(), env: event() })}`,
    );
    expect(got).toEqual([]);
  });

  it('drops a stale message, and one too far in the future', () => {
    const hub = new FakeHub();
    const { got, errors } = receiver(hub);
    inject(hub, signed('A', event(), { ts: Date.now() - 61_000 }));
    inject(hub, signed('A', event(), { ts: Date.now() + 61_000 }));
    expect(got).toEqual([]);
    expect(errors.map((e) => e.reason)).toEqual(['stale']);
    inject(hub, signed('A', event(), { ts: Date.now() - 30_000 }));
    expect(got).toHaveLength(1);
  });

  it('drops a replayed message', () => {
    const hub = new FakeHub();
    const { got, errors } = receiver(hub);
    const raw = signed('A', event());
    inject(hub, raw);
    inject(hub, raw);
    // Same id under a fresh signature: still the same message.
    inject(hub, signed('A', event(), { id: bodyOf(raw).id }));
    expect(got).toHaveLength(1);
    expect(errors.map((e) => e.reason)).toEqual(['replayed']);
  });

  it('forgets replay ids once their window passed', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const hub = new FakeHub();
    const { got } = receiver(hub);
    inject(hub, signed('A', event(), { id: 'old' }));
    vi.setSystemTime(Date.now() + 5 * 60_000);
    // 'old' is gone from the guard; a fresh message with the same id is fresh again.
    inject(hub, signed('A', event(), { id: 'old' }));
    expect(got).toHaveLength(2);
  });

  it('reports each kind of dropped message once, not per message', () => {
    const hub = new FakeHub();
    const { errors } = receiver(hub);
    for (let i = 0; i < 20; i++) inject(hub, JSON.stringify({ node: 'A', env: event() }));
    expect(errors).toHaveLength(1);
  });

  it('never throws into the Redis handler on garbage', () => {
    const hub = new FakeHub();
    const { got } = receiver(hub);
    for (const raw of [
      '',
      's1',
      's1\n',
      's1\nx\n',
      'c1\na\nb',
      signBody('not json'),
      signBody('null'),
    ]) {
      expect(() => inject(hub, raw)).not.toThrow();
    }
    expect(() => inject(hub, signed('A', null))).not.toThrow();
    expect(() => inject(hub, signed('A', [1, 2]))).not.toThrow();
    expect(got).toEqual([]);
  });
});

describe('relayed channel names and the remote channel cap', () => {
  it('accepts Agora names and refuses anything else', () => {
    expect(isValidRemoteChannel('resilience', 'circuit-opened')).toBe(true);
    expect(isValidRemoteChannel('durable', 'run.failed')).toBe(true);
    expect(isValidRemoteChannel('cache', 'hit:miss')).toBe(true);
    for (const [lib, event] of [
      ['', 'x'],
      ['a b', 'x'],
      ['a:b', 'x'],
      ['_proto', 'x'],
      ['lib', ''],
      ['lib', 'x\ny'],
      ['lib', '../x'],
      ['x'.repeat(65), 'x'],
      ['lib', 'x'.repeat(129)],
      [1, 'x'],
      ['lib', {}],
    ] as const) {
      expect(isValidRemoteChannel(lib, event), `${String(lib)} ${String(event)}`).toBe(false);
    }
    expect(LIB_NAME_PATTERN.test('x'.repeat(64))).toBe(true);
    expect(EVENT_NAME_PATTERN.test('x'.repeat(128))).toBe(true);
  });

  it('drops a signed event with an invalid name without registering a channel', () => {
    const hub = new FakeHub();
    const { errors } = receiver(hub);
    const before = registeredChannels().length;
    inject(hub, signed('A', event({ lib: 'evil lib' })));
    inject(hub, signed('A', event({ event: 'x'.repeat(500) })));
    inject(hub, signed('A', event({ lib: 42 as never })));
    expect(registeredChannels()).toHaveLength(before);
    expect(errors[0]?.reason).toBe('invalid-channel');
  });

  it('creates at most maxRemoteChannels new channels, and keeps delivering known ones', () => {
    const hub = new FakeHub();
    const { got, errors } = receiver(hub, { secret: SECRET, maxRemoteChannels: 3 });
    const before = registeredChannels().length;
    for (let i = 0; i < 50; i++) inject(hub, signed('A', event({ event: `flood-${i}` })));
    expect(registeredChannels().length - before).toBe(3);
    expect(errors.map((e) => e.reason)).toEqual(['channel-cap']);
    // A channel this process knows (registered locally) is never capped.
    inject(hub, signed('A', event()));
    expect(got).toHaveLength(1);
    // Nor is one the gate already admitted.
    const admitted: unknown[] = [];
    getChannel('resilience', 'flood-0').subscribe((m) => void admitted.push(m));
    inject(hub, signed('A', event({ event: 'flood-0' })));
    expect(admitted).toHaveLength(1);
  });

  it('caps the queue relay the same way', () => {
    teardowns.push(
      createDiagnosticsQueueRelay({
        job: { dispatch: () => {} },
        maxRemoteChannels: 2,
        insecure: true,
      }),
    );
    const reEmitter = getActiveReEmitter();
    const before = registeredChannels().length;
    for (let i = 0; i < 20; i++) {
      reEmitter?.reEmit({ node: 'other', env: event({ event: `q-${i}` }) });
    }
    reEmitter?.reEmit({ node: 'other', env: event({ lib: 'bad lib' }) });
    reEmitter?.reEmit(null as never);
    expect(registeredChannels().length - before).toBe(2);
  });
});

/**
 * A stand-in for an @adonis-agora/crypto server (in the Hub or its own app): keys live here, and
 * each caller gets a cipher limited to what its token may do on them.
 */
class FakeCryptoServer {
  readonly keys = new Map<string, Buffer>([
    ['console-diagnostics', randomBytes(32)],
    ['other-key', randomBytes(32)],
  ]);
  readonly audit: Array<{ op: string; key: string }> = [];

  cipherFor(allowed: { encrypt?: string[]; decrypt?: string[] }): RelayCipher {
    return {
      encrypt: async ({ key, plaintext, aad }) => {
        if (!allowed.encrypt?.includes(key)) throw new Error(`no crypto:encrypt:${key}`);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.keys.get(key) as Buffer, iv);
        cipher.setAAD(Buffer.from(aad ?? ''));
        const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        this.audit.push({ op: 'encrypt', key });
        return {
          ciphertext: `agora:ct1:${key}:1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`,
        };
      },
      decrypt: async ({ key, ciphertext, aad }) => {
        if (!allowed.decrypt?.includes(key)) throw new Error(`no crypto:decrypt:${key}`);
        const raw = Buffer.from(ciphertext.split(':').pop() as string, 'base64url');
        const decipher = createDecipheriv(
          'aes-256-gcm',
          this.keys.get(key) as Buffer,
          raw.subarray(0, 12),
        );
        decipher.setAAD(Buffer.from(aad ?? ''));
        decipher.setAuthTag(raw.subarray(12, 28));
        const plaintext = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
        this.audit.push({ op: 'decrypt', key });
        return { plaintext: plaintext.toString('utf8') };
      },
    };
  }
}

const BOTH = { encrypt: ['console-diagnostics'], decrypt: ['console-diagnostics'] };

describe('Redis relay, @adonis-agora/crypto key', () => {
  function cryptoPair(
    server: FakeCryptoServer,
    senderAccess = BOTH,
    receiverAccess = BOTH,
    senderKey?: string,
  ) {
    const hub = new FakeHub();
    const wire: string[] = [];
    const spy = new FakeRedis(hub);
    spy.subscribe(RELAY_CHANNEL);
    spy.on('message', (_c, raw) => void wire.push(raw));
    let resolved = 0;
    const senderErrors: Errors = [];
    teardowns.push(
      createDiagnosticsRedisRelay({
        pub: new FakeRedis(hub),
        sub: new FakeRedis(hub),
        libs: ['billing'],
        nodeId: 'A',
        // Lazy, like `() => crypto.client!` in config/diagnostics.ts.
        crypto: {
          cipher: () => {
            resolved += 1;
            return server.cipherFor(senderAccess);
          },
          ...(senderKey ? { key: senderKey } : {}),
        },
        onError: (error) => void senderErrors.push(error),
      }),
    );
    const { got, errors } = receiver(
      hub,
      { crypto: { cipher: server.cipherFor(receiverAccess) } },
      ['billing', 'paid'],
    );
    return { hub, wire, got, errors, senderErrors, resolvedCount: () => resolved };
  }

  it('relays an event encrypted with the crypto key, unreadable on Redis', async () => {
    const server = new FakeCryptoServer();
    const { wire, got, errors, resolvedCount } = cryptoPair(server);
    expect(resolvedCount()).toBe(0);
    emit('billing', 'paid', { invoice: 'inv_secret_123' });
    await settled();
    expect(resolvedCount()).toBeGreaterThanOrEqual(1);
    // local copy + relayed copy
    expect(got.map((e) => e.payload)).toEqual([
      { invoice: 'inv_secret_123' },
      { invoice: 'inv_secret_123' },
    ]);
    expect(errors).toEqual([]);
    expect(wire).toHaveLength(1);
    expect(wire[0]).toMatch(/^c1\nagora:ct1:console-diagnostics:/);
    expect(wire[0]).not.toContain('inv_secret_123');
    expect(wire[0]).not.toContain('billing');
  });

  it('calls the crypto server once per session key, not per event', async () => {
    const server = new FakeCryptoServer();
    const { got } = cryptoPair(server);
    for (let i = 0; i < 5; i++) emit('billing', 'paid', { i });
    await settled();
    for (let i = 5; i < 10; i++) emit('billing', 'paid', { i });
    await settled();
    // Each event twice (the local emit and the relayed copy); relayed copies keep emit order.
    expect(got).toHaveLength(20);
    const first = [0, 1, 2, 3, 4];
    const second = [5, 6, 7, 8, 9];
    expect(got.map((e) => (e.payload as { i: number }).i)).toEqual([
      ...first,
      ...first,
      ...second,
      ...second,
    ]);
    expect(server.audit).toEqual([
      { op: 'encrypt', key: 'console-diagnostics' },
      { op: 'decrypt', key: 'console-diagnostics' },
    ]);
  });

  it('a process without decrypt on the key receives nothing; one without encrypt sends nothing', async () => {
    const server = new FakeCryptoServer();
    const noDecrypt = cryptoPair(server, BOTH, { encrypt: ['console-diagnostics'], decrypt: [] });
    emit('billing', 'paid', { n: 1 });
    await settled();
    expect(noDecrypt.got).toHaveLength(1); // only the local emit
    expect(noDecrypt.errors[0]?.reason).toBe('crypto-unavailable');
    for (const t of teardowns.splice(0)) t();
    resetRegistry();

    const noEncrypt = cryptoPair(server, { encrypt: [], decrypt: ['console-diagnostics'] });
    emit('billing', 'paid', { n: 2 });
    await settled();
    expect(noEncrypt.wire).toEqual([]);
    expect(noEncrypt.senderErrors[0]?.reason).toBe('crypto-unavailable');
  });

  it('drops a message sealed with another key, a tampered one and a replayed one', async () => {
    const server = new FakeCryptoServer();
    const { hub, wire, got } = cryptoPair(server);
    emit('billing', 'paid', { n: 1 });
    await settled();
    expect(got).toHaveLength(2);
    const [raw] = wire as [string];
    // replay
    inject(hub, raw);
    // tampered body
    const parts = raw.split('\n');
    const body = Buffer.from(parts[2] as string, 'base64url');
    body[body.length - 1] = (body[body.length - 1] as number) ^ 1;
    inject(hub, `${parts[0]}\n${parts[1]}\n${body.toString('base64url')}`);
    // tampered sealed session key
    inject(hub, `${parts[0]}\n${(parts[1] as string).slice(0, -2)}AA\n${parts[2]}`);
    // a body under a session key the attacker made up, with a ciphertext of the right key name
    inject(
      hub,
      `c1\nagora:ct1:console-diagnostics:1:${randomBytes(80).toString('base64url')}\nAAAA`,
    );
    // the shared-secret wire is not accepted by a crypto relay
    inject(hub, signed('A', event({ lib: 'billing', event: 'paid' })));
    await settled();
    expect(got).toHaveLength(2);
  });

  it("ignores another key's ciphertext without calling the crypto server", async () => {
    const server = new FakeCryptoServer();
    const access = { encrypt: ['other-key'], decrypt: ['console-diagnostics'] };
    const { got } = cryptoPair(server, access, BOTH, 'other-key');
    emit('billing', 'paid', { n: 1 });
    await settled();
    expect(got).toHaveLength(1); // only the local emit
    expect(server.audit.filter((a) => a.op === 'decrypt')).toEqual([]);
  });

  it('bounds how many unknown session keys it tries to open per minute', async () => {
    const server = new FakeCryptoServer();
    const cipher = server.cipherFor(BOTH);
    const decrypt = vi.spyOn(cipher, 'decrypt');
    const hub = new FakeHub();
    receiver(hub, { crypto: { cipher } });
    for (let i = 0; i < 200; i++) {
      inject(
        hub,
        `c1\nagora:ct1:console-diagnostics:1:${randomBytes(60).toString('base64url')}\nAAAA`,
      );
    }
    await settled();
    expect(decrypt).toHaveBeenCalledTimes(30);
  });

  it('drops messages past a bounded backlog while the crypto server is slow', async () => {
    const hub = new FakeHub();
    const hanging: RelayCipher = {
      encrypt: () => new Promise(() => {}),
      decrypt: () => new Promise(() => {}),
    };
    const { errors } = receiver(hub, { crypto: { cipher: hanging } });
    const junk = `c1\nagora:ct1:console-diagnostics:1:${randomBytes(60).toString('base64url')}\nAAAA`;
    for (let i = 0; i < 10_050; i++) inject(hub, junk);
    expect(errors.map((e) => e.reason)).toContain('overloaded');
  });

  it('reports a cipher that is not ready', async () => {
    const hub = new FakeHub();
    const errors: Errors = [];
    teardowns.push(
      createDiagnosticsRedisRelay({
        pub: new FakeRedis(hub),
        sub: new FakeRedis(hub),
        libs: ['billing'],
        crypto: { cipher: () => undefined as unknown as RelayCipher },
        onError: (error) => void errors.push(error),
      }),
    );
    emit('billing', 'paid', {});
    await settled();
    expect(errors[0]?.reason).toBe('crypto-unavailable');
    expect(String((errors[0]?.cause as Error)?.message)).toContain('not ready');
  });
});
