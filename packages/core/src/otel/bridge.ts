import diagnostics_channel from 'node:diagnostics_channel';
import {
  type Attributes,
  type AttributeValue,
  context,
  type Span,
  SpanStatusCode,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import { isDiagnosticClaimed } from '../claims.js';
import { onChannelRegistered, registeredChannels } from '../registry.js';
import { parseChannelName } from '../relay.js';
import { traceChannelNames } from '../trace.js';
import type { DiagnosticEvent, SpanEvent } from '../types.js';
import { clearTraceparentSlot, publishTraceparentSlot } from './traceparent.js';

/** Resolved options for the bridge — every field defaulted by {@link start}. */
export interface BridgeOptions {
  /** Tracer name for `trace.getTracer(...)`. Default `@adonis-agora/diagnostics`. */
  tracerName?: string;
  /** Record POINT `emit`s as events on the active span. Default `true`. */
  recordPointEvents?: boolean;
  /** Cap on open (un-ended) spans before the oldest is force-ended. Default `10000`. */
  maxOpenSpans?: number;
  /**
   * Bridge events whose `lib:event` key is CLAIMED by a lib-specific consumer
   * via {@link claimDiagnostics}. Default `false`: claimed keys are skipped here
   * because the claiming lib already produces its own typed observation for
   * them, and bridging them again would duplicate every such event (once typed,
   * once as a generic OTel span/event). Set `true` to bridge everything
   * regardless of claims, e.g. to see the raw feed alongside the typed one while
   * debugging.
   */
  recordClaimed?: boolean;
}

const DEFAULT_TRACER_NAME = '@adonis-agora/diagnostics';
const DEFAULT_MAX_OPEN_SPANS = 10_000;

/** A live subscription so {@link stop} can tear it down. */
interface ActiveSub {
  name: string;
  listener: (msg: unknown) => void;
}

/** True when `value` is a valid OTel attribute value (primitive or array of them). */
function isAttributeValue(value: unknown): value is AttributeValue {
  if (value === null) return false;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return true;
  if (Array.isArray(value)) {
    return value.every((v) => {
      const it = typeof v;
      return v == null || it === 'string' || it === 'number' || it === 'boolean';
    });
  }
  return false;
}

/**
 * Flatten a payload's own enumerable scalar/array fields into namespaced span
 * attributes (`agora.payload.<key>`). Best-effort: non-objects and non-scalar
 * fields are skipped; never throws.
 */
function payloadAttributes(payload: unknown): Attributes {
  const attrs: Attributes = {};
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return attrs;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (isAttributeValue(value)) attrs[`agora.payload.${key}`] = value;
  }
  return attrs;
}

/**
 * The OTel bridge. Subscribes to every `agora:<lib>:<event>` base channel (for
 * POINT events) and its five span sub-channels (for spans). Reconstructs an OTel
 * span per agora `spanId`: `start` opens a span (parented to `context.active()`
 * at publish time), `end`/`asyncEnd` close it OK, `error` records the exception
 * and closes it ERROR.
 *
 * Zero-overhead when no OTel SDK is registered: every `@opentelemetry/api` call
 * resolves to a no-op span/tracer, so the bridge still subscribes but produces
 * nothing. Safe to ship on by default.
 */
export class DiagnosticsOtelBridge {
  readonly #tracerName: string;
  readonly #recordPointEvents: boolean;
  readonly #maxOpenSpans: number;
  readonly #recordClaimed: boolean;

  /** Lazily-resolved tracer — re-read each `start` so a late-registered SDK wins. */
  #tracer: Tracer | null = null;

  /** Open spans keyed by agora `spanId`. Insertion order = age, for the LRU cap. */
  readonly #open = new Map<string, Span>();

  readonly #subs: ActiveSub[] = [];
  #offRegistered: (() => void) | null = null;
  #started = false;

  constructor(opts: BridgeOptions = {}) {
    this.#tracerName = opts.tracerName ?? DEFAULT_TRACER_NAME;
    this.#recordPointEvents = opts.recordPointEvents ?? true;
    this.#maxOpenSpans = opts.maxOpenSpans ?? DEFAULT_MAX_OPEN_SPANS;
    this.#recordClaimed = opts.recordClaimed ?? false;
  }

  /** Number of currently-open (un-ended) spans. Exposed for tests/introspection. */
  get openSpanCount(): number {
    return this.#open.size;
  }

  #tracerFor(): Tracer {
    if (this.#tracer === null) this.#tracer = trace.getTracer(this.#tracerName);
    return this.#tracer;
  }

  /**
   * Subscribe to all current + future agora channels and publish the global
   * traceparent slot. Idempotent.
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;

    for (const base of registeredChannels()) this.#subscribeBase(base);
    this.#offRegistered = onChannelRegistered((name) => this.#subscribeBase(name));

    publishTraceparentSlot();
  }

  /** Unsubscribe everything, force-end any open spans, and clear the global slot. */
  stop(): void {
    if (!this.#started) return;
    this.#started = false;

    this.#offRegistered?.();
    this.#offRegistered = null;
    for (const { name, listener } of this.#subs) {
      diagnostics_channel.channel(name).unsubscribe(listener);
    }
    this.#subs.length = 0;

    for (const span of this.#open.values()) {
      try {
        span.end();
      } catch {
        // Defensive cleanup must never throw.
      }
    }
    this.#open.clear();

    clearTraceparentSlot();
  }

  /** Subscribe the POINT base channel and its five span sub-channels. */
  #subscribeBase(base: string): void {
    const point = (msg: unknown) => this.#onPoint(msg as DiagnosticEvent);
    this.#subscribe(base, point);

    const names = deriveSpanChannels(base);
    if (names === null) return;
    const span = (msg: unknown) => this.#onSpan(msg as SpanEvent);
    this.#subscribe(names.start, span);
    this.#subscribe(names.end, span);
    this.#subscribe(names.asyncStart, span);
    this.#subscribe(names.asyncEnd, span);
    this.#subscribe(names.error, span);
  }

  #subscribe(name: string, listener: (msg: unknown) => void): void {
    diagnostics_channel.channel(name).subscribe(listener);
    this.#subs.push({ name, listener });
  }

  /** Handle a POINT event: add it to the active span as an event, best-effort. */
  #onPoint(event: DiagnosticEvent): void {
    if (!this.#recordPointEvents) return;
    // Checked at RECORD time (not subscribe time) so claiming stays
    // order-independent — see the contract documented on isDiagnosticClaimed.
    if (!this.#recordClaimed && isDiagnosticClaimed(event.lib, event.event)) return;
    try {
      const active = trace.getActiveSpan();
      if (active === undefined) return;
      const attrs: Attributes = {
        'agora.lib': event.lib,
        'agora.event': event.event,
        ...payloadAttributes(event.payload),
      };
      active.addEvent(`agora.${event.lib}.${event.event}`, attrs, event.ts);
    } catch {
      // Observability must never break the emitting path.
    }
  }

  /** Handle one span phase event, mutating the per-spanId OTel span. */
  #onSpan(event: SpanEvent): void {
    // Same claim gating as point traffic, keyed by the same `lib:event` pair
    // (phase-independent) and checked at record time for order-independence.
    if (!this.#recordClaimed && isDiagnosticClaimed(event.lib, event.event)) return;
    try {
      switch (event.phase) {
        case 'start':
          this.#onStart(event);
          break;
        case 'end':
          // `end` fires for BOTH sync and async ops (mirroring Node's tracingChannel).
          // Only a sync `end` completes the span; an async `end` is the synchronous
          // prelude of a promise-returning op and `asyncEnd` will complete that one.
          if (isCompletingEnd(event)) this.#closeOk(event);
          break;
        case 'asyncEnd':
          this.#closeOk(event);
          break;
        case 'asyncStart':
          // The continuation began — nothing to record on the span itself.
          break;
        case 'error':
          this.#onError(event);
          break;
      }
    } catch {
      // Never let span reconstruction break the traced path.
    }
  }

  #onStart(event: SpanEvent): void {
    const span = this.#tracerFor().startSpan(
      `agora.${event.lib}.${event.event}`,
      {
        startTime: event.ts,
        attributes: {
          'agora.lib': event.lib,
          'agora.event': event.event,
          ...(event.traceId !== undefined ? { 'agora.trace_id': event.traceId } : {}),
          ...payloadAttributes(event.payload),
        },
      },
      context.active(),
    );
    this.#open.set(event.spanId, span);
    this.#enforceCap();
  }

  /** Close a span OK, recording its result + duration. Shared by `end` and `asyncEnd`. */
  #closeOk(event: SpanEvent): void {
    const span = this.#open.get(event.spanId);
    if (span === undefined) return;

    if (event.result !== undefined) {
      const resultAttr = scalarAttr(event.result);
      if (resultAttr !== undefined) span.setAttribute('agora.result', resultAttr);
    }
    if (event.durationMs !== undefined) {
      span.setAttribute('agora.duration_ms', event.durationMs);
    }
    span.setStatus({ code: SpanStatusCode.OK });
    this.#endSpan(event.spanId, span, event.ts);
  }

  #onError(event: SpanEvent): void {
    const span = this.#open.get(event.spanId);
    if (span === undefined) return;
    const err = event.error;
    if (err instanceof Error) {
      span.recordException(err);
    } else if (err !== undefined) {
      span.recordException({ message: String(err) });
    }
    if (event.durationMs !== undefined) {
      span.setAttribute('agora.duration_ms', event.durationMs);
    }
    span.setStatus({
      code: SpanStatusCode.ERROR,
      ...(err instanceof Error ? { message: err.message } : {}),
    });
    this.#endSpan(event.spanId, span, event.ts);
  }

  #endSpan(spanId: string, span: Span, ts: number): void {
    span.end(ts);
    this.#open.delete(spanId);
  }

  /** Force-end the oldest open spans when over the configured cap. */
  #enforceCap(): void {
    while (this.#open.size > this.#maxOpenSpans) {
      const oldest = this.#open.keys().next();
      if (oldest.done === true) break;
      const spanId = oldest.value;
      const span = this.#open.get(spanId);
      this.#open.delete(spanId);
      if (span === undefined) continue;
      try {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'span capped (no end observed)' });
        span.end();
      } catch {
        // Defensive cleanup must never throw.
      }
    }
  }
}

/**
 * Whether a `phase: 'end'` event completes its span. trace.ts publishes `end` for
 * both sync and async ops, but only the sync `end` carries a `result` key — the
 * async `end` is the synchronous prelude (completed later by `asyncEnd`). The
 * `result` value may itself be `undefined` (a sync fn that returns `undefined`),
 * so this tests for the KEY's presence, which is the wire contract set by
 * `publishPhase` in trace.ts, not the value.
 */
function isCompletingEnd(event: SpanEvent): boolean {
  return 'result' in event;
}

/** Coerce a result into a single scalar attribute, or `undefined` if unusable. */
function scalarAttr(value: unknown): AttributeValue | undefined {
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value as AttributeValue;
  return undefined;
}

/**
 * Derive the five span sub-channel names from an `agora:<lib>:<event>` base
 * name, or `null` when the name doesn't match the convention. Parses the name
 * through the shared {@link parseChannelName} (single source of the lib/event
 * boundary) and builds the suffixes via {@link traceChannelNames}.
 */
function deriveSpanChannels(base: string): ReturnType<typeof traceChannelNames> | null {
  const ref = parseChannelName(base);
  if (ref === null) return null;
  return traceChannelNames(ref.lib, ref.event);
}
