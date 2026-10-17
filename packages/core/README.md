# `@adonis-agora/diagnostics`

[![npm version](https://img.shields.io/npm/v/@adonis-agora/diagnostics)](https://www.npmjs.com/package/@adonis-agora/diagnostics) [![npm downloads](https://img.shields.io/npm/dm/@adonis-agora/diagnostics)](https://www.npmjs.com/package/@adonis-agora/diagnostics) [![CI](https://github.com/DavideCarvalho/adonis-agora-diagnostics/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/DavideCarvalho/adonis-agora-diagnostics/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@adonis-agora/diagnostics)](https://www.npmjs.com/package/@adonis-agora/diagnostics)

Emit observability events over `node:diagnostics_channel` on `agora:<lib>:<event>`,
recorded by a generic Telescope watcher. Zero coupling between emitter and observer.

```sh
npm i @adonis-agora/diagnostics
node ace configure @adonis-agora/diagnostics
```

```ts
import { emit, trace, onDiagnostic } from '@adonis-agora/diagnostics'

emit('billing', 'invoice-paid', { invoiceId: 'inv_123', amount: 4200 })
const out = await trace('durable', 'step', () => runStep(), { name })
onDiagnostic('resilience', (event) => log(event))
```

`traceId` auto-fills from `@adonis-agora/context` when installed. See the
[repository README](https://github.com/DavideCarvalho/adonis-diagnostics).

## License

MIT © Davi Carvalho
