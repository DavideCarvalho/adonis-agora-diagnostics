import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DiagnosticsProvider from '../providers/diagnostics_provider.js';
import { emit } from '../src/channel.js';
import type { DiagnosticsConfig } from '../src/define_config.js';
import type {
  DeliveryTransportContext,
  DurableDiagnosticsModule,
  ListenerDelivery,
} from '../src/delivery.js';
import { bindListenerInvoker } from '../src/listener_dispatch.js';
import { registeredListeners, resetListeners } from '../src/listeners.js';
import { resetRegistry } from '../src/registry.js';
import { onDiagnostic, unsubscribeAll } from '../src/subscriber.js';
import {
  DURABLE_NOT_CONFIGURED,
  DURABLE_NOT_INSTALLED,
  DURABLE_OUTDATED,
  setDurableModuleLoader,
  transports,
} from '../src/transports/factory.js';
import type { DiagnosticEvent } from '../src/types.js';

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakeApp(config: DiagnosticsConfig, appRoot = '/nonexistent-app-root') {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const app = {
    config: { get: (_key: string, fallback: unknown) => config ?? fallback },
    container: {
      make: async (binding: unknown) =>
        binding === 'logger' ? logger : new (binding as new () => object)(),
    },
    makePath: (...parts: string[]) => join(appRoot, ...parts),
  } as unknown as ApplicationService;
  return { app, logger };
}

async function boot(config: DiagnosticsConfig, appRoot?: string) {
  const { app, logger } = fakeApp({ otel: false, ...config }, appRoot);
  const provider = new DiagnosticsProvider(app);
  await provider.boot();
  await provider.ready();
  return { provider, logger, app };
}

const notFound = (specifier: string) =>
  Object.assign(new Error(`Cannot find package '${specifier}' imported from /app/x.js`), {
    code: 'ERR_MODULE_NOT_FOUND',
  });

describe('DiagnosticsProvider: listeners', () => {
  let provider: DiagnosticsProvider | undefined;
  afterEach(async () => {
    await provider?.shutdown();
    provider = undefined;
    setDurableModuleLoader(null);
    unsubscribeAll();
    resetListeners();
    resetRegistry();
    bindListenerInvoker(null);
  });

  it('runs a preload-registered listener in-process when no transport is selected', async () => {
    const seen: DiagnosticEvent[] = [];
    class Audit {
      handle(event: DiagnosticEvent) {
        seen.push(event);
      }
    }
    onDiagnostic('agent', 'run.finished', [async () => ({ default: Audit }), 'handle']);
    ({ provider } = await boot({}));

    emit('agent', 'run.finished', { ok: true });
    await nextTurn();
    expect(seen.map((e) => e.payload)).toEqual([{ ok: true }]);
  });

  it('logs a failing in-process listener and keeps the emitter safe', async () => {
    class Failing {
      handle() {
        throw new Error('boom');
      }
    }
    onDiagnostic('agent', 'run.finished', [Failing, 'handle']);
    const booted = await boot({});
    provider = booted.provider;

    expect(() => emit('agent', 'run.finished', {})).not.toThrow();
    await nextTurn();
    expect(booted.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ listenerId: 'Failing#handle' }),
      'diagnostics listener failed',
    );
  });

  describe('listener discovery', () => {
    const dist = fileURLToPath(new URL('../dist/src/listeners.js', import.meta.url));
    let root: string | undefined;
    afterEach(() => {
      if (root) rmSync(root, { recursive: true, force: true });
      root = undefined;
    });

    it.skipIf(!existsSync(dist))(
      'imports app/listeners/diagnostics/** and ids each method by its path',
      async () => {
        root = mkdtempSync(join(tmpdir(), 'diagnostics-discovery-'));
        const dir = join(root, 'app/listeners/diagnostics/billing');
        mkdirSync(dir, { recursive: true });
        const listener = (name: string, event: string) => `
          import { OnDiagnostic } from ${JSON.stringify(dist)};
          export default class ${name} {
            handle(event) { globalThis.__discovered.push([${JSON.stringify(name)}, event.payload]); }
          }
          OnDiagnostic('billing', ${JSON.stringify(event)})(${name}.prototype, 'handle');
        `;
        writeFileSync(join(dir, 'invoice_paid.mjs'), listener('InvoicePaid', 'invoice-paid'));
        writeFileSync(
          join(root, 'app/listeners/diagnostics/refund.mjs'),
          listener('Refund', 'refund'),
        );
        writeFileSync(join(root, 'app/listeners/diagnostics/helpers.mjs'), 'export const x = 1;');
        writeFileSync(join(root, 'app/listeners/diagnostics/types.d.ts'), 'export {};');

        (globalThis as { __discovered?: unknown[] }).__discovered = [];
        const booted = await boot({}, root);
        provider = booted.provider;

        expect(registeredListeners().map((l) => l.id)).toEqual([
          'app/listeners/diagnostics/billing/invoice_paid#handle',
          'app/listeners/diagnostics/refund#handle',
        ]);
        expect(booted.logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('app/listeners/diagnostics/helpers'),
        );

        emit('billing', 'invoice-paid', { n: 1 });
        await nextTurn();
        expect((globalThis as { __discovered?: unknown[] }).__discovered).toEqual([
          ['InvoicePaid', { n: 1 }],
        ]);
      },
    );

    it('registers nothing when the directory does not exist, or discovery is off', async () => {
      ({ provider } = await boot({}));
      expect(registeredListeners()).toEqual([]);
      await provider.shutdown();
      ({ provider } = await boot({ listenersPath: false }));
      expect(registeredListeners()).toEqual([]);
    });
  });

  describe('transports.durable()', () => {
    class Track {
      handle(_event: DiagnosticEvent) {}
    }

    function fakeDurable(configured: boolean) {
      const delivered: ListenerDelivery[] = [];
      const contexts: DeliveryTransportContext[] = [];
      const stop = vi.fn();
      const mod: DurableDiagnosticsModule = {
        isConfigured: () => configured,
        createDeliveryTransport(context, config) {
          contexts.push(context);
          expect(config).toEqual({ retries: 5 });
          return { deliver: (deliveries) => void delivered.push(...deliveries), stop };
        },
      };
      return { mod, delivered, contexts, stop };
    }

    it('fails boot when @adonis-agora/durable is not installed', async () => {
      setDurableModuleLoader(async () => {
        throw notFound('@adonis-agora/durable');
      });
      await expect(
        boot({ default: 'durable', transports: { durable: transports.durable() } }),
      ).rejects.toThrow(DURABLE_NOT_INSTALLED);
    });

    it('fails boot when the installed durable has no ./diagnostics export', async () => {
      setDurableModuleLoader(async () => {
        throw Object.assign(
          new Error(
            `Package subpath './diagnostics' is not defined by "exports" in /app/node_modules/@adonis-agora/durable/package.json`,
          ),
          { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
        );
      });
      await expect(
        boot({ default: 'durable', transports: { durable: transports.durable() } }),
      ).rejects.toThrow(DURABLE_OUTDATED);
    });

    it('fails boot when durable is installed but not configured', async () => {
      setDurableModuleLoader(async () => fakeDurable(false).mod);
      await expect(
        boot({ default: 'durable', transports: { durable: transports.durable() } }),
      ).rejects.toThrow(DURABLE_NOT_CONFIGURED);
    });

    it('does not swallow an unrelated import error', async () => {
      setDurableModuleLoader(async () => {
        throw notFound('some-other-package');
      });
      await expect(
        boot({ default: 'durable', transports: { durable: transports.durable() } }),
      ).rejects.toThrow('some-other-package');
    });

    it('listed but not selected: never loads durable and never throws', async () => {
      const loader = vi.fn(async () => {
        throw notFound('@adonis-agora/durable');
      });
      setDurableModuleLoader(loader);
      ({ provider } = await boot({
        transports: { durable: transports.durable({ retries: 5 }) },
      }));
      expect(loader).not.toHaveBeenCalled();
    });

    it('selected and configured: hands origin events to durable and stops it on shutdown', async () => {
      const durable = fakeDurable(true);
      setDurableModuleLoader(async () => durable.mod);
      onDiagnostic('agent', 'run.finished', [Track, 'handle']);
      ({ provider } = await boot({
        default: 'durable',
        nodeId: 'web-1',
        transports: { durable: transports.durable({ retries: 5 }) },
      }));

      expect(durable.contexts[0]).toMatchObject({ nodeId: 'web-1', listenerIds: ['Track#handle'] });
      emit('agent', 'run.finished', { ok: true });
      await nextTurn();
      expect(durable.delivered).toEqual([
        {
          listenerId: 'Track#handle',
          envelope: expect.objectContaining({ id: expect.any(String), payload: { ok: true } }),
        },
      ]);

      await expect(
        durable.contexts[0]?.invoke(
          'Track#handle',
          durable.delivered[0]?.envelope as DiagnosticEvent,
        ),
      ).resolves.toBeUndefined();

      await provider.shutdown();
      provider = undefined;
      expect(durable.stop).toHaveBeenCalledTimes(1);
    });
  });
});
