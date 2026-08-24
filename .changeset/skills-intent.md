---
'@adonis-agora/diagnostics': patch
---

Ship TanStack Intent agent skills with the package

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
