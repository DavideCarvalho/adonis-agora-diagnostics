---
name: diagnostics-setup
description: >
  Emit and observe AdonisJS diagnostics events with @adonis-agora/diagnostics.
  Covers node ace configure, config/diagnostics.ts, the preloaded
  start/diagnostics.ts, emit() POINT events with durationMs/sample opts, trace()
  and tracingChannel() spans on agora:<lib>:<event>:start|end|asyncStart|asyncEnd|error,
  onDiagnostic wildcard/exact subscriptions with onError, unsubscribeAll lifecycle,
  channelName/traceChannelNames/getChannel, and asserting events in tests with
  resetRegistry. Use when wiring emitting or observing into an app or library,
  timing operations, correlating via traceId, or writing event assertions.
metadata:
  type: core
  library: "@adonis-agora/diagnostics"
  library_version: "0.2.6"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-diagnostics:docs/getting-started.mdx"
  - "DavideCarvalho/adonis-diagnostics:docs/consumers.mdx"
  - "DavideCarvalho/adonis-diagnostics:packages/core/src/channel.ts"
  - "DavideCarvalho/adonis-diagnostics:packages/core/src/trace.ts"
  - "DavideCarvalho/adonis-diagnostics:packages/core/src/subscriber.ts"
---

# Diagnostics setup: emit POINT events, trace spans, observe

`@adonis-agora/diagnostics` publishes observability events over Node's built-in
`node:diagnostics_channel`. A producer calls `emit(lib, event, payload)` (a POINT
"this happened" fact) or wraps work in `trace(lib, event, fn)` (a SPAN with timing);
observers subscribe to `agora:<lib>:<event>` channels without importing the producer.
Emitting is gated on `channel.hasSubscribers`, so it is effectively free when nothing
listens, and never throws.

## Setup

```sh
node ace add @adonis-agora/diagnostics
```

Configure leaves three things in the app: the provider registered in `adonisrc.ts`,
`config/diagnostics.ts` (the `otel` flag and cross-process transports), and
`start/diagnostics.ts` registered as a **preload file** so handlers subscribe before
the app serves traffic:

```ts
// start/diagnostics.ts — preloaded at boot
import { onDiagnostic } from '@adonis-agora/diagnostics'

onDiagnostic('resilience', (event) => {
  console.log(event.lib, event.event, event.traceId)
})

onDiagnostic('authz', 'decision', (event) => {
  if ((event.payload as { allowed?: boolean }).allowed === false) alertOnDenial(event)
})
```

Emit from anywhere in the app (or any Agora library):

```ts
import { emit, trace } from '@adonis-agora/diagnostics'

emit('billing', 'invoice-paid', { invoiceId: 'inv_123', amount: 4200 })

const decision = trace('authz', 'decision', () => evaluate(req), { subject })
```

## Core patterns

### 1. Time a POINT event with `durationMs`

Pass `durationMs` when one timed fact is enough — it lands on the envelope (not
inside your payload) so generic observers can build p50/p95/p99 histograms. Reach for
`trace()` instead when you want start/end/error as separate correlated events.

```ts
import { emit } from '@adonis-agora/diagnostics'

const startedAt = performance.now()
const rows = await runReport(params)

emit('reporting', 'report-generated', { reportId, rows: rows.length }, {
  durationMs: performance.now() - startedAt,
})
```

Source: `docs/getting-started.mdx` § Timing a POINT event

### 2. Load-shed a hot event with `sample`

The sampler runs after the `hasSubscribers` gate and before the envelope is built, so
a dropped event allocates nothing; a throwing sampler counts as a skip.

```ts
import { emit } from '@adonis-agora/diagnostics'

// Publish ~10% of decisions even while observed:
emit('authz', 'decision', payload, { sample: () => Math.random() < 0.1 })
```

Source: `docs/getting-started.mdx` § Load-shedding a hot event

### 3. Trace spans with `tracingChannel` for hot call sites

`trace` publishes five sub-channels (`…:start`, `…:end`, `…:asyncStart`,
`…:asyncEnd`, `…:error`); every phase of one call shares a `spanId`, and `fn`'s
return value or thrown error propagates unchanged. Bind once per site with
`tracingChannel`.

```ts
import { tracingChannel } from '@adonis-agora/diagnostics'

const decision = tracingChannel('authz', 'decision')
decision.trace(() => evaluate(req), { subject })

const result = await trace('durable', 'step', () => runStep(), { name })
```

Source: `docs/getting-started.mdx` § Tracing spans, `packages/core/src/trace.ts`

### 4. Assert events in tests

Events are only built when something is subscribed, so a test drops a collector first,
exercises the code, then asserts. `resetRegistry()` gives registry-assertion tests a
clean slate.

```ts
import { emit, onDiagnostic } from '@adonis-agora/diagnostics'
import type { DiagnosticEvent } from '@adonis-agora/diagnostics'

const seen: DiagnosticEvent[] = []
const off = onDiagnostic('authz', 'decision', (e) => seen.push(e))

emit('authz', 'decision', { allowed: false })

off()
expect(seen).toHaveLength(1)
expect((seen[0].payload as { allowed?: boolean }).allowed).toBe(false)
```

Source: `docs/consumers.mdx` § In tests

## Common mistakes

### [HIGH] Doing heavy work inside a handler

A subscriber runs **inline** on the producer's `emit`/`trace` call. Network calls or
disk writes in a handler land directly on the emitting request's hot path.

```ts
// Wrong — synchronous network call inside the emitting code path
onDiagnostic('billing', async (event) => {
  await fetch('https://collector.example.com', { method: 'POST', body: JSON.stringify(event) })
})

// Correct — batch/hand off; for cross-process fan-out use a transport
const buffer: unknown[] = []
onDiagnostic('billing', (event) => buffer.push(event))
setInterval(() => flush(buffer.splice(0)), 1000)
```

Mechanism: `onDiagnostic` subscribes the handler directly on the `diagnostics_channel`
listener; only throws/rejections are isolated (routed to `onError`), never slowness.
Source: `docs/consumers.mdx` § Keep handlers cheap, `packages/core/src/subscriber.ts`

### [HIGH] Awaiting an unobserved span's phases

When no span sub-channel has a subscriber, `trace` just calls `fn` — no `spanId`, no
envelopes, no `performance.now()` reads. Code that "waits for the end event" without
subscribing first waits forever.

```ts
// Wrong — nothing is subscribed, so no phase events exist
const seen: unknown[] = []
trace('durable', 'step', () => runStep())
expect(seen).toHaveLength(2) // fails: zero events were ever built

// Correct — subscribe before exercising the traced code
import diagnostics_channel from 'node:diagnostics_channel'
import { traceChannelNames } from '@adonis-agora/diagnostics'

for (const name of Object.values(traceChannelNames('durable', 'step'))) {
  diagnostics_channel.subscribe(name, (msg) => seen.push(msg))
}
```

Mechanism: `trace()` checks `anySubscribed(channels)` and takes the bare `fn()` fast
path when all five sub-channels are unsubscribed.
Source: `docs/getting-started.mdx` § Also free when unobserved,
`packages/core/src/trace.ts`

### [MEDIUM] Treating `end`'s `durationMs` as total time for async ops

For a promise-returning `fn`, the `end` phase fires when the *synchronous* portion
returns; the settled result and full wall-clock duration arrive on `asyncEnd`.
Pairing start→end under-measures every async operation.

```ts
// Wrong — pairing on end loses await time
let started = 0
onDiagnostic('durable', 'step', (e) => { if (e.phase === 'start') started = e.ts })
onDiagnostic('durable', 'step', (e) => {
  if (e.phase === 'end') report(e.durationMs!) // sync portion only
})

// Correct — durationMs on asyncEnd covers start→settle
onDiagnostic('durable', 'step', (e) => {
  if (e.phase === 'start') opened.set(e.spanId, e)
  if (e.phase === 'asyncEnd') report(e.durationMs!, e.spanId!)
})
```

Mechanism: `trace` publishes `end` immediately after the sync prelude, then
`asyncStart`, and only settles `result`+`durationMs` on `asyncEnd`.
Source: `docs/getting-started.mdx` § span table, `packages/core/src/trace.ts`

### [MEDIUM] Calling `resetRegistry()` outside tests

`resetRegistry()` forgets every registered channel and listener and drops the memoized
channel cache. In a running app it deregisters channels live observers rely on for
discovery, so their wildcards stop matching future channels.

```ts
// Wrong — app code "cleaning up" the global registry between requests
export function purgeTelemetry() {
  resetRegistry()
}

// Correct — tear down only your own subscriptions (the provider does this on shutdown)
export function stopObserving(off: Array<() => void>) {
  off.forEach((fn) => fn())
}
```

Mechanism: after a reset, channels cached before it never re-register and stay
invisible to discovery for the rest of the process lifetime.
Source: `docs/consumers.mdx` § Asserting on the registry

See also: `diagnostics-transports-otel/SKILL.md` — cross-process fan-out keeps handlers
cheap by moving observation out of this process.
