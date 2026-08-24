---
name: diagnostics-transports-otel
description: >
  Cross-process fan-out and OpenTelemetry export for @adonis-agora/diagnostics.
  Covers defineConfig keys (otel, default, forward, nodeId, transports), the
  transports.redis/transports.queue factories with lazy peer imports
  (@adonisjs/redis + ioredis, @adonisjs/queue), forward ChannelSelection
  (libs/channels/all), node ace queue:work --queue= flag, worker-only processes,
  getActiveReEmitter/bindRelayReEmitter, custom TransportProvider thunks with
  createChannelSelector, createDiagnosticsRedisRelay/createDiagnosticsQueueRelay,
  and the /otel bridge (start/stop, DiagnosticsOtelBridge, BridgeOptions,
  recordClaimed, recordPointEvents, otelTraceparent). Use when events must reach
  workers or other processes, when relayed events silently never arrive, or when
  wiring trace() spans into an OTel SDK.
metadata:
  type: core
  library: "@adonis-agora/diagnostics"
  library_version: "0.2.6"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-diagnostics:docs/transports.mdx"
  - "DavideCarvalho/adonis-diagnostics:docs/opentelemetry.mdx"
  - "DavideCarvalho/adonis-diagnostics:packages/core/src/define_config.ts"
  - "DavideCarvalho/adonis-diagnostics:packages/core/src/transports/factory.ts"
  - "DavideCarvalho/adonis-diagnostics:providers/diagnostics_provider.ts"
---

# Cross-process transports and the OpenTelemetry bridge

`node:diagnostics_channel` is process-local. A **transport** relays selected
`agora:<lib>:<event>` channels across processes so `onDiagnostic` handlers fire on the
far side; transports ship inside `@adonis-agora/diagnostics` and are picked in
`config/diagnostics.ts` exactly like a session or cache store. The **OTel bridge**
lives in the same package (`@adonis-agora/diagnostics/otel`) and starts automatically
whenever an OTel SDK — i.e. a resolvable `@opentelemetry/api` — is present.

## Setup

Install the driver's peer deps for the transport you select, then configure:

```sh
npm i @adonisjs/redis ioredis
```

```ts
// config/diagnostics.ts
import { defineConfig, transports } from '@adonis-agora/diagnostics'

export default defineConfig({
  otel: true,

  // The transport whose relay starts in this process.
  default: 'redis',

  // Which local channels to fan out across processes.
  forward: { libs: ['resilience', 'durable'] }, // or { all: true }

  transports: {
    redis: transports.redis({ connection: 'main' }),
    queue: transports.queue({ queue: 'diagnostics' }),
  },
})
```

With no `default`, diagnostics stays local-only — everything still works in-process.

## Core patterns

### 1. Worker-only process: select the transport, gate only `forward`

A worker needs its own re-emitter, which is bound by starting the transport there.
An empty `forward` makes it a pure consumer.

```ts
// config/diagnostics.ts (worker build)
import env from '#start/env'
import { defineConfig, transports } from '@adonis-agora/diagnostics'

export default defineConfig({
  default: 'queue',
  forward: env.get('DIAGNOSTICS_FORWARD', false) ? { all: true } : {},
  transports: {
    queue: transports.queue({ queue: 'diagnostics' }),
  },
})
```

Run the worker on the named queue — `--queue=` is a flag:

```sh
node ace queue:work --queue=diagnostics
```

Source: `docs/transports.mdx` § Worker-only processes

### 2. Verify a re-emitter is bound

`getActiveReEmitter()` returns `null` in exactly the state where relayed events go
nowhere in this process.

```ts
import { getActiveReEmitter } from '@adonis-agora/diagnostics'

if (getActiveReEmitter() === null) {
  logger.warn('diagnostics: no re-emitter bound — relayed events are dropped here')
}
```

Source: `docs/transports.mdx` § Worker-only processes

### 3. Route dispatch failures somewhere visible

Through `transports.queue(...)` dispatch rejections already log via the app logger
(`failed to relay diagnostics event to queue`). When driving the relay directly,
wire `onDispatchError` — it is the only way to notice fan-out has silently stopped.
The job is structural: anything with `dispatch(payload)` works, which makes it
testable without a queue backend.

```ts
import { createDiagnosticsQueueRelay } from '@adonis-agora/diagnostics'

const stop = createDiagnosticsQueueRelay({
  job: { dispatch: (payload) => queue.dispatch(payload) }, // your @adonisjs/queue job
  all: true,
  nodeId: 'web-1',
  onDispatchError: (error) => logger.error({ err: error }, 'relay could not reach the queue'),
})
```

Source: `docs/transports.mdx` § When dispatching fails

### 4. Start/stop the OTel bridge manually

The provider auto-starts it when `@opentelemetry/api` resolves (`otel: false` opts
out). The subpath exports are idempotent singletons.

```ts
import { start, stop } from '@adonis-agora/diagnostics/otel'

start({ tracerName: 'my-app', recordClaimed: true })
// …
stop()
```

Source: `docs/opentelemetry.mdx` § Manual control

## Common mistakes

### [CRITICAL] Gating `default` on the environment instead of `forward`

The trap the docs call out by name: with `default` unset, a worker starts no
transport, binds no re-emitter, and every relayed event is silently dropped there —
the job even reports success.

```ts
// Wrong — worker build leaves default unset, so no transport starts at all
export default defineConfig({
  ...(env.get('DIAGNOSTICS_FORWARD', false)
    ? { default: 'queue', forward: { all: true } }
    : {}),
  transports: { queue: transports.queue({ queue: 'diagnostics' }) },
})

// Correct — always select the transport; vary only what gets forwarded
export default defineConfig({
  default: 'queue',
  forward: env.get('DIAGNOSTICS_FORWARD', false) ? { all: true } : {},
  transports: { queue: transports.queue({ queue: 'diagnostics' }) },
})
```

Mechanism: starting the transport is what binds the process re-emitter; without it the
worker executes `agora.diagnostics.event` as a no-op.
Source: `docs/transports.mdx` § Worker-only processes

### [HIGH] Passing the queue name positionally to `queue:work`

`queue` is a flag on `queue:work`, not a positional argument. The positional form
starts a worker on the `default` queue — where the relay never dispatches — so
forwarded events are consumed by nothing and nothing reports the mismatch.

```sh
# Wrong — silently works the wrong queue
node ace queue:work diagnostics

# Correct
node ace queue:work --queue=diagnostics
```

Mechanism: `QueueTransportConfig.queue` dispatches onto that named queue via
`.toQueue(queueName)`; a worker on `default` never sees those jobs.
Source: `docs/transports.mdx` § The queue transport, repo history (fixed docs bug #20)

### [HIGH] Throwing (or blocking) inside a transport's `forward()`

`forward` runs inline inside the `emit()` that produced the event. A throw surfaces in
unrelated application code; a slow send slows the emitting request.

```ts
// Wrong — unguarded publish propagates into the emitter
const forward = (msg: unknown) => nc.publish(SUBJECT, encode(msg))

// Correct — catch everything, keep the send non-blocking
const forward = (msg: unknown) => {
  try {
    nc.publish(SUBJECT, encode(msg))
  } catch (err) {
    logger.error({ err }, 'diagnostics: NATS publish failed')
  }
}
```

Mechanism: `createChannelSelector` subscribes `forward` directly on each matched
channel, so exceptions propagate straight out of `channel.publish`.
Source: `docs/transports.mdx` § Never throw out of forward(),
`packages/core/src/relay.ts`

### [MEDIUM] Expecting duplicate OTel records for claimed channels — or none for POINT emits

Two symmetric surprises: (1) a lib-specific consumer's claimed `lib:event` pairs are
**skipped** by the generic bridge unless `recordClaimed: true`; (2) POINT `emit`s are
recorded as span *events* on the active span — with no active span they are dropped,
not stored.

```ts
// Wrong — debugging with both feeds but seeing only the typed one
start()

// Correct — bridge everything while debugging
start({ recordClaimed: true })
```

```ts
// Wrong — expecting background POINT emits to appear in the trace tree
emit('billing', 'invoice-paid', payload) // no active span → dropped

// Correct — attach them yourself when there is no active span, or use trace()
trace('billing', 'invoice-paid', () => charge(), payload)
```

Mechanism: the bridge checks `isDiagnosticClaimed(lib, event)` per event and adds
POINTs via `trace.getActiveSpan()?.addEvent(...)` semantics.
Source: `docs/opentelemetry.mdx` § What the bridge does / Bridge options,
`packages/core/src/otel/bridge.ts`

### [MEDIUM] Closing the Redis subscriber leg you don't own (or failing to close the one you do)

Only the pub leg belongs to `@adonisjs/redis`; the subscriber is the `duplicate()` the
transport created and closes itself on teardown. When wiring `createDiagnosticsRedisRelay`
by hand, neither connection is closed by `stop()` — leaving sockets open hangs shutdown
and test runs.

```ts
// Wrong — hand-rolled relay leaks the duplicate() socket
const sub = pub.duplicate()
createDiagnosticsRedisRelay({ pub, sub, libs: ['resilience'] })
// process never exits: open socket keeps it alive

// Correct — close what you opened on teardown
const stop = createDiagnosticsRedisRelay({ pub, sub, libs: ['resilience'] })
process.on('shutdown', () => {
  stop()
  ;(sub as { disconnect?: () => void }).disconnect?.()
})
```

Mechanism: `stop()` only unsubscribes and detaches listeners — the relay opened
neither connection, so closing is the caller's job.
Source: `docs/transports.mdx` § The Redis transport /
§ DiagnosticsRedisRelayOptions, `packages/core/src/transports/factory.ts`
