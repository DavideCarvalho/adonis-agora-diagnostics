---
name: diagnostics-typed-payloads
description: >
  Type-safe channels and cross-repo contracts for @adonis-agora/diagnostics.
  Covers ChannelRegistry and CapabilityRegistry augmentation via declare module,
  PayloadOf/LibOf/EventOf/CapabilityOf helpers, why the untyped unknown path stays
  open (string & {}), the capability protocol (capability(), assertCapabilityNaming,
  EMIT_SLOT/TRACE_SLOT republish), the claim registry (claimDiagnostics/
  isDiagnosticClaimed reference counting, recordClaimed override), and traceId
  auto-fill via setContextAccessor/getContextAccessor/resolveTraceId. Use when adding
  compile-time payload checks to emit/trace, resolving Symbol.for slots with types,
  deduping a lib-specific consumer against the generic OTel bridge, or wiring a
  custom context accessor.
metadata:
  type: core
  library: "@adonis-agora/diagnostics"
  library_version: "0.2.6"
sources:
  - "DavideCarvalho/adonis-diagnostics:docs/typed-payloads.mdx"
  - "DavideCarvalho/adonis-diagnostics:docs/claims.mdx"
  - "DavideCarvalho/adonis-diagnostics:packages/core/src/types.ts"
  - "DavideCarvalho/adonis-diagnostics:packages/core/src/claims.ts"
---

# Typed payloads, capabilities, and claims

The bus imposes no schema: `emit`'s payload is `unknown` by default. A producing
library opts into compile-time payload checking by augmenting the purely type-level
`ChannelRegistry` — no runtime cost, no runtime registry. The same mechanism applied
to `globalThis` capability slots is the `CapabilityRegistry`. The claim registry then
coordinates *consumers*: it tells the generic OpenTelemetry bridge which `lib:event`
pairs a lib-specific consumer already records first-class.

## Setup

Declare your channels in any file your `tsconfig` compiles (it needs to be compiled,
not imported at runtime):

```ts
// types/diagnostics.ts
import '@adonis-agora/diagnostics'

declare module '@adonis-agora/diagnostics' {
  interface ChannelRegistry {
    billing: {
      'invoice-paid': { invoiceId: string; amount: number }
      'invoice-voided': { invoiceId: string; reason: string }
    }
  }
}
```

Declared pairs are now checked everywhere; every other pair keeps working untyped:

```ts
import { emit } from '@adonis-agora/diagnostics'

// ✓ payload checked against the declared shape:
emit('billing', 'invoice-paid', { invoiceId: 'inv_1', amount: 4200 })

// ✓ an undeclared channel is untouched — payload stays unknown:
emit('search', 'query', { q: 'shoes' })
```

## Core patterns

### 1. Read a declared payload back out with `PayloadOf`

The exported helpers drive the narrowing; use them for building typed wrappers.

```ts
import type { PayloadOf } from '@adonis-agora/diagnostics'

function recordInvoice(p: PayloadOf<'billing', 'invoice-paid'>) {
  // p: { invoiceId: string; amount: number }
}
```

Source: `docs/typed-payloads.mdx` § The type helpers

### 2. Resolve a globalThis capability slot with a type

Optional peers publish accessors/functions on `Symbol.for('@agora/<lib>:<name>')`
slots. Augment `CapabilityRegistry`, then look the value up structurally — no import
of the peer, no-op when absent.

```ts
import type { ContextAccessor } from '@adonis-agora/context'
import { capability, type CapabilityOf } from '@adonis-agora/diagnostics'

declare module '@adonis-agora/diagnostics' {
  interface CapabilityRegistry {
    context: { accessor: ContextAccessor }
  }
}

const accessor = (globalThis as Record<symbol, unknown>)[capability('context', 'accessor')] as
  | CapabilityOf<'context', 'accessor'>
  | undefined
```

Source: `docs/typed-payloads.mdx` § The CapabilityRegistry

### 3. Claim events a lib-specific consumer already records

Call `claimDiagnostics(lib, events)` once when your typed consumer starts; the generic
OTel bridge then skips those keys at record time. Claims are reference-counted and the
release function is idempotent.

```ts
import { claimDiagnostics } from '@adonis-agora/diagnostics'

const release = claimDiagnostics('media', ['upload.complete'])
// … on consumer teardown:
release()
```

Source: `docs/claims.mdx` § claimDiagnostics — stake a claim

### 4. Correlate with traceId (or install a custom accessor)

With `@adonis-agora/context` installed, every envelope auto-fills `traceId` — its
provider soft-registers the accessor at boot. An explicit `opts.traceId` wins.
`setContextAccessor`/`getContextAccessor`/`resolveTraceId` are the seam for custom wiring.

```ts
import { emit, getContextAccessor, resolveTraceId } from '@adonis-agora/diagnostics'

emit('billing', 'invoice-paid', payload, { traceId: ctx.request.id() }) // explicit wins
resolveTraceId()       // current id or undefined — never throws
getContextAccessor()   // registered accessor, or null when unset
```

Source: `docs/getting-started.mdx` § Trace correlation

## Common mistakes

### [HIGH] Hand-rolling a closed union for lib/event names

Augmenting the registry must not turn `lib`/`event` into closed unions — you still
have to be able to emit an undeclared channel. The library's `LibOf`/`EventOf` add
`string & {}` so registered names autocomplete while any other string stays
assignable; replacing them with bare `keyof ChannelRegistry` breaks every untyped call.

```ts
// Wrong — closes the union; emitting an undeclared channel no longer compiles
function myEmit(lib: keyof ChannelRegistry, event: keyof ChannelRegistry[typeof lib]) {}

// Correct — mirror the library's loose form (or just call emit directly)
import type { EventOf, LibOf } from '@adonis-agora/diagnostics'
function myEmit<TLib extends LibOf, TEvent extends EventOf<TLib>>(lib: TLib, event: TEvent) {}
```

Mechanism: `LooseString = string & {}` defeats literal-union widening, keeping the
untyped path assignable no matter how much of the registry is declared.
Source: `docs/typed-payloads.mdx` § why the untyped path survives,
`packages/core/src/types.ts`

### [MEDIUM] Expecting a runtime registry of payload shapes

Nothing validates payloads at runtime — the merge is global to the type checker and
allocates nothing. An observer that switches on "registered" payload shapes gets
whatever the producer actually sent.

```ts
// Wrong — assuming emitted data was validated because the type exists
onDiagnostic('billing', 'invoice-paid', (e) => charge(e.payload.amount))

// Correct — observers still treat payloads as opaque producer data
onDiagnostic('billing', 'invoice-paid', (e) => {
  const p = e.payload as { amount?: number }
  if (typeof p.amount === 'number') charge(p.amount)
})
```

Mechanism: `ChannelRegistry` exists only in the type system; the published envelope is
the plain `unknown`-payload `DiagnosticEvent`.
Source: `docs/typed-payloads.mdx` intro callout, `packages/core/src/types.ts`

### [MEDIUM] Assuming one release() un-claims for everyone

Claims are reference-counted per call: claiming an already-claimed key increments,
and each release decrements exactly the keys its own call added. One consumer
releasing does not un-claim while another still holds the key.

```ts
// Wrong — expecting A's release to re-enable generic bridging while B holds a claim
const releaseA = claimDiagnostics('media', ['upload.complete'])
claimDiagnostics('media', ['upload.complete'])
releaseA()
isDiagnosticClaimed('media', 'upload.complete') // → true (B holds it)

// Correct — drop recordClaimed on the bridge instead when debugging both feeds
start({ recordClaimed: true })
```

Mechanism: the claim store maps `lib:event` → count and deletes the key only when the
count reaches 0; the bridge consults it per event at record time.
Source: `docs/claims.mdx` § Reference counting / § Overriding the dedup,
`packages/core/src/claims.ts`

See also: `diagnostics-transports-otel/SKILL.md` — where the bridge reads claims
(`recordClaimed`) and how spans land in OTel.
