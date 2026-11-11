/**
 * The envelope every `@adonis-agora/*` library publishes over
 * `node:diagnostics_channel`. It is the cross-repo wire contract: the generic
 * Telescope watcher (and any other observer) reads exactly these fields, so keep
 * the shape stable. The `payload` is opaque — its meaning is owned by the
 * emitting library and identified by `lib` + `event`.
 */
export interface DiagnosticEvent<TPayload = unknown> {
  /**
   * Envelope schema version — bumped only when this wire shape changes in a way
   * observers must adapt to. Stamped by `emit` with the current
   * {@link import('./channel.js').SCHEMA_VERSION SCHEMA_VERSION}. Optional on the
   * type so observers stay tolerant of legacy envelopes published before
   * versioning existed (treat an absent `v` as the original, unversioned shape).
   */
  v?: number;
  /**
   * Unique id of this event (a UUID), stamped by `emit`. Relays carry it unchanged, so the same
   * event has the same id in every process. Delivering transports use it as the idempotency key
   * of each `(listener, event)` delivery. Optional on the type so observers stay tolerant of
   * envelopes from copies that predate it.
   */
  id?: string;
  /** Epoch millis when the event was emitted (`Date.now()` at publish time). */
  ts: number;
  /** The emitting library, e.g. `'billing'` — the `<lib>` in `agora:<lib>:<event>`. */
  lib: string;
  /** The event name, e.g. `'invoice-paid'` — the `<event>` in `agora:<lib>:<event>`. */
  event: string;
  /**
   * Trace id for the current request, when resolvable from a context accessor.
   * Always present on the emitted envelope as a stable-shape key (monomorphic);
   * `undefined` when unresolved. Serializes identically to an absent key.
   */
  traceId?: string | undefined;
  /** The library-defined payload. Opaque to this package and to observers. */
  payload: TPayload;
  /**
   * Wall-clock duration of the operation this event describes, in milliseconds,
   * when known. Lets observers build duration histograms (e.g. OTel histogram
   * instruments) instead of only counters. Omit when the event is not tied to a
   * timed operation. Stamped from {@link EmitOptions.durationMs} by `emit`.
   */
  durationMs?: number;
}

/**
 * The optional, consumer-augmented typed channel registry: a `lib → event →
 * payload` map. It is EMPTY by default — the untyped path (`payload: unknown`)
 * is always available and unchanged. A library declares its channels by
 * augmenting this interface via TypeScript declaration merging:
 *
 * ```ts
 * declare module '@adonis-agora/diagnostics' {
 *   interface ChannelRegistry {
 *     billing: {
 *       'invoice-paid': { invoiceId: string; amount: number };
 *     };
 *   }
 * }
 * ```
 *
 * Once augmented, `emit('billing', 'invoice-paid', ...)` and
 * `trace('billing', 'invoice-paid', ...)` get compile-time payload checking for
 * that channel; every other `(lib, event)` pair keeps the untyped `unknown`
 * payload. This is purely a type-level mechanism: there is no runtime registry
 * of payload shapes and nothing is allocated.
 */
export interface ChannelRegistry {}

/**
 * `string`, kept assignable from any literal but offering autocomplete for the
 * registered names. The `& {}` defeats literal-union widening so registered
 * keys still surface as suggestions while every other string is accepted — this
 * is what keeps the untyped path open even after the registry is augmented.
 */
type LooseString = string & {};

/**
 * Every `lib` declared in the {@link ChannelRegistry} (for autocomplete), plus
 * any other `string` (the untyped path). Collapses to plain `string` when the
 * registry is empty.
 */
export type LibOf = (keyof ChannelRegistry & string) | LooseString;

/**
 * Every `event` declared for `TLib` in the {@link ChannelRegistry} (for
 * autocomplete), plus any other `string` (the untyped path). Collapses to plain
 * `string` when `TLib` is not a registered lib.
 */
export type EventOf<TLib extends string> = TLib extends keyof ChannelRegistry
  ? (keyof ChannelRegistry[TLib] & string) | LooseString
  : string;

/**
 * The declared payload type for `(TLib, TEvent)` in the {@link ChannelRegistry},
 * or `unknown` when the pair is not registered. This is what gives `emit`/`trace`
 * their compile-time payload types for registered channels while leaving every
 * other call on the original untyped `unknown` path.
 */
export type PayloadOf<
  TLib extends string,
  TEvent extends string,
> = TLib extends keyof ChannelRegistry
  ? TEvent extends keyof ChannelRegistry[TLib]
    ? ChannelRegistry[TLib][TEvent]
    : unknown
  : unknown;

/**
 * The phase of a traced operation, published as `phase` on every
 * {@link SpanEvent}. Mirrors Node's `tracingChannel` sub-channels so observers
 * can pair start/end and start/error into span-like records.
 */
export type SpanPhase = 'start' | 'end' | 'asyncStart' | 'asyncEnd' | 'error';

/**
 * The envelope published on the span sub-channels by `trace`. Extends the
 * {@link DiagnosticEvent} POINT shape with span correlation + timing so a
 * consumer can reconstruct real start/end/error pairs:
 *
 * - `agora:<lib>:<event>:start` — `phase: 'start'`, carries `payload`.
 * - `agora:<lib>:<event>:end` — sync (or settled) completion, carries `result`
 *   + `durationMs`.
 * - `agora:<lib>:<event>:asyncStart` / `:asyncEnd` — the async continuation of
 *   a promise-returning op; `asyncEnd` carries `result`/`error` + `durationMs`.
 * - `agora:<lib>:<event>:error` — `phase: 'error'`, carries `error` (+
 *   `durationMs`).
 *
 * Every event of a single span shares a `spanId` so observers can correlate
 * them without relying on subscription ordering.
 */
export interface SpanEvent<TPayload = unknown, TResult = unknown> {
  /**
   * Span envelope schema version, stamped by `trace` with
   * {@link import('./trace.js').SPAN_SCHEMA_VERSION SPAN_SCHEMA_VERSION}.
   * Versioned independently of the POINT {@link DiagnosticEvent} `v`. Optional
   * so observers stay tolerant of legacy/untagged envelopes.
   */
  v?: number;
  /** Unique id of this phase event (a UUID), stamped by `trace`. Distinct from {@link spanId}. */
  id?: string;
  /** Epoch millis when this phase event was published (`Date.now()`). */
  ts: number;
  /** The emitting library — the `<lib>` in `agora:<lib>:<event>`. */
  lib: string;
  /** The traced operation name — the `<event>` in `agora:<lib>:<event>`. */
  event: string;
  /** Which phase of the span this is. */
  phase: SpanPhase;
  /**
   * Stable per-span correlation id shared by every phase event of one `trace`
   * call. Lets observers pair start↔end / start↔error regardless of ordering.
   */
  spanId: string;
  /**
   * Trace id for the current request, when resolvable. Same semantics + stable
   * monomorphic shape as {@link DiagnosticEvent.traceId}.
   */
  traceId?: string | undefined;
  /** The caller-supplied payload, present on the `start` event. */
  payload?: TPayload;
  /** The operation's return value, present on `end`/`asyncEnd` on success. */
  result?: TResult;
  /** The thrown/rejected value, present on `error` (and `asyncEnd` on failure). */
  error?: unknown;
  /**
   * Wall-clock duration in fractional millis from `start` to this phase,
   * present on `end`/`asyncEnd`/`error`. Measured with `performance.now()`.
   */
  durationMs?: number;
}

/** Optional per-emit overrides. */
export interface EmitOptions {
  /**
   * An explicit trace id for this event. When provided it wins over the
   * registered {@link ContextAccessor}. Omit to auto-fill from the accessor (if
   * any), or leave `traceId` undefined.
   */
  traceId?: string;
  /**
   * Optional load-shedding hook. Consulted by `emit` only AFTER the channel has
   * subscribers and BEFORE the envelope is built/published: return `false` to
   * drop this event without allocating the envelope, `true` to publish. Omit for
   * the default (always publish when subscribed). A thrown sampler is treated as
   * a skip — observability must never break the caller. Hot libraries can pass a
   * cheap probabilistic predicate, e.g. `{ sample: () => Math.random() < 0.1 }`.
   */
  sample?: () => boolean;
  /**
   * Wall-clock duration of the operation this event describes, in milliseconds.
   * When provided, `emit` stamps it onto the {@link DiagnosticEvent} envelope as
   * `durationMs`, letting downstream observers (e.g. the Telescope OTel exporter)
   * build duration histograms instead of only counters.
   */
  durationMs?: number;
}

/** Optional per-`trace` overrides. */
export interface TraceOptions {
  /**
   * An explicit trace id for the whole span. When provided it wins over the
   * registered {@link ContextAccessor} and is stamped on every phase event.
   * Omit to auto-fill from the accessor (resolved once at span start).
   */
  traceId?: string;
}
