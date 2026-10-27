---
"@adonis-agora/diagnostics": patch
---

perf(otel): make the OTel bridge cheaper when spans are not recorded. Non-recording spans (no SDK registered, or sampled out) are no longer tracked in the open-span map, POINT events skip payload flattening when the active span is non-recording, the bridge no longer subscribes to the `asyncStart` sub-channel it never recorded anything for (so `trace()` skips building that envelope), and `isDiagnosticClaimed` short-circuits when nothing is claimed.
