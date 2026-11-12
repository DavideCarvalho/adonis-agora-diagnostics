---
'@adonis-agora/diagnostics': minor
---

Dev MCP tools on `@adonis-agora/agent`'s `/mcp/agora` endpoint (gated by its `devTools.authorize`): `diagnostics_list_channels`, `diagnostics_list_listeners`, `diagnostics_list_recent_events`. New recent-events buffer (`recentEvents()`, `recent` option: on outside production with the dev tools, off in production unless set), `devTools` option, and `transportInfo()` to tell which built-in transport a provider is.
