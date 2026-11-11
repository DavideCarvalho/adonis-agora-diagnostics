// Compiled by check.mjs inside a scratch consumer app, against the PUBLISHED declarations.
// Every `@ts-expect-error` below must be a real error, or tsc fails on the unused directive.
import {
  type DiagnosticEvent,
  type DiagnosticEventOf,
  defineConfig,
  OnDiagnostic,
  onDiagnostic,
  transports,
} from '@adonis-agora/diagnostics';
import type {
  DurableDiagnosticsModule,
  ListenerDeliveryTransport,
} from '@adonis-agora/diagnostics/delivery';

declare module '@adonis-agora/diagnostics' {
  interface ChannelRegistry {
    agent: {
      'run.finished': { runId: string; ok: boolean };
    };
  }
}

export default class TrackAgentRun {
  @OnDiagnostic('agent', 'run.finished')
  async handle(event: DiagnosticEventOf<'agent', 'run.finished'>) {
    const runId: string = event.payload.runId;
    return runId;
  }

  // @ts-expect-error the parameter does not accept the registered payload
  @OnDiagnostic('agent', 'run.finished')
  async wrong(_event: DiagnosticEvent<{ other: number }>) {}

  @OnDiagnostic('agent', /^run\./)
  pattern(event: DiagnosticEvent) {
    return event.id;
  }

  @OnDiagnostic('billing', 'invoice-paid')
  untyped(event: DiagnosticEvent) {
    const payload: unknown = event.payload;
    return payload;
  }
}

onDiagnostic('agent', 'run.finished', (event) => {
  const ok: boolean = event.payload.ok;
  return void ok;
});
onDiagnostic('agent', 'run.finished', (event) => {
  // @ts-expect-error `ok` is a boolean, not a number
  const ok: number = event.payload.ok;
  return void ok;
});
onDiagnostic('billing', 'anything', (event) => {
  const payload: unknown = event.payload;
  return void payload;
});
onDiagnostic('agent', 'run.finished', [TrackAgentRun, 'handle']);
onDiagnostic('agent', /^run\./, [() => import('./app.js'), 'pattern'], { id: 'agent-pattern' });

export const config = defineConfig({
  default: 'durable',
  listenersPath: 'app/listeners/diagnostics',
  transports: {
    queue: transports.queue({ queue: 'diagnostics', retries: 5 }),
    durable: transports.durable({ retries: 5, backoff: 'exp', backoffMs: 500 }),
  },
});

// A transport package implements the contract with type-only imports.
export const durableModule: DurableDiagnosticsModule = {
  isConfigured: () => true,
  createDeliveryTransport(context): ListenerDeliveryTransport {
    return {
      async deliver(deliveries) {
        for (const { listenerId, envelope } of deliveries) {
          const runId: string = `diag:${envelope.id}:${listenerId}`;
          await context.invoke(listenerId, envelope);
          void runId;
        }
      },
    };
  },
};
