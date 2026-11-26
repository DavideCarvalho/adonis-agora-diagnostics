---
"@adonis-agora/diagnostics": minor
---

Security fix backported to the 0.x line: the Redis relay and the queue transport now authenticate every message.

**Breaking:**

- Every Redis message and queue job carries an HMAC-SHA256. By default the key is derived from the app's `APP_KEY` (`config/app.ts` → `appKey`, else `process.env.APP_KEY`), so processes of the same app need no change. When processes of different apps relay to each other, pass the same `secret` (at least 16 characters) to `transports.redis({ secret })` / `transports.queue({ secret })` in every process.
- Without `secret` and without `APP_KEY`, a transport refuses to start and the error says what to set. `createDiagnosticsRedisRelay` and `createDiagnosticsQueueRelay` take `secret` or `appKey`.
- The wire format changed (signed frames; queue jobs carry the signed frame): upgrade every process together, since messages from older versions are dropped.

Also:

- Redis messages more than a minute old (or ahead) and already-seen message ids are dropped. Queue jobs are valid for `maxJobAgeMs` (default 24 hours), and the same message in another job is refused as a replay; a retry of the same job still runs.
- Relayed events must have well-formed `lib` and `event` names and may create at most `maxRemoteChannels` (default 256) new channels per process. Dropped messages are logged once per reason.
