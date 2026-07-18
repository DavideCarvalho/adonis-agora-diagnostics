# @adonis-agora/diagnostics

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
