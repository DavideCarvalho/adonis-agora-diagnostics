---
'@adonis-agora/diagnostics': patch
---

Accept `@adonisjs/redis` 10 and `ioredis` 6 as peers (`^9.2 || ^10`, `^5 || ^6`) for the redis
transport. Nothing narrows; the suite runs against the new majors.
