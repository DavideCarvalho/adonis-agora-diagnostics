---
"@adonis-agora/diagnostics": major
---

1.0.0: the API is now stable and follows semver.

Breaking changes:

- Requires Node.js 24 or newer (`engines.node` is `>=24`); tested on Node.js 24 and 26.

Also in this release:

- The optional `@adonisjs/queue` peer now accepts `^0.6.0 || ^0.7.0`.
- Fix (patch): the Redis transport no longer crashes short-lived processes (such as `node ace list:routes`) with an unhandled `Error: Connection is closed.` when it shuts down before the subscriber connects. Pending Redis commands are now caught, and teardown unsubscribes, then QUITs a connected subscriber or disconnects one that is still connecting.
- No exports, functions, options or config keys were removed or renamed: code written against 0.3.x keeps working unchanged.

See the "Migrating to 1.0" guide: https://davidecarvalho.github.io/agora/docs/diagnostics/migrating-to-1-0
