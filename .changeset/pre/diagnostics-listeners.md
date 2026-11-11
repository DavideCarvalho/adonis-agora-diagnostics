---
"@adonis-agora/diagnostics": minor
---

Listeners and delivering transports.

- `@OnDiagnostic(lib, event?)` marks listener class methods; `event` is an exact name, a `RegExp`, or omitted for every event of the lib. Classes in `app/listeners/diagnostics` are registered at boot (`listenersPath` in the config, `false` to turn it off), and `onDiagnostic(lib, event, [Listener, 'method'])` registers one from a preload, with lazy imports. Each listener has a stable id (`<file>#<method>` or `<ClassName>#<method>`). Listener payloads are typed through the `ChannelRegistry` (`DiagnosticEventOf<lib, event>`), and so is the payload of `onDiagnostic(lib, event, fn)`.
- The selected transport decides how listeners run: in-process with no transport, in every process with `redis`, once in a worker with `queue` (one `agora.diagnostics.listener` job per listener and event, retried on error, new `retries` option, default 3), or as durable runs with the new `transports.durable(options)`. Delivering transports deliver once, from the emitting process, and never re-deliver relayed copies.
- `transports.durable()` loads `@adonis-agora/durable/diagnostics` only when it is the selected default, and fails at boot with a clear error when durable is not installed, too old, or not configured. `@adonis-agora/durable` is a new optional peer.
- Every `emit` and `trace` envelope carries a unique `id`, preserved by the relays.
- The listener delivery contract is typed in the new `@adonis-agora/diagnostics/delivery` subpath (types only): `ListenerDeliveryTransport`, `ListenerDelivery`, `DeliveryTransportContext`, `ListenerInvoker`, `DurableDiagnosticsModule`. A `TransportProvider` may now return a `TransportHandle` with `deliver` instead of a teardown function; teardown functions keep working.
- `onDiagnostic(fn)` observers and raw channel subscribers (Telescope, OpenTelemetry) are unchanged.
