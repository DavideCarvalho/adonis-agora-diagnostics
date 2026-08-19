---
'@adonis-agora/diagnostics': patch
---

Restore the published `config/diagnostics.ts` and `start/diagnostics.ts` stubs

Both stub files shipped empty, so `node ace add @adonis-agora/diagnostics` (and
`node ace configure`) wrote an **empty** `config/diagnostics.ts` and
`start/diagnostics.ts` into the app: no `defineConfig` call, no place to register
handlers, and nothing describing the `otel` / `default` / `forward` / `nodeId` /
`transports` keys. Re-run `node ace configure @adonis-agora/diagnostics` to get the
real files.

The stubs are back, with backticks escaped so the template renderer keeps them, and a
test now fails if any published `.stub` is empty, lacks its `exports({ to })` target,
or no longer renders.
