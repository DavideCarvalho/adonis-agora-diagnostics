# @adonis-agora/diagnostics

## 0.2.2

### Patch Changes

- Fix a connection leak in the Redis transport: the dedicated `duplicate()` subscriber connection is now closed (`disconnect()`) on transport teardown. Previously the relay cleanup only unsubscribed, leaving the socket open so the process could not exit — graceful shutdown and test runs would hang.

## 0.2.1

### Patch Changes

- [`88db3f2`](https://github.com/DavideCarvalho/adonis-diagnostics/commit/88db3f244b864a564ae5cc415c3701080c7d0873) - fix: sync VERSION literal via sync-version guard

## 0.2.0

### Minor Changes

- [`4cdf498`](https://github.com/DavideCarvalho/adonis-diagnostics/commit/4cdf498c26972bf9196d16232f2a443ec634d967) - Require AdonisJS v7 (bump @adonisjs/\* peers to the v7 line)
