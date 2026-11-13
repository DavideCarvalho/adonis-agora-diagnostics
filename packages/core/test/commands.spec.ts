import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AceFactory } from '@adonisjs/core/factories/core/ace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import DiagnosticsListenersList from '../commands/listeners.js';
import loader from '../commands/main.js';
import DiagnosticsProvider from '../providers/diagnostics_provider.js';
import type { DiagnosticsConfig } from '../src/define_config.js';
import { OnDiagnostic, registerListenerClass, resetListeners } from '../src/listeners.js';
import { stopRecentEvents } from '../src/recent.js';
import { registeredChannels, resetRegistry } from '../src/registry.js';
import { unsubscribeAll } from '../src/subscriber.js';

type Kernel = Awaited<ReturnType<typeof AceFactory.prototype.make>>;

class TrackRuns {
  @OnDiagnostic('durable', 'run.completed')
  completed() {}

  @OnDiagnostic('durable', /^run\.(failed|cancelled)$/)
  failed() {}
}

class AuditLogins {
  @OnDiagnostic('authkit')
  handle() {}
}

describe('diagnostics commands', () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'diagnostics-commands-'));
    await writeFile(
      join(appRoot, 'adonisrc.ts'),
      `import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({})\n`,
    );
    registerListenerClass(TrackRuns, 'app/listeners/diagnostics/track_runs');
    registerListenerClass(AuditLogins, 'AuditLogins');
  });

  afterEach(async () => {
    resetListeners();
    resetRegistry();
    unsubscribeAll();
    stopRecentEvents();
    await rm(appRoot, { recursive: true, force: true });
  });

  async function ace(config: DiagnosticsConfig = {}): Promise<Kernel> {
    const kernel = await new AceFactory().make(pathToFileURL(`${appRoot}/`), {
      importer: (filePath) => import(filePath),
    });
    await kernel.app.init();
    await kernel.app.boot();
    kernel.app.config.set('diagnostics', config);
    kernel.ui.switchMode('raw');
    return kernel;
  }

  async function exec(argv: string[], config?: DiagnosticsConfig) {
    const kernel = await ace(config);
    const instance = await kernel.create(DiagnosticsListenersList, argv);
    await instance.exec();
    return instance;
  }

  function printed(instance: { logger: { getLogs(): { message: string }[] } }): string {
    return instance.logger
      .getLogs()
      .map((l) => l.message)
      .join('\n');
  }

  function output(instance: { ui: { logger: { getLogs(): { message: string }[] } } }): string {
    return instance.ui.logger
      .getLogs()
      .map((l) => l.message)
      .join('\n');
  }

  it('registers diagnostics:listeners:list next to the doctor commands', async () => {
    const names = (await loader.getMetaData()).map((c) => c.commandName).sort();
    expect(names).toEqual(['agora:doctor', 'diagnostics:doctor', 'diagnostics:listeners:list']);
    const meta = (await loader.getMetaData()).find(
      (c) => c.commandName === 'diagnostics:listeners:list',
    );
    expect(meta?.options).toMatchObject({ startApp: true });
  });

  it('prints the listeners as a table with the transport and role', async () => {
    const command = await exec([]);
    expect(command.exitCode ?? 0).toBe(0);
    const text = `${printed(command)}\n${output(command)}`;
    expect(text).toContain('Transport: in-process (no transport) (local) · role: all');
    expect(text).toContain('app/listeners/diagnostics/track_runs#completed');
    expect(text).toContain('/^run\\.(failed|cancelled)$/');
    expect(text).toContain('AuditLogins#handle');
  });

  it('--json prints { transport, data, meta } and --lib filters', async () => {
    const command = await exec(['--json', '--lib=durable'], { default: 'bus', role: 'worker' });
    const parsed = JSON.parse(printed(command));
    expect(parsed).toEqual({
      transport: { name: 'bus', kind: 'custom', role: 'worker' },
      data: [
        {
          id: 'app/listeners/diagnostics/track_runs#completed',
          lib: 'durable',
          event: 'run.completed',
          method: 'completed',
        },
        {
          id: 'app/listeners/diagnostics/track_runs#failed',
          lib: 'durable',
          event: '/^run\\.(failed|cancelled)$/',
          method: 'failed',
        },
      ],
      meta: { total: 2, page: 1, size: 50, hasNext: false },
    });
  });

  it('pages with --page and --size', async () => {
    const command = await exec(['--json', '--size=2', '--page=2']);
    const parsed = JSON.parse(printed(command));
    expect(parsed.data.map((l: { id: string }) => l.id)).toEqual(['AuditLogins#handle']);
    expect(parsed.meta).toEqual({ total: 3, page: 2, size: 2, hasNext: false });
    expect(parsed.data[0].event).toBe('*');
  });

  it('refuses a bad --size or --page with exit code 1', async () => {
    const size = await exec(['--size=0']);
    expect(size.exitCode).toBe(1);
    expect(printed(size)).toContain('--size must be an integer between 1 and 1000');
    const page = await exec(['--page=0']);
    expect(page.exitCode).toBe(1);
    expect(printed(page)).toContain('--page must be an integer of at least 1');
  });

  it('says so when nothing listens', async () => {
    resetListeners();
    const command = await exec([]);
    expect(command.exitCode ?? 0).toBe(0);
    expect(printed(command)).toContain('No listeners.');
  });

  // Why there is no `diagnostics:channels:list`: channels enter the registry only when something
  // emits or traces on them, so a booted ace process (provider boot + ready, listeners subscribed)
  // has seen none. The dev tool answers for the running server process instead.
  it('a booted command process has seen no channels', async () => {
    const kernel = await ace({ listenersPath: false, otel: false });
    const provider = new DiagnosticsProvider(kernel.app as never);
    await provider.boot();
    await provider.ready();
    try {
      expect(registeredChannels()).toEqual([]);
    } finally {
      await provider.shutdown();
    }
  });
});
