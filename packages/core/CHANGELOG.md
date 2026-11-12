# @adonis-agora/diagnostics

## 1.0.0-rc.4

### Minor Changes

- [#141](https://github.com/DavideCarvalho/adonis-agora-diagnostics/pull/141) [`cb3c962`](https://github.com/DavideCarvalho/adonis-agora-diagnostics/commit/cb3c9623958a68b97b8c5cdc17b58965d198c2b9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `node ace agora:doctor` (the shared Agora health check) and `node ace diagnostics:doctor`, with checks `diagnostics.transport`, `diagnostics.role`, `diagnostics.recent-buffer`, `diagnostics.listeners` and `diagnostics.otel`. New commands barrel `@adonis-agora/diagnostics/commands` (registered by `configure`; existing apps add it to `adonisrc.ts`) and `@adonis-agora/diagnostics/doctor` entry for `--no-boot`.

## 1.0.0-rc.3

### Minor Changes

- [#140](https://github.com/DavideCarvalho/adonis-agora-diagnostics/pull/140) [`d4a9d49`](https://github.com/DavideCarvalho/adonis-agora-diagnostics/commit/d4a9d49a4e33489399374c95c6070ef65d9b3712) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Dev MCP tools on `@adonis-agora/agent`'s `/mcp/agora` endpoint (gated by its `devTools.authorize`): `diagnostics_list_channels`, `diagnostics_list_listeners`, `diagnostics_list_recent_events`. New recent-events buffer (`recentEvents()`, `recent` option: on outside production with the dev tools, off in production unless set), `devTools` option, and `transportInfo()` to tell which built-in transport a provider is.

## 1.0.0-rc.2

### Minor Changes

- [#138](https://github.com/DavideCarvalho/adonis-agora-diagnostics/pull/138) [`817301a`](https://github.com/DavideCarvalho/adonis-agora-diagnostics/commit/817301a8f0ea5cfd9da70e6bc77bfcf4135fa7a0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `role` in `config/diagnostics.ts`: which half of a split deployment this process is, the same `'all' | 'api' | 'worker'` as `@adonis-agora/payments`.
  
  - `'all'` (default) keeps today's behaviour.
  - `'api'` emits, forwards through the `default` transport and hands listener work to it, but never consumes and never runs a listener: `redis` publishes without opening a subscriber, `queue` binds no re-emitter and no listener invoker (a listener job that lands there fails and is retried), `durable` starts the runs and leaves them to `durable:work` (set durable's `drive: false` on those processes). `onDiagnostic(fn)` observers still see the events the process emits.
  - `'worker'` consumes and runs listeners, like `'all'`. The worker half is `node ace queue:work` for `queue`, `node ace durable:work` for `durable`, and any long-running process for `redis`; there is no `diagnostics:work` command.
  - `'api'` and `'worker'` without a `default` transport fail at boot.
  - `createDiagnosticsRedisRelay` and `createDiagnosticsQueueRelay` take `receive: false` for a forward-only relay (`sub` is then optional), and `TransportContext` carries `role` for custom transports.

## 1.0.0-rc.1

### Minor Changes

- [#135](https://github.com/DavideCarvalho/adonis-agora-diagnostics/pull/135) [`31090ce`](https://github.com/DavideCarvalho/adonis-agora-diagnostics/commit/31090cec038522c53e531eb6880e1072cb5391c4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Listeners and delivering transports.
  
  - `@OnDiagnostic(lib, event?)` marks listener class methods; `event` is an exact name, a `RegExp`, or omitted for every event of the lib. Classes in `app/listeners/diagnostics` are registered at boot (`listenersPath` in the config, `false` to turn it off), and `onDiagnostic(lib, event, [Listener, 'method'])` registers one from a preload, with lazy imports. Each listener has a stable id (`<file>#<method>` or `<ClassName>#<method>`). Listener payloads are typed through the `ChannelRegistry` (`DiagnosticEventOf<lib, event>`), and so is the payload of `onDiagnostic(lib, event, fn)`.
  - The selected transport decides how listeners run: in-process with no transport, in every process with `redis`, once in a worker with `queue` (one `agora.diagnostics.listener` job per listener and event, retried on error, new `retries` option, default 3), or as durable runs with the new `transports.durable(options)`. Delivering transports deliver once, from the emitting process, and never re-deliver relayed copies.
  - `transports.durable()` loads `@adonis-agora/durable/diagnostics` only when it is the selected default, and fails at boot with a clear error when durable is not installed, too old, or not configured. `@adonis-agora/durable` is a new optional peer.
  - Every `emit` and `trace` envelope carries a unique `id`, preserved by the relays.
  - The listener delivery contract is typed in the new `@adonis-agora/diagnostics/delivery` subpath (types only): `ListenerDeliveryTransport`, `ListenerDelivery`, `DeliveryTransportContext`, `ListenerInvoker`, `DurableDiagnosticsModule`. A `TransportProvider` may now return a `TransportHandle` with `deliver` instead of a teardown function; teardown functions keep working.
  - `onDiagnostic(fn)` observers and raw channel subscribers (Telescope, OpenTelemetry) are unchanged.

## 1.0.0-rc.0

### Major Changes

- [#130](https://github.com/DavideCarvalho/adonis-agora-diagnostics/pull/130) [`986b098`](https://github.com/DavideCarvalho/adonis-agora-diagnostics/commit/986b098c8b7d53e0a42d7f64ac39c0080855f495) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0.0: the API is now stable and follows semver.
  
  Breaking changes:
  
  - Requires Node.js 24 or newer (`engines.node` is `>=24`); tested on Node.js 24 and 26.
  
  Also in this release:
  
  - The optional `@adonisjs/queue` peer now accepts `^0.6.0 || ^0.7.0`.
  - Fix (patch): the Redis transport no longer crashes short-lived processes (such as `node ace list:routes`) with an unhandled `Error: Connection is closed.` when it shuts down before the subscriber connects. Pending Redis commands are now caught, and teardown unsubscribes, then QUITs a connected subscriber or disconnects one that is still connecting.
  - No exports, functions, options or config keys were removed or renamed: code written against 0.3.x keeps working unchanged.
  
  See the "Migrating to 1.0" guide: https://davidecarvalho.github.io/agora/docs/diagnostics/migrating-to-1-0

## 0.3.2

### Patch Changes

- [#122](https://github.com/DavideCarvalho/adonis-agora-diagnostics/pull/122) [`93323b9`](https://github.com/DavideCarvalho/adonis-agora-diagnostics/commit/93323b908af31b2ef137279b291d7c24ddcc511a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - perf(otel): make the OTel bridge cheaper when spans are not recorded. Non-recording spans (no SDK registered, or sampled out) are no longer tracked in the open-span map, POINT events skip payload flattening when the active span is non-recording, the bridge no longer subscribes to the `asyncStart` sub-channel it never recorded anything for (so `trace()` skips building that envelope), and `isDiagnosticClaimed` short-circuits when nothing is claimed.

## 0.3.1

### Patch Changes

- [#120](https://github.com/DavideCarvalho/adonis-agora-diagnostics/pull/120) [`fddcf50`](https://github.com/DavideCarvalho/adonis-agora-diagnostics/commit/fddcf50464a6ba3bc734dbd3da253653e8de3c20) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Forward relayed events off the emitter's call stack. With a Redis or queue transport enabled, `emit()` no longer serializes, publishes or dispatches synchronously: selected events are queued and, once per event loop turn, sent in emit order — as a single Redis pipeline (one message per event, same wire format) or a single `DiagnosticsEventJob.dispatchMany(...)` (one job per event, same payload). Queued events are sent when the transport is torn down.

## 0.3.0

### Minor Changes

- [#96](https://github.com/DavideCarvalho/adonis-agora-diagnostics/pull/96) [`60cda8d`](https://github.com/DavideCarvalho/adonis-agora-diagnostics/commit/60cda8d1f1dc2bdce234e44c0c1298449a3a4d9f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Drop Node.js 20 and 22: `engines.node` is now `>=24`. Node 20 reached end-of-life on 2026-04-30, and AdonisJS 7, which these packages require as a peer, needs Node 24 or later (`@adonisjs/core` declares `engines.node >=24.0.0`). The supported lines are the ones Node still maintains that AdonisJS 7 accepts: 24 and 26, both tested in CI.

## 0.2.10

### Patch Changes

- [`d6aa185`](https://github.com/DavideCarvalho/adonis-agora-diagnostics/commit/d6aa185b8ad45bf366078358e4903a9fc788475d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Describe `onDiagnostic` by what it does today instead of by a sibling framework's decorator.

## 0.2.9

### Patch Changes

- [#28](https://github.com/DavideCarvalho/adonis-agora-diagnostics/pull/28) [`8f7431c`](https://github.com/DavideCarvalho/adonis-agora-diagnostics/commit/8f7431cc75df6481c45ca59da14e928a4b73c4f3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Accept `@adonisjs/redis` 11 as a peer too (`^9.2 || ^10 || ^11`) for the redis transport. Nothing narrows; the suite runs against the new major.

## 0.2.8

### Patch Changes

- [#26](https://github.com/DavideCarvalho/adonis-agora-diagnostics/pull/26) [`6e93eee`](https://github.com/DavideCarvalho/adonis-agora-diagnostics/commit/6e93eee8b0107c8a001b6571432068684c375890) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Accept `@adonisjs/redis` 10 and `ioredis` 6 as peers (`^9.2 || ^10`, `^5 || ^6`) for the redis
  transport. Nothing narrows; the suite runs against the new majors.

## 0.2.7

### Patch Changes

- [#24](https://github.com/DavideCarvalho/adonis-agora-diagnostics/pull/24) [`74fb704`](https://github.com/DavideCarvalho/adonis-agora-diagnostics/commit/74fb704bbecc968224de89d9cab5736d1018a9ad) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ship TanStack Intent agent skills with the package

  Add three AI-agent skills under `skills/` (published via the new `files` entry) so
  coding agents load correct, sourced guidance for `emit`/`trace`/`onDiagnostic`, typed
  payloads/capabilities/claims, and the cross-process Redis/queue transports plus the
  OpenTelemetry bridge:

  - `diagnostics-setup` — configure, POINT events, spans, observing, test assertions
  - `diagnostics-typed-payloads` — ChannelRegistry/CapabilityRegistry augmentation,
    claim registry, traceId auto-fill
  - `diagnostics-transports-otel` — defineConfig/transports, worker-only processes,
    /otel bridge options

  Skills are validated in CI by `intent validate` (.github/workflows/check-skills.yml)
  and carry `_artifacts/` (domain map, skill spec, skill tree) at the repo root.

## 0.2.6

### Patch Changes

- [#20](https://github.com/DavideCarvalho/adonis-agora-diagnostics/pull/20) [`2ddccbf`](https://github.com/DavideCarvalho/adonis-agora-diagnostics/commit/2ddccbfb14abcbead619b225017f7ae9203760f2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Declare a Node engine **range** instead of an exact version

  `engines.node` was pinned to the single build `v26.7.0`, so installing the package on
  any other Node — including every currently supported LTS — printed an unsupported-engine
  warning, and failed outright under `engine-strict`. It now declares `>=20.6.0`, the
  range the package actually needs.

- [#20](https://github.com/DavideCarvalho/adonis-agora-diagnostics/pull/20) [`2ddccbf`](https://github.com/DavideCarvalho/adonis-agora-diagnostics/commit/2ddccbfb14abcbead619b225017f7ae9203760f2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Restore the published `config/diagnostics.ts` and `start/diagnostics.ts` stubs

  Both stub files shipped empty, so `node ace add @adonis-agora/diagnostics` (and
  `node ace configure`) wrote an **empty** `config/diagnostics.ts` and
  `start/diagnostics.ts` into the app: no `defineConfig` call, no place to register
  handlers, and nothing describing the `otel` / `default` / `forward` / `nodeId` /
  `transports` keys. Re-run `node ace configure @adonis-agora/diagnostics` to get the
  real files.

  The stubs are back, with backticks escaped so the template renderer keeps them, and a
  test now fails if any published `.stub` is empty, lacks its `exports({ to })` target,
  or no longer renders.

- [#20](https://github.com/DavideCarvalho/adonis-agora-diagnostics/pull/20) [`2ddccbf`](https://github.com/DavideCarvalho/adonis-agora-diagnostics/commit/2ddccbfb14abcbead619b225017f7ae9203760f2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Correct the documented `queue:work` invocation for the queue transport

  `QueueTransportConfig.queue` pointed at `node ace queue:work {queue}`. `queue` is a
  flag on that command, not a positional argument, so the documented form starts a
  worker on the `default` queue instead — where the relay never dispatches anything, and
  forwarded events are never consumed. The correct form is
  `node ace queue:work --queue={queue}`.

## 0.2.5

### Patch Changes

- [#4](https://github.com/DavideCarvalho/adonis-diagnostics/pull/4) [`eb454b1`](https://github.com/DavideCarvalho/adonis-diagnostics/commit/eb454b15352310eb50766436c4a38e0df248c5d4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Publish `trace` on a cross-copy-stable global capability slot — `globalThis[Symbol.for('@agora/diagnostics:trace')]` (`TRACE_SLOT`) — mirroring the existing `EMIT_SLOT`/`emit` decoupling contract. Sibling `@adonis-agora/*` libs (e.g. `@adonis-agora/media`) can now republish their spans through the slot **structurally** — reading it rather than importing this package — so they emit real `start`/`end`/`asyncStart`/`asyncEnd`/`error` span events over `node:diagnostics_channel` when diagnostics is present and no-op when it is absent, with zero version coupling. Covered by the capability anti-drift guard and documented in getting-started.

## 0.2.4

### Patch Changes

- Doc-comment cleanup: the `CONTEXT_ACCESSOR` token comment no longer references NestJS DI — Agora publishes the context accessor on a `globalThis` capability slot, not an IoC binding.

## 0.2.3

### Patch Changes

- Export the `configure` hook from the package root so `node ace configure @adonis-agora/diagnostics` resolves it (ace imports the package root and looks for a `configure` export). Previously it lived only on the `./configure` subpath and ace could not find it.
- Remove markdown backticks from the published config stub comments; the AdonisJS (tempura) stub renderer treats the stub body as a template literal, so a stray backtick broke `node ace configure`.

## 0.2.2

### Patch Changes

- Fix a connection leak in the Redis transport: the dedicated `duplicate()` subscriber connection is now closed (`disconnect()`) on transport teardown. Previously the relay cleanup only unsubscribed, leaving the socket open so the process could not exit — graceful shutdown and test runs would hang.

## 0.2.1

### Patch Changes

- [`88db3f2`](https://github.com/DavideCarvalho/adonis-diagnostics/commit/88db3f244b864a564ae5cc415c3701080c7d0873) - fix: sync VERSION literal via sync-version guard

## 0.2.0

### Minor Changes

- [`4cdf498`](https://github.com/DavideCarvalho/adonis-diagnostics/commit/4cdf498c26972bf9196d16232f2a443ec634d967) - Require AdonisJS v7 (bump @adonisjs/\* peers to the v7 line)
