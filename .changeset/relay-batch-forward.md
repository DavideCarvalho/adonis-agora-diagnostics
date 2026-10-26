---
"@adonis-agora/diagnostics": patch
---

Forward relayed events off the emitter's call stack. With a Redis or queue transport enabled, `emit()` no longer serializes, publishes or dispatches synchronously: selected events are queued and, once per event loop turn, sent in emit order — as a single Redis pipeline (one message per event, same wire format) or a single `DiagnosticsEventJob.dispatchMany(...)` (one job per event, same payload). Queued events are sent when the transport is torn down.
