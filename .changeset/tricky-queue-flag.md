---
'@adonis-agora/diagnostics': patch
---

Correct the documented `queue:work` invocation for the queue transport

`QueueTransportConfig.queue` pointed at `node ace queue:work {queue}`. `queue` is a
flag on that command, not a positional argument, so the documented form starts a
worker on the `default` queue instead — where the relay never dispatches anything, and
forwarded events are never consumed. The correct form is
`node ace queue:work --queue={queue}`.
