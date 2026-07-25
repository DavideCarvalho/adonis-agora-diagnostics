---
"@adonis-agora/diagnostics": patch
---

Publish `trace` on a cross-copy-stable global capability slot — `globalThis[Symbol.for('@agora/diagnostics:trace')]` (`TRACE_SLOT`) — mirroring the existing `EMIT_SLOT`/`emit` decoupling contract. Sibling `@adonis-agora/*` libs (e.g. `@adonis-agora/media`) can now republish their spans through the slot **structurally** — reading it rather than importing this package — so they emit real `start`/`end`/`asyncStart`/`asyncEnd`/`error` span events over `node:diagnostics_channel` when diagnostics is present and no-op when it is absent, with zero version coupling. Covered by the capability anti-drift guard and documented in getting-started.
