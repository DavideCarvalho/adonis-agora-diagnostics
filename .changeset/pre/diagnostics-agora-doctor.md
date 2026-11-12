---
'@adonis-agora/diagnostics': minor
---

`node ace agora:doctor` (the shared Agora health check) and `node ace diagnostics:doctor`, with checks `diagnostics.transport`, `diagnostics.role`, `diagnostics.recent-buffer`, `diagnostics.listeners` and `diagnostics.otel`. New commands barrel `@adonis-agora/diagnostics/commands` (registered by `configure`; existing apps add it to `adonisrc.ts`) and `@adonis-agora/diagnostics/doctor` entry for `--no-boot`.
