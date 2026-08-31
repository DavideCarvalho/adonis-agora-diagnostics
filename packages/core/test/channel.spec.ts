import diagnostics_channel from 'node:diagnostics_channel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channelName, emit, getChannel, SCHEMA_VERSION } from '../src/channel.js';
import { setContextAccessor } from '../src/context_accessor.js';
import { registeredChannels, resetRegistry } from '../src/registry.js';
import type { DiagnosticEvent } from '../src/types.js';

/** Subscribe to a channel for the duration of a test; returns captured envelopes. */
function capture(name: string): { events: DiagnosticEvent[]; stop: () => void } {
  const events: DiagnosticEvent[] = [];
  const channel = diagnostics_channel.channel(name);
  const onMessage = (msg: unknown) => events.push(msg as DiagnosticEvent);
  channel.subscribe(onMessage);
  return { events, stop: () => channel.unsubscribe(onMessage) };
}

describe('emit', () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    resetRegistry();
    setContextAccessor(null);
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    setContextAccessor(null);
  });

  it('publishes the envelope on agora:<lib>:<event> when subscribed', () => {
    const name = channelName('billing', 'invoice-paid');
    expect(name).toBe('agora:billing:invoice-paid');
    const cap = capture(name);
    stop = cap.stop;

    const before = Date.now();
    emit('billing', 'invoice-paid', { invoiceId: 'inv_123', amount: 4200 });
    const after = Date.now();

    expect(cap.events).toHaveLength(1);
    const env = cap.events[0];
    expect(env?.lib).toBe('billing');
    expect(env?.event).toBe('invoice-paid');
    expect(env?.payload).toEqual({ invoiceId: 'inv_123', amount: 4200 });
    expect(env?.traceId).toBeUndefined();
    expect(env?.ts).toBeGreaterThanOrEqual(before);
    expect(env?.ts).toBeLessThanOrEqual(after);
    expect(env?.v).toBe(SCHEMA_VERSION);
  });

  it('stamps the current schema version on the envelope', () => {
    const cap = capture(channelName('billing', 'invoice-paid'));
    stop = cap.stop;

    emit('billing', 'invoice-paid', { ok: true });

    expect(SCHEMA_VERSION).toBe(1);
    expect(cap.events[0]?.v).toBe(SCHEMA_VERSION);
  });

  it('stamps opts.durationMs onto the envelope when provided', () => {
    const cap = capture(channelName('billing', 'invoice-paid'));
    stop = cap.stop;

    emit('billing', 'invoice-paid', { ok: true }, { durationMs: 42 });

    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]?.durationMs).toBe(42);
  });

  it('leaves durationMs absent (not just undefined) when not provided', () => {
    const cap = capture(channelName('billing', 'invoice-paid'));
    stop = cap.stop;

    emit('billing', 'invoice-paid', { ok: true });

    expect(cap.events).toHaveLength(1);
    const env = cap.events[0];
    expect(env?.durationMs).toBeUndefined();
    expect(env && 'durationMs' in env).toBe(false);
  });

  it('skips building + publishing when opts.sample returns false', () => {
    const cap = capture(channelName('billing', 'invoice-paid'));
    stop = cap.stop;

    let calls = 0;
    const sample = () => {
      calls++;
      return false;
    };
    emit('billing', 'invoice-paid', { ok: true }, { sample });

    // Sampler consulted exactly once, and nothing was published.
    expect(calls).toBe(1);
    expect(cap.events).toHaveLength(0);
  });

  it('publishes when opts.sample returns true', () => {
    const cap = capture(channelName('billing', 'invoice-paid'));
    stop = cap.stop;

    emit('billing', 'invoice-paid', { ok: true }, { sample: () => true });

    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]?.payload).toEqual({ ok: true });
  });

  it('publishes by default (no sampling) — current behavior preserved', () => {
    const cap = capture(channelName('billing', 'invoice-paid'));
    stop = cap.stop;

    emit('billing', 'invoice-paid', { ok: true });

    expect(cap.events).toHaveLength(1);
  });

  it('does not consult the sampler when nothing subscribes', () => {
    let calls = 0;
    emit(
      'billing',
      'no-listener',
      { a: 1 },
      {
        sample: () => {
          calls++;
          return true;
        },
      },
    );
    expect(calls).toBe(0);
  });

  it('treats a throwing sampler as a skip (never breaks the caller)', () => {
    const cap = capture(channelName('billing', 'invoice-paid'));
    stop = cap.stop;

    let threw = false;
    try {
      emit(
        'billing',
        'invoice-paid',
        { ok: true },
        {
          sample: () => {
            throw new Error('boom');
          },
        },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(cap.events).toHaveLength(0);
  });

  it('does not publish (or build an envelope) when nothing subscribes', () => {
    // No subscriber on this channel.
    let threw = false;
    try {
      emit('billing', 'no-listener', { a: 1 });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // Re-subscribe and confirm a fresh emit still works (channel is healthy).
    const cap = capture(channelName('billing', 'no-listener'));
    stop = cap.stop;
    emit('billing', 'no-listener', { a: 2 });
    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]?.payload).toEqual({ a: 2 });
  });

  it('fills traceId from the registered context accessor', () => {
    setContextAccessor({
      traceId: () => 'trace-abc',
      tenantId: () => undefined,
      userRef: () => undefined,
      get: () => undefined,
    });
    const cap = capture(channelName('billing', 'invoice-paid'));
    stop = cap.stop;

    emit('billing', 'invoice-paid', { ok: true });

    expect(cap.events[0]?.traceId).toBe('trace-abc');
  });

  it('lets an explicit opts.traceId win over the accessor', () => {
    setContextAccessor({
      traceId: () => 'from-accessor',
      tenantId: () => undefined,
      userRef: () => undefined,
      get: () => undefined,
    });
    const cap = capture(channelName('billing', 'invoice-paid'));
    stop = cap.stop;

    emit('billing', 'invoice-paid', {}, { traceId: 'explicit' });

    expect(cap.events[0]?.traceId).toBe('explicit');
  });

  it('omits traceId when the accessor throws', () => {
    setContextAccessor({
      traceId: () => {
        throw new Error('no context');
      },
      tenantId: () => undefined,
      userRef: () => undefined,
      get: () => undefined,
    });
    const cap = capture(channelName('billing', 'invoice-paid'));
    stop = cap.stop;

    emit('billing', 'invoice-paid', {});

    expect(cap.events[0]?.traceId).toBeUndefined();
  });

  it('getChannel returns the memoized node channel for a name', () => {
    const a = getChannel('billing', 'invoice-paid');
    const b = diagnostics_channel.channel('agora:billing:invoice-paid');
    expect(a).toBe(b);
  });

  it('getChannel returns a stable cached object across repeated calls', () => {
    const first = getChannel('billing', 'invoice-paid');
    const second = getChannel('billing', 'invoice-paid');
    // Same pair → same object, served from the per-(lib,event) memo cache.
    expect(second).toBe(first);
    // ...and still the canonical node channel for that name.
    expect(second).toBe(diagnostics_channel.channel('agora:billing:invoice-paid'));
  });

  it('still registers each cached channel exactly once for discovery', () => {
    resetRegistry();
    // Repeated getChannel/emit on the same pair must register the name once, and
    // a second distinct pair must still be discovered — the cache must not hide
    // channels from the registry the generic watcher reads.
    getChannel('authz', 'decision');
    getChannel('authz', 'decision');
    emit('authz', 'decision', {});
    emit('inertia', 'render', {});
    expect(registeredChannels()).toEqual(['agora:authz:decision', 'agora:inertia:render']);
  });

  it('shares the accessor through a globalThis singleton across module copies', () => {
    // A divergent copy of this package would set the accessor on the SAME
    // `Symbol.for` slot; `emit()` in any copy reads that one cell. Simulate the
    // other copy by writing the slot directly and asserting our `emit` sees it.
    const ACCESSOR_KEY = Symbol.for('@agora/diagnostics:accessor');
    const slot = (globalThis as Record<symbol, { current: unknown } | undefined>)[ACCESSOR_KEY];
    expect(slot).toBeDefined();
    slot!.current = {
      traceId: () => 'trace-from-other-copy',
      tenantId: () => undefined,
      userRef: () => undefined,
      get: () => undefined,
    };

    const cap = capture(channelName('billing', 'invoice-paid'));
    stop = cap.stop;
    emit('billing', 'invoice-paid', {});

    expect(cap.events[0]?.traceId).toBe('trace-from-other-copy');
  });
});
