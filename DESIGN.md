# `@adonis-agora/diagnostics` — DESIGN

> Port of `@dudousxd/nestjs-diagnostics` (aviary) to AdonisJS (Agora).

## 1. Papel

Convenção de emissão de eventos de observabilidade sobre `node:diagnostics_channel`,
no canal `agora:<lib>:<event>`. Desacopla **emissor** (qualquer lib Agora) de
**observador** (telescope, exporter, handler do app) — não há import entre eles,
só o contrato de nome de canal.

> O prefixo do canal mudou de `aviary` → **`agora`**: ecossistema distinto, com seu
> próprio telescope. Um observador Agora assina `agora:*`.

## 2. Núcleo (framework-agnostic, portado verbatim)

`channel.ts` (`emit`/`getChannel`), `trace.ts` (spans start/end/asyncStart/
asyncEnd/error), `registry.ts` (descoberta de canais via `Symbol.for` global,
cross-copy estável), `context_accessor.ts` (auto-fill de `traceId`), `types.ts`
(envelope + `ChannelRegistry` tipada). Tudo puro `node:diagnostics_channel` —
copiado sem mudança além do prefixo/marca.

- `emit` é **free quando ninguém assina** (`hasSubscribers` gate antes de alocar).
- `trace` idem (gate em qualquer sub-canal).
- Nunca lança no caminho do emissor.

## 3. O que mudou do Nest → Adonis

O Nest descobria handlers via `@OnDiagnostic` + um explorer que escaneava os
providers da DI no bootstrap. Adonis não tem esse scan idiomático. Extraí a lógica
do explorer numa função **agnóstica**:

```ts
onDiagnostic('resilience', handler)            // wildcard: todo agora:resilience:*
onDiagnostic('authz', 'decision', handler)     // canal exato
```

- Suporta exato + wildcard (com auto-subscribe de canais **futuros** via
  `onChannelRegistered`).
- `safe-invoke`: throw/rejeição do handler nunca quebra o `emit`.
- Retorna unsubscribe; `unsubscribeAll()` (chamado no `shutdown` do provider)
  derruba tudo — sem leak no dev-watcher/testes.

Handlers são registrados em `start/diagnostics.ts` (preload publicado pelo
`configure`), o ponto idiomático Adonis equivalente ao "import o módulo na raiz".

## 4. Wiring Adonis

- **Provider** (`diagnostics_provider.ts`): só lifecycle — `shutdown()` →
  `unsubscribeAll()`. O auto-fill de `traceId` vem do outro lado: o provider do
  `@adonis-agora/context` soft-detecta este pacote no boot e chama `setContextAccessor`.
- **`node ace configure @adonis-agora/diagnostics`**: registra o provider, publica
  `start/diagnostics.ts` e o adiciona como preload.

## 5. Cross-process (transportes **in-core**)

Os transportes cross-process **não são pacotes separados** — vivem no próprio
`@adonis-agora/diagnostics` e são selecionados em `config/diagnostics.ts` com a
factory `transports` (`transports.redis(...)` / `transports.queue(...)`), do mesmo
jeito que `@adonisjs/session` escolhe um `store`. A peer-dependency do driver
escolhido (`@adonisjs/redis`, `@adonisjs/queue`) é importada **lazy**, só quando o
transporte é de fato selecionado. Um único `forward` (`{ libs }` / `{ channels }` /
`{ all }`) decide o que sai do processo; ambos os transportes compartilham o mesmo
`createChannelSelector` e o mesmo loop-guard.

**Redis:** `transports/redis.ts` é agnóstico (interface `RedisLike` estrutural —
ioredis satisfaz). Encaminha canais locais selecionados pro Redis pub/sub e re-emite
os recebidos no bus local, então `onDiagnostic` dispara cross-process. Loop-safe
(echo suppression por `nodeId` + guard de re-emit). O provider pega o ioredis cru do
`@adonisjs/redis` (`connection.ioConnection` + `.duplicate()` pro subscriber) a partir
de `config/diagnostics.ts`. A perna `pub` é do `@adonisjs/redis` e o relay nunca a
fecha; a `sub` é o `duplicate()` que o próprio transporte criou (o `@adonisjs/redis`
não rastreia essa conexão), então o teardown dá `disconnect()` nela — senão o socket
aberto segura o processo e o shutdown/os testes penduram.

**Queue:** `transports/queue.ts` despacha cada evento selecionado como o job
`agora.diagnostics.event`; um worker em outro processo executa o job e re-emite o
evento no bus local. Fire-and-forget: falha de queue é logada, nunca lançada no
`emit()`.

## 5.1 OpenTelemetry (auto-bridge embutido, sem pacote extra)

O AdonisJS v7 tem `@adonisjs/otel` oficial (registra um SDK OTel global). O gancho
universal é o `@opentelemetry/api` (no-op sem SDK). Em vez de um pacote separado, a
ponte vive **no próprio core**, ligada pelo provider:

- No `boot()`, o provider faz `import('./otel/index.js')` **dinâmico** dentro de
  try/catch. Esse módulo importa `@opentelemetry/api` (peer **opcional**). Se o OTel
  não estiver instalado, o import falha e é engolido — a ponte nunca carrega e o
  caminho quente do `emit`/`trace` continua **sem nenhum import de OTel**. Opt-out:
  `otel: false` no `config/diagnostics.ts`.
- A ponte assina todos os canais `agora:*` (via o registry) e reconstrói **spans
  OTel reais** a partir dos eventos do `trace()` (start→end/error, sync e async),
  com atributos do payload. POINT `emit`s viram `addEvent` no span ativo.
- Publica `otelTraceparent()` no slot global `Symbol.for('@agora/otel:traceparent')`
  — o `@adonis-agora/durable` lê esse slot e continua o trace distribuído nos remote steps,
  sem config, sem dependência hard.
- **Limitação honesta (observador post-hoc):** a ponte não controla o contexto de
  execução, então aninha o span agora sob o **span OTel ativo do ambiente** (ex: o
  span do request do `@adonisjs/otel`) — não cria parentesco agora-sob-agora. No uso
  real isso é o que importa: cada `trace()` durante um request nasce filho do span do
  request.

## 6. Pacotes

**Um único pacote.** Redis e queue **não** são pacotes separados — são transportes
in-core, escolhidos em `config/diagnostics.ts`.

- `@adonis-agora/diagnostics` — núcleo (emit/trace/onDiagnostic + registry + context bridge
  + **auto-bridge OTel** opcional via `@opentelemetry/api`, subpath `@adonis-agora/diagnostics/otel`
  + os **transportes cross-process** Redis / `@adonisjs/queue` in-core, com peer-deps lazy)

## 7. Não-objetivos

- Não é um storage/dashboard (isso é o `@adonis-agora/telescope`).
- Não impõe schema de payload (opaco; `ChannelRegistry` é opt-in só pra tipos).
