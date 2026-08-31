# @adonis-agora/diagnostics

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
