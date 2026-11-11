---
"@adonis-agora/diagnostics": minor
---

`role` in `config/diagnostics.ts`: which half of a split deployment this process is, the same `'all' | 'api' | 'worker'` as `@adonis-agora/payments`.

- `'all'` (default) keeps today's behaviour.
- `'api'` emits, forwards through the `default` transport and hands listener work to it, but never consumes and never runs a listener: `redis` publishes without opening a subscriber, `queue` binds no re-emitter and no listener invoker (a listener job that lands there fails and is retried), `durable` starts the runs and leaves them to `durable:work` (set durable's `drive: false` on those processes). `onDiagnostic(fn)` observers still see the events the process emits.
- `'worker'` consumes and runs listeners, like `'all'`. The worker half is `node ace queue:work` for `queue`, `node ace durable:work` for `durable`, and any long-running process for `redis`; there is no `diagnostics:work` command.
- `'api'` and `'worker'` without a `default` transport fail at boot.
- `createDiagnosticsRedisRelay` and `createDiagnosticsQueueRelay` take `receive: false` for a forward-only relay (`sub` is then optional), and `TransportContext` carries `role` for custom transports.
