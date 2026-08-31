import { context, trace as otelTrace, SpanStatusCode } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claimDiagnostics, emit, resetRegistry, trace } from '../src/index.js';
import { DiagnosticsOtelBridge } from '../src/otel/bridge.js';

const exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider;
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  otelTrace.setGlobalTracerProvider(provider);
  // The bridge is a post-hoc observer: it parents spans on / attaches POINT
  // events to the AMBIENT active OTel span (e.g. the @adonisjs/otel request
  // span). That requires a context manager so context.active() is meaningful.
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
});

afterAll(async () => {
  contextManager.disable();
  otelTrace.disable();
  context.disable();
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
  resetRegistry();
});

function spanByName(name: string): ReadableSpan | undefined {
  return exporter.getFinishedSpans().find((s) => s.name === name);
}

describe('DiagnosticsOtelBridge — spans from trace()', () => {
  let bridge: DiagnosticsOtelBridge;

  beforeEach(() => {
    bridge = new DiagnosticsOtelBridge();
    bridge.start();
  });

  afterEach(() => {
    bridge.stop();
  });

  it('produces an OK span for a sync trace()', () => {
    const out = trace('billing', 'charge', () => 42, { invoiceId: 'inv_1' });
    expect(out).toBe(42);

    const span = spanByName('agora.billing.charge');
    expect(span).toBeDefined();
    expect(span?.status.code).toBe(SpanStatusCode.OK);
    expect(span?.attributes['agora.lib']).toBe('billing');
    expect(span?.attributes['agora.event']).toBe('charge');
    expect(span?.attributes['agora.payload.invoiceId']).toBe('inv_1');
    expect(span?.attributes['agora.result']).toBe(42);
    expect(bridge.openSpanCount).toBe(0);
  });

  it('produces an ERROR span and records the exception for a sync throw', () => {
    const boom = new Error('kaboom');
    expect(() =>
      trace('billing', 'charge', () => {
        throw boom;
      }),
    ).toThrow('kaboom');

    const span = spanByName('agora.billing.charge');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe('kaboom');
    expect(span?.events.some((e) => e.name === 'exception')).toBe(true);
    expect(bridge.openSpanCount).toBe(0);
  });

  it('produces a single OK span for an async trace() (start/end/asyncStart/asyncEnd)', async () => {
    const out = await trace('durable', 'step', async () => 'done', { name: 's1' });
    expect(out).toBe('done');

    const spans = exporter.getFinishedSpans().filter((s) => s.name === 'agora.durable.step');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).toBe(SpanStatusCode.OK);
    expect(spans[0]?.attributes['agora.result']).toBe('done');
    expect(bridge.openSpanCount).toBe(0);
  });

  it('produces an ERROR span for an async rejection', async () => {
    await expect(
      trace('durable', 'step', async () => {
        throw new Error('async-fail');
      }),
    ).rejects.toThrow('async-fail');

    const spans = exporter.getFinishedSpans().filter((s) => s.name === 'agora.durable.step');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(bridge.openSpanCount).toBe(0);
  });

  it('records POINT emit() as an event on the ambient active span', () => {
    // Real-world: emit() runs inside an @adonisjs/otel request span. The bridge
    // attaches the POINT event to whatever OTel span is active.
    const parent = otelTrace.getTracer('test').startSpan('request');
    context.with(otelTrace.setSpan(context.active(), parent), () => {
      emit('audit', 'logged', { who: 'davi' });
    });
    parent.end();

    const span = spanByName('request');
    const evt = span?.events.find((e) => e.name === 'agora.audit.logged');
    expect(evt).toBeDefined();
    expect(evt?.attributes?.['agora.payload.who']).toBe('davi');
  });

  it('nests an agora span under the ambient active OTel span', () => {
    // Real-world: a trace() inside an @adonisjs/otel request span nests under it.
    const parent = otelTrace.getTracer('test').startSpan('request');
    context.with(otelTrace.setSpan(context.active(), parent), () => {
      trace('billing', 'charge', () => 1, { invoiceId: 'inv_1' });
    });
    parent.end();

    const inner = spanByName('agora.billing.charge');
    expect(inner).toBeDefined();
    expect(inner?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });
});

describe('DiagnosticsOtelBridge — defensive behavior', () => {
  it('does not record POINT events when recordPointEvents is false', () => {
    const bridge = new DiagnosticsOtelBridge({ recordPointEvents: false });
    bridge.start();
    try {
      trace('billing', 'charge', () => {
        emit('audit', 'logged', { who: 'davi' });
        return 1;
      });
      const span = spanByName('agora.billing.charge');
      expect(span?.events.some((e) => e.name === 'agora.audit.logged')).toBe(false);
    } finally {
      bridge.stop();
    }
  });

  it('force-ends open spans on stop()', () => {
    const bridge = new DiagnosticsOtelBridge();
    bridge.start();
    // An open async span: start the trace but never settle within the assertion.
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((r) => {
      release = r;
    });
    void trace('slow', 'op', () => pending);
    expect(bridge.openSpanCount).toBe(1);
    bridge.stop();
    expect(bridge.openSpanCount).toBe(0);
    release(null);

    const span = spanByName('agora.slow.op');
    expect(span).toBeDefined();
  });

  it('caps open spans at maxOpenSpans, force-ending the oldest', () => {
    const bridge = new DiagnosticsOtelBridge({ maxOpenSpans: 2 });
    bridge.start();
    try {
      const releases: Array<(v: unknown) => void> = [];
      for (let i = 0; i < 3; i++) {
        const p = new Promise((r) => releases.push(r));
        void trace('cap', `op${i}`, () => p);
      }
      // Three async ops started, cap is 2 → oldest force-ended.
      expect(bridge.openSpanCount).toBe(2);
      const capped = spanByName('agora.cap.op0');
      expect(capped?.status.code).toBe(SpanStatusCode.ERROR);
      for (const r of releases) r(null);
    } finally {
      bridge.stop();
    }
  });
});

describe('DiagnosticsOtelBridge — claim registry dedup', () => {
  it('skips a claimed lib:event POINT by default (a lib-specific consumer already handles it)', () => {
    const release = claimDiagnostics('agent', ['chat-request']);
    const bridge = new DiagnosticsOtelBridge();
    bridge.start();
    try {
      const parent = otelTrace.getTracer('test').startSpan('request');
      context.with(otelTrace.setSpan(context.active(), parent), () => {
        emit('agent', 'chat-request', { model: 'gpt-4o' });
      });
      parent.end();

      const span = spanByName('request');
      expect(span?.events.some((e) => e.name === 'agora.agent.chat-request')).toBe(false);
    } finally {
      bridge.stop();
      release();
    }
  });

  it('bridges a claimed lib:event POINT when recordClaimed: true is set', () => {
    const release = claimDiagnostics('agent', ['chat-request']);
    const bridge = new DiagnosticsOtelBridge({ recordClaimed: true });
    bridge.start();
    try {
      const parent = otelTrace.getTracer('test').startSpan('request');
      context.with(otelTrace.setSpan(context.active(), parent), () => {
        emit('agent', 'chat-request', { model: 'gpt-4o' });
      });
      parent.end();

      const span = spanByName('request');
      expect(span?.events.some((e) => e.name === 'agora.agent.chat-request')).toBe(true);
    } finally {
      bridge.stop();
      release();
    }
  });

  it('leaves unclaimed sibling POINT events unaffected', () => {
    const release = claimDiagnostics('agent', ['chat-request']);
    const bridge = new DiagnosticsOtelBridge();
    bridge.start();
    try {
      const parent = otelTrace.getTracer('test').startSpan('request');
      context.with(otelTrace.setSpan(context.active(), parent), () => {
        // Sibling event on the same lib, never claimed.
        emit('agent', 'tool-call', { tool: 'search' });
      });
      parent.end();

      const span = spanByName('request');
      expect(span?.events.some((e) => e.name === 'agora.agent.tool-call')).toBe(true);
    } finally {
      bridge.stop();
      release();
    }
  });

  it('un-claiming (release) makes the bridge record the POINT event again', () => {
    const release = claimDiagnostics('agent', ['chat-request']);
    const bridge = new DiagnosticsOtelBridge();
    bridge.start();
    try {
      const claimedParent = otelTrace.getTracer('test').startSpan('request-claimed');
      context.with(otelTrace.setSpan(context.active(), claimedParent), () => {
        emit('agent', 'chat-request', { model: 'gpt-4o' }); // claimed → skipped
      });
      claimedParent.end();

      release();

      const openParent = otelTrace.getTracer('test').startSpan('request-open');
      context.with(otelTrace.setSpan(context.active(), openParent), () => {
        emit('agent', 'chat-request', { model: 'gpt-4o' }); // unclaimed → recorded
      });
      openParent.end();

      const claimedSpan = spanByName('request-claimed');
      const openSpan = spanByName('request-open');
      expect(claimedSpan?.events.some((e) => e.name === 'agora.agent.chat-request')).toBe(false);
      expect(openSpan?.events.some((e) => e.name === 'agora.agent.chat-request')).toBe(true);
    } finally {
      bridge.stop();
    }
  });

  it('skips a claimed lib:event SPAN by default (same claim registry as point traffic)', () => {
    const release = claimDiagnostics('agent', ['step']);
    const bridge = new DiagnosticsOtelBridge();
    bridge.start();
    try {
      const out = trace('agent', 'step', () => 7, { i: 1 });
      expect(out).toBe(7);
      expect(spanByName('agora.agent.step')).toBeUndefined();
    } finally {
      bridge.stop();
      release();
    }
  });

  it('bridges a claimed lib:event SPAN when recordClaimed: true is set', () => {
    const release = claimDiagnostics('agent', ['step']);
    const bridge = new DiagnosticsOtelBridge({ recordClaimed: true });
    bridge.start();
    try {
      trace('agent', 'step', () => 7, { i: 1 });
      expect(spanByName('agora.agent.step')).toBeDefined();
    } finally {
      bridge.stop();
      release();
    }
  });
});
