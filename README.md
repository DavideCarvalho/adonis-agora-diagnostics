# `@adonis-agora/diagnostics`

> A standard convention for **Agora** AdonisJS libs to emit observability events
> over [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html)
> — recorded by a single generic Telescope watcher, with zero coupling between
> emitter and observer.

Every Agora lib publishes on `agora:<lib>:<event>`. Anything that wants to observe
(Telescope, a metrics exporter, your own handler) subscribes — there is no import
between them, only the channel-name wire contract.

## Install

```sh
npm i @adonis-agora/diagnostics
node ace configure @adonis-agora/diagnostics
```

`configure` registers the provider and publishes two files: `config/diagnostics.ts`
(the `otel` flag and the cross-process transports) and `start/diagnostics.ts`
(preloaded), where you register handlers.

## Emit

```ts
import { emit, trace } from '@adonis-agora/diagnostics'

// POINT event — free when nothing is subscribed:
emit('billing', 'invoice-paid', { invoiceId: 'inv_123', amount: 4200 })

// SPAN — start/end/error with timing (sync or async):
const decision = trace('authz', 'decision', () => evaluate(req), { subject })
```

`traceId` auto-fills from `@adonis-agora/context` when installed (the context provider
soft-registers its accessor). Declare typed payloads via the `ChannelRegistry`
augmentation for compile-time checks.

## Observe

```ts
import { onDiagnostic } from '@adonis-agora/diagnostics'

onDiagnostic('resilience', (event) => log(event))        // every resilience event
onDiagnostic('authz', 'decision', (event) => audit(event)) // one exact channel
```

## Packages

| Package | What |
|---|---|
| [`@adonis-agora/diagnostics`](./packages/core) | emit / trace / onDiagnostic over `node:diagnostics_channel`, plus the OpenTelemetry bridge and the cross-process Redis / `@adonisjs/queue` transports (selected in `config/diagnostics.ts`) |

## The Agora ecosystem

AdonisJS port of the [aviary](https://github.com/DavideCarvalho) NestJS ecosystem.
Built on [`@adonis-agora/context`](https://github.com/DavideCarvalho/adonis-context) for
trace correlation; recorded by `@adonis-agora/telescope`.

## License

MIT © Davi Carvalho
