---
'@adonis-agora/diagnostics': patch
---

An ioredis 6 client is assignable to `RedisLike` again (ioredis 5 still is): `subscribe` is typed with one channel and no callback, which both versions' variadic signatures satisfy.
