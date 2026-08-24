# Skill spec — adonis-diagnostics (autonomous pass)

Compressed domain discovery. No maintainer interview was run (fully autonomous
constraint); everything below is grounded in README.md, DESIGN.md, docs/*.mdx
(all seven narrative files read), packages/core/src, the published stubs
(config/start), and providers/diagnostics_provider.ts.

## Scope decision

Single-package library (`@adonis-agora/diagnostics@0.2.6`, packages/core) — there
are no adapter packages to decompose into, so the minimal-library fast path applies:
flat structure, no router skill, no core-overview registry, every skill type `core`.
All three skills live in `packages/core/skills/` and ship with the package.

| Domain | Skills | Why |
|---|---|---|
| Emitting & observing | 1 | The mental model lives here: POINT `emit`, SPAN `trace`, and every way to observe (`onDiagnostic`, raw channels, test collectors). One developer moment: "wire emitting + observing into my app." |
| Typed contracts | 1 | Compile-time payload typing, capability slots, trace correlation, and the claim registry are one coherent "make the bus type-safe / dedup'd" task cluster. |
| Cross-process & OTel | 1 | Transports (Redis/queue) and the OpenTelemetry bridge share config/diagnostics.ts as their single surface — configuring fan-out and span export is one task. |

Total: 3 SKILL.md files.

## Skill set (flat; all type `core`)

1. `diagnostics-setup` — install/configure (`node ace configure` → provider +
   `config/diagnostics.ts` + preloaded `start/diagnostics.ts`), POINT `emit`
   (`durationMs`, `sample` load-shedding), SPAN `trace`/`tracingChannel` and the five
   sub-channels, wildcard/exact `onDiagnostic` with `onError`, unsubscribeAll lifecycle,
   test collectors with `resetRegistry`. Mistakes: heavy work in inline handlers;
   awaiting/expecting emit output with no subscriber (events only exist when subscribed);
   treating `end`'s durationMs as total async time instead of `asyncEnd`; calling
   `resetRegistry()` in a running app.
2. `diagnostics-typed-payloads` — `ChannelRegistry`/`CapabilityRegistry` declaration
   merging, `PayloadOf` helpers, why the untyped path survives (`string & {}`),
   capability protocol (`capability()`, EMIT_SLOT/TRACE_SLOT republish),
   `claimDiagnostics`/`isDiagnosticClaimed` dedup, traceId auto-fill via
   `setContextAccessor`. Mistakes: closing lib/event unions by hand-rolling the
   augmentation; expecting a runtime payload registry; releasing one consumer's claim
   and assuming another's dropped.
3. `diagnostics-transports-otel` — `defineConfig` keys, `transports.redis/queue`,
   `forward` selections, custom `TransportProvider` thunks, worker-only processes,
   `getActiveReEmitter`, queue dispatch errors, `/otel` bridge options,
   `recordClaimed`, `otelTraceparent`. Mistakes: gating `default` on env instead of
   `forward`; running the queue worker without selecting the transport; passing the
   queue name positionally to `queue:work`; throwing out of a transport `forward()`.

## Highest-value AI-agent guidance (what to get right)

- **Events are built only when subscribed.** A collector that asserts on events must
  subscribe first (`onDiagnostic` or `getChannel(...).subscribe`) — otherwise nothing
  is allocated and tests see zero events. This is the hasSubscribers contract.
- **Worker-only processes must also select the transport.** Re-emission is bound by
  starting the transport in that process; a worker without it runs relay jobs as
  silent no-ops. Gate `forward` per environment, never `default` — an unset default
  means no re-emitter binds at all.
- **Handlers and transport `forward()`s run inline inside `emit()`.** Heavy or throwing
  work lands on the producer's hot path; the library guards itself (safe-invoke,
  onDispatchError) but agents should still batch/hand off.
- **Claims are record-time-checked and reference-counted.** The generic bridge skips a
  claimed `lib:event` whenever the claim exists — order-independent — and one release()
  doesn't un-claim another holder's key.
- **Typing never closes the bus.** Augmenting `ChannelRegistry` narrows declared pairs;
  undeclared pairs keep working with `unknown` payloads because of the `string & {}`
  trick in `LibOf`/`EventOf`.

## Remaining Gaps (interview substitutes)

- No GitHub issue mining this session — failure-mode priorities inferred from docs
  callouts (which explicitly flag the worker trap and the queue:work flag mistake)
  rather than observed reports.
- OTel post-hoc parenting limitation (spans nest under whatever is active, not
  agora-under-agora) is documented but its real-world confusion level is unconfirmed.
- Redis-vs-queue first recommendation for new users is unknown; skills present both
  neutrally per docs.
- Frequency with which ecosystem packages replicate the raw Symbol.for conventions
  (claims map, emit/trace slots) without importing the package could not be measured.
