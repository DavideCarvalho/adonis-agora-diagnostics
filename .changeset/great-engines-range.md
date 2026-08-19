---
'@adonis-agora/diagnostics': patch
---

Declare a Node engine **range** instead of an exact version

`engines.node` was pinned to the single build `v26.7.0`, so installing the package on
any other Node — including every currently supported LTS — printed an unsupported-engine
warning, and failed outright under `engine-strict`. It now declares `>=20.6.0`, the
range the package actually needs.
