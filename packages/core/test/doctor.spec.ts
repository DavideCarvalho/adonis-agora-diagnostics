import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import DiagnosticsProvider from '../providers/diagnostics_provider.js';
import type { DiagnosticsConfig } from '../src/define_config.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from '../src/doctor/agora_doctor.js';
import { checkOtel, diagnosticsDoctorChecks, sdkLine } from '../src/doctor/checks.js';
import { agoraDoctorChecks } from '../src/doctor/index.js';
import { stopRecentEvents } from '../src/recent.js';
import { transports } from '../src/transports/factory.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  stopRecentEvents();
});

/** A fixture app root with fake packages in node_modules. */
function appRoot(packages: Record<string, Record<string, unknown>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'diag-doctor-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));
  for (const [name, manifest] of Object.entries(packages)) {
    const dir = join(root, 'node_modules', ...name.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', ...manifest }),
    );
    for (const [file, source] of Object.entries(
      (manifest.files as Record<string, string> | undefined) ?? {},
    )) {
      writeFileSync(join(dir, file), source);
    }
  }
  return root;
}

function fakeApp(
  config: DiagnosticsConfig,
  opts: {
    root?: string;
    inProduction?: boolean;
    isBooted?: boolean;
    other?: Record<string, unknown>;
  } = {},
) {
  const root = opts.root ?? appRoot();
  return {
    inProduction: opts.inProduction ?? false,
    isBooted: opts.isBooted ?? false,
    config: {
      get: (key: string, fallback: unknown) => {
        if (key === 'diagnostics') return config;
        if (opts.other && Object.hasOwn(opts.other, key)) return opts.other[key];
        return fallback;
      },
    },
    makePath: (...parts: string[]) => join(root, ...parts),
  } as never;
}

const byId = (id: string) => diagnosticsDoctorChecks().find((c) => c.id === id) as AgoraDoctorCheck;

async function run(id: string, app: never): Promise<AgoraDoctorResult[]> {
  const out = await byId(id).run(app);
  return Array.isArray(out) ? out : [out];
}

describe('diagnostics doctor checks', () => {
  it('have frozen ids and are exported for --no-boot', () => {
    expect(diagnosticsDoctorChecks().map((c) => c.id)).toEqual([
      'diagnostics.transport',
      'diagnostics.role',
      'diagnostics.recent-buffer',
      'diagnostics.listeners',
      'diagnostics.otel',
    ]);
    expect(agoraDoctorChecks).toHaveLength(5);
  });

  describe('diagnostics.transport', () => {
    it('is ok local-only and for a custom transport; errors on an undefined default', async () => {
      expect((await run('diagnostics.transport', fakeApp({})))[0]?.message).toContain('local only');
      const custom = await run(
        'diagnostics.transport',
        fakeApp({ default: 'x', transports: { x: async () => () => {} } }),
      );
      expect(custom[0]?.message).toContain('custom');
      const missing = await run('diagnostics.transport', fakeApp({ default: 'redis' }));
      expect(missing[0]?.status).toBe('error');
    });

    it('redis: needs @adonisjs/redis and the connection', async () => {
      const config = { default: 'r', transports: { r: transports.redis({ connection: 'cache' }) } };
      expect((await run('diagnostics.transport', fakeApp(config)))[0]?.message).toContain(
        '@adonisjs/redis is not installed',
      );
      const root = appRoot({ '@adonisjs/redis': {} });
      const noConnection = await run(
        'diagnostics.transport',
        fakeApp(config, {
          root,
          other: { redis: { connection: 'main', connections: { main: {} } } },
        }),
      );
      expect(noConnection[0]).toMatchObject({ status: 'error' });
      expect(noConnection[0]?.message).toContain('"cache"');
      const ok = await run(
        'diagnostics.transport',
        fakeApp(
          { default: 'r', transports: { r: transports.redis() } },
          { root, other: { redis: { connection: 'main', connections: { main: {} } } } },
        ),
      );
      expect(ok[0]).toMatchObject({ status: 'ok' });
    });

    it('queue: needs @adonisjs/queue and config/queue.ts', async () => {
      const config = { default: 'q', transports: { q: transports.queue() } };
      expect((await run('diagnostics.transport', fakeApp(config)))[0]?.status).toBe('error');
      const root = appRoot({ '@adonisjs/queue': {} });
      expect((await run('diagnostics.transport', fakeApp(config, { root })))[0]?.message).toContain(
        'config/queue.ts',
      );
      const ok = await run(
        'diagnostics.transport',
        fakeApp(config, { root, other: { queue: {} } }),
      );
      expect(ok[0]?.status).toBe('ok');
    });

    it('durable: installed, new enough, and configured when booted', async () => {
      const config = { default: 'd', transports: { d: transports.durable() } };
      expect((await run('diagnostics.transport', fakeApp(config)))[0]?.message).toContain(
        'requires @adonis-agora/durable',
      );
      const old = appRoot({ '@adonis-agora/durable': { exports: { '.': './index.js' } } });
      expect(
        (await run('diagnostics.transport', fakeApp(config, { root: old })))[0]?.message,
      ).toContain('exports `@adonis-agora/durable/diagnostics`');

      const make = (configured: boolean) =>
        appRoot({
          '@adonis-agora/durable': {
            type: 'module',
            exports: { './diagnostics': './diagnostics.js' },
            files: {
              'diagnostics.js': `export const isConfigured = async () => ${configured};`,
            },
          },
        });
      const notBooted = await run('diagnostics.transport', fakeApp(config, { root: make(false) }));
      expect(notBooted[0]).toMatchObject({ status: 'ok' });
      expect(notBooted[0]?.message).toContain('not checked without booting');
      const unconfigured = await run(
        'diagnostics.transport',
        fakeApp(config, { root: make(false), isBooted: true }),
      );
      expect(unconfigured[0]).toMatchObject({ status: 'error' });
      expect(unconfigured[0]?.message).toContain('no durable engine is bound');
      const configured = await run(
        'diagnostics.transport',
        fakeApp(config, { root: make(true), isBooted: true }),
      );
      expect(configured[0]).toMatchObject({ status: 'ok' });
    });
  });

  it('diagnostics.role: refuses split roles without a transport and warns on idle forward', async () => {
    expect((await run('diagnostics.role', fakeApp({})))[0]?.status).toBe('ok');
    expect((await run('diagnostics.role', fakeApp({ role: 'api' })))[0]?.status).toBe('error');
    expect(
      (await run('diagnostics.role', fakeApp({ role: 'nope' as never })))[0]?.message,
    ).toContain("'all', 'api' or 'worker'");
    expect(
      (await run('diagnostics.role', fakeApp({ forward: { libs: ['durable'] } })))[0]?.status,
    ).toBe('warn');
    expect(
      (
        await run(
          'diagnostics.role',
          fakeApp({ role: 'worker', default: 'q', transports: { q: transports.queue() } }),
        )
      )[0],
    ).toMatchObject({ status: 'ok', message: 'role: worker' });
  });

  it('diagnostics.recent-buffer: warns when forced on in production', async () => {
    expect(
      (
        await run(
          'diagnostics.recent-buffer',
          fakeApp({ recent: { size: 10 } }, { inProduction: true }),
        )
      )[0]?.status,
    ).toBe('warn');
    expect((await run('diagnostics.recent-buffer', fakeApp({ recent: true })))[0]?.status).toBe(
      'ok',
    );
    expect(
      (await run('diagnostics.recent-buffer', fakeApp({}, { inProduction: true })))[0]?.status,
    ).toBe('ok');
  });

  it('diagnostics.recent-buffer: errors on a size that makes boot fail', async () => {
    const out = await run('diagnostics.recent-buffer', fakeApp({ recent: { size: 0 } }));
    expect(out[0]).toMatchObject({ status: 'error' });
  });

  it('diagnostics.transport: redis with no connection selected anywhere', async () => {
    const root = appRoot({ '@adonisjs/redis': {} });
    const out = await run(
      'diagnostics.transport',
      fakeApp(
        { default: 'r', transports: { r: transports.redis() } },
        { root, other: { redis: {} } },
      ),
    );
    expect(out[0]?.message).toContain('no redis connection is selected');
  });

  it('diagnostics.listeners: warns on a custom path that does not exist', async () => {
    const root = appRoot();
    expect((await run('diagnostics.listeners', fakeApp({}, { root })))[0]?.status).toBe('ok');
    expect(
      (await run('diagnostics.listeners', fakeApp({ listenersPath: 'app/nope' }, { root })))[0]
        ?.status,
    ).toBe('warn');
    mkdirSync(join(root, 'app/nope'), { recursive: true });
    expect(
      (await run('diagnostics.listeners', fakeApp({ listenersPath: 'app/nope' }, { root })))[0]
        ?.status,
    ).toBe('ok');
    expect((await run('diagnostics.listeners', fakeApp({ listenersPath: false })))[0]?.status).toBe(
      'skip',
    );
  });

  describe('diagnostics.otel', () => {
    it('skips with otel: false, with telescope installed, and without OpenTelemetry', async () => {
      expect((await run('diagnostics.otel', fakeApp({ otel: false })))[0]?.status).toBe('skip');
      const telescope = appRoot({ '@adonis-agora/telescope': {}, '@opentelemetry/api': {} });
      expect(
        (await run('diagnostics.otel', fakeApp({}, { root: telescope })))[0]?.message,
      ).toContain('telescope.otel');
      expect((await run('diagnostics.otel', fakeApp({})))[0]?.status).toBe('skip');
    });

    it('errors when SDK 2 and SDK 3 are mixed', async () => {
      const root = appRoot({
        '@opentelemetry/api': { version: '1.9.0' },
        '@opentelemetry/sdk-trace-base': { version: '2.1.0' },
        '@opentelemetry/sdk-metrics': { version: '3.0.1' },
      });
      const out = await run('diagnostics.otel', fakeApp({}, { root }));
      expect(out[0]).toMatchObject({ status: 'error' });
    });

    it('checkOtel: @adonisjs/otel 2 is SDK 3; two API copies warn', () => {
      expect(
        checkOtel({
          adonisOtel: '2.0.0',
          sdk: [{ name: '@opentelemetry/sdk-logs', version: '0.205.0', from: 'app' }],
          apiFromApp: '/a',
          apiFromDiagnostics: '/a',
        })[0]?.status,
      ).toBe('error');
      const twoApis = checkOtel({
        adonisOtel: null,
        sdk: [],
        apiFromApp: '/a',
        apiFromDiagnostics: '/b',
      });
      expect(twoApis.map((r) => r.status)).toEqual(['warn']);
      expect(sdkLine('@opentelemetry/core', '3.1.0')).toBe(3);
    });
  });

  it('the provider registers the checks into agora.doctor from boot()', async () => {
    const values = new Map<string, unknown>();
    const app = {
      inProduction: false,
      config: {
        get: (_k: string, fallback: unknown) => (_k === 'diagnostics' ? { otel: false } : fallback),
      },
      container: {
        hasBinding: (key: string) => values.has(key),
        bindValue: (key: string, value: unknown) => values.set(key, value),
        make: async (key: string) => values.get(key),
      },
    };
    await new DiagnosticsProvider(app as never).boot();
    const registry = values.get('agora.doctor') as { checks: AgoraDoctorCheck[] };
    expect(registry.checks.map((c) => c.id)).toContain('diagnostics.transport');
  });
});
