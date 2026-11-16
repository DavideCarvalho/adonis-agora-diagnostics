---
"@adonis-agora/diagnostics": minor
---

App attribution on the event envelope: `emit(lib, event, payload, { app })` stamps `app` (the tenant app the event is about) on the `DiagnosticEvent`. It must match `[A-Za-z0-9_.-]{1,64}`; an invalid value is dropped (the event is still published) with a warning outside production, and `emit` never throws. The Redis and queue relays carry `app` unchanged, and the recent-events buffer (`recentEvents()`, `diagnostics_list_recent_events`) keeps it. Events without `app` are unchanged.
