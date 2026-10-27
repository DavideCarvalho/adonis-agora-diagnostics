import { afterEach, describe, expect, it } from 'vitest';
import { emit, trace } from '../src/index.js';
import { otelTraceparent, start, stop } from '../src/otel/index.js';

/**
 * No OTel SDK is registered in this file's worker (vitest `pool: 'forks'` gives
 * each spec file an isolated process). Every `@opentelemetry/api` call is a
 * no-op, so the bridge must subscribe and run without throwing and produce
 * nothing observable.
 */
describe('bridge with no OTel SDK registered (zero-overhead, no-op)', () => {
  afterEach(() => {
    stop();
  });

  it('start() does not throw and trace()/emit() pass values through unchanged', async () => {
    expect(() => start()).not.toThrow();

    const sync = trace('billing', 'charge', () => 7, { invoiceId: 'x' });
    expect(sync).toBe(7);

    const async = await trace('durable', 'step', async () => 'ok');
    expect(async).toBe('ok');

    expect(() => emit('audit', 'logged', { who: 'davi' })).not.toThrow();

    expect(() =>
      trace('billing', 'fail', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });

  it('does not track no-op (non-recording) spans in the open-span map', () => {
    const bridge = start();
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((r) => {
      release = r;
    });
    void trace('slow', 'op', () => pending);
    expect(bridge.openSpanCount).toBe(0);
    release(null);
  });

  it('otelTraceparent() returns undefined with no propagator', () => {
    expect(otelTraceparent()).toBeUndefined();
  });

  it('start() is idempotent and stop() is safe to call unstarted', () => {
    start();
    expect(() => start()).not.toThrow();
    stop();
    expect(() => stop()).not.toThrow();
  });
});
