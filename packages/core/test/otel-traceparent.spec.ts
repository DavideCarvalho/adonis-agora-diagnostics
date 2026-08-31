import {
  type Context,
  type ContextManager,
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearTraceparentSlot,
  otelTraceparent,
  publishTraceparentSlot,
  TRACEPARENT_SLOT,
} from '../src/otel/traceparent.js';

/** Minimal synchronous context manager so `context.with` is observable. */
class SyncContextManager implements ContextManager {
  private activeContext: Context = ROOT_CONTEXT;
  active(): Context {
    return this.activeContext;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const previous = this.activeContext;
    this.activeContext = ctx;
    try {
      return fn.call(thisArg, ...args);
    } finally {
      this.activeContext = previous;
    }
  }
  bind<T>(_ctx: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    this.activeContext = ROOT_CONTEXT;
    return this;
  }
}

const contextManager = new SyncContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

afterAll(() => {
  contextManager.disable();
});

function withSpan<T>(traceId: string, spanId: string, fn: () => T): T {
  const spanContext = { traceId, spanId, traceFlags: 1, isRemote: false };
  return context.with(trace.setSpanContext(ROOT_CONTEXT, spanContext), fn);
}

describe('otelTraceparent', () => {
  it('returns a W3C traceparent for the active span', () => {
    withSpan('a'.repeat(32), 'b'.repeat(16), () => {
      const tp = otelTraceparent();
      expect(tp).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
    });
  });

  it('returns undefined when no span is active', () => {
    expect(otelTraceparent()).toBeUndefined();
  });
});

describe('traceparent global slot', () => {
  it('publishes and clears the function on the global symbol slot', () => {
    publishTraceparentSlot();
    const fn = (globalThis as Record<symbol, unknown>)[TRACEPARENT_SLOT];
    expect(typeof fn).toBe('function');
    withSpan('c'.repeat(32), 'd'.repeat(16), () => {
      expect((fn as () => string | undefined)()).toBe(`00-${'c'.repeat(32)}-${'d'.repeat(16)}-01`);
    });
    clearTraceparentSlot();
    expect((globalThis as Record<symbol, unknown>)[TRACEPARENT_SLOT]).toBeUndefined();
  });
});
