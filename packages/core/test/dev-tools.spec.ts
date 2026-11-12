import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DiagnosticsProvider from '../providers/diagnostics_provider.js';
import { emit } from '../src/channel.js';
import type { DiagnosticsConfig } from '../src/define_config.js';
import type { DevTool, DevToolCall, DevToolsHub, DevToolsLib } from '../src/dev_tools/contract.js';
import {
  diagnosticsDevTools,
  pageOf,
  registerDiagnosticsDevTools,
} from '../src/dev_tools/tools.js';
import { onDiagnostic as onDiagnosticRef } from '../src/index.js';
import { resetListeners } from '../src/listeners.js';
import {
  boundPayload,
  RECENT_PAYLOAD_BYTES,
  RecentEventsBuffer,
  recentEvents,
  recentEventsBuffer,
  startRecentEvents,
  stopRecentEvents,
} from '../src/recent.js';
import { resetRegistry } from '../src/registry.js';
import { onDiagnostic, unsubscribeAll } from '../src/subscriber.js';
import { transportInfo, transports } from '../src/transports/factory.js';

const call: DevToolCall = {
  ctx: {},
  caller: { id: 'dev-open', via: 'open' },
  limits: { maxRows: 100, maxBytes: 48_000 },
};

afterEach(() => {
  stopRecentEvents();
  unsubscribeAll();
  resetListeners();
  resetRegistry();
});

function tools(config: Parameters<typeof diagnosticsDevTools>[0]['config'] = () => ({})) {
  const list = diagnosticsDevTools({ config });
  return (name: string) => list.find((t) => t.name === name) as DevTool;
}

describe('recent-events buffer', () => {
  it('keeps the newest events up to its size, newest first', () => {
    const buffer = new RecentEventsBuffer(3);
    buffer.start();
    for (let i = 1; i <= 5; i++) emit('ring', 'tick', { i });
    expect(buffer.count).toBe(3);
    expect(buffer.list({ limit: 10 }).map((e) => (e.payload as { i: number }).i)).toEqual([
      5, 4, 3,
    ]);
    buffer.stop();
    emit('ring', 'tick', { i: 6 });
    expect(buffer.count).toBe(3);
  });

  it('subscribes to channels registered after it started', () => {
    const buffer = startRecentEvents(10);
    emit('late', 'first-time', { ok: true });
    expect(buffer.list()[0]).toMatchObject({ lib: 'late', event: 'first-time' });
  });

  it('filters by lib, exact event, /regex/ and traceId', () => {
    startRecentEvents(10);
    emit('durable', 'run.failed', {}, { traceId: 't1' });
    emit('durable', 'run.completed', {}, { traceId: 't2' });
    emit('agent', 'run.failed', {});
    expect(recentEvents({ lib: 'durable' }).map((e) => e.event)).toEqual([
      'run.completed',
      'run.failed',
    ]);
    expect(recentEvents({ event: 'run.failed' })).toHaveLength(2);
    expect(recentEvents({ event: '/completed$/' }).map((e) => e.lib)).toEqual(['durable']);
    expect(recentEvents({ traceId: 't1' })).toHaveLength(1);
    expect(() => recentEvents({ event: '/(/' })).toThrow(/invalid event pattern/);
  });

  it('redacts secret-looking keys and cuts big payloads to 2 KB', () => {
    expect(boundPayload({ user: 1, apiKey: 'x', nested: { password: 'p', token: 't' } })).toEqual({
      user: 1,
      apiKey: '[redacted]',
      nested: { password: '[redacted]', token: '[redacted]' },
    });
    const big = boundPayload({ blob: 'x'.repeat(5000) }) as {
      truncated: boolean;
      bytes: number;
      preview: string;
    };
    expect(big.truncated).toBe(true);
    expect(big.bytes).toBeGreaterThan(5000);
    expect(big.preview.length).toBeLessThanOrEqual(RECENT_PAYLOAD_BYTES + 1);
  });

  it('rejects a bad size', () => {
    expect(() => new RecentEventsBuffer(0)).toThrow(/positive integer/);
  });
});

describe('diagnostics dev tools', () => {
  it('are read tools that follow the hub naming rules and the input subset', () => {
    const list = diagnosticsDevTools({ config: () => ({}) });
    expect(list.map((t) => [t.name, t.kind])).toEqual([
      ['diagnostics_list_channels', 'read'],
      ['diagnostics_list_listeners', 'read'],
      ['diagnostics_list_recent_events', 'read'],
    ]);
    for (const t of list) {
      expect(t.name).toMatch(/^diagnostics_[a-z0-9]+(_[a-z0-9]+)+$/);
      for (const prop of Object.values(t.input.properties)) {
        expect(['string', 'number', 'integer', 'boolean', 'array']).toContain(prop.type);
      }
    }
  });

  it('diagnostics_list_channels lists channels with subscriber counts', async () => {
    emit('billing', 'invoice-paid', {});
    emit('durable', 'run.failed', {});
    const off = onDiagnostic('durable', 'run.failed', () => {});
    startRecentEvents(10);
    const out = (await tools()('diagnostics_list_channels').run({}, call)) as {
      items: Array<{ channel: string; lib: string; event: string; subscribers: number | null }>;
    };
    expect(out.items).toEqual([
      {
        channel: 'agora:billing:invoice-paid',
        lib: 'billing',
        event: 'invoice-paid',
        subscribers: 0,
      },
      { channel: 'agora:durable:run.failed', lib: 'durable', event: 'run.failed', subscribers: 1 },
    ]);
    const silent = (await tools()('diagnostics_list_channels').run(
      { subscribed: false },
      call,
    )) as { items: Array<{ lib: string }> };
    expect(silent.items.map((c) => c.lib)).toEqual(['billing']);
    const durableOnly = (await tools()('diagnostics_list_channels').run(
      { lib: 'durable' },
      call,
    )) as {
      items: unknown[];
    };
    expect(durableOnly.items).toHaveLength(1);
    off();
  });

  it('diagnostics_list_listeners lists listeners and the transport', async () => {
    class Audit {
      handle() {}
    }
    onDiagnosticRef('agent', 'run.finished', [Audit, 'handle']);
    onDiagnosticRef('durable', /run\./, [Audit, 'handle'], { id: 'audit-durable' });
    const config = () => ({
      default: 'jobs',
      role: 'api' as const,
      transports: { jobs: transports.queue({ queue: 'diag' }) },
    });
    const out = (await tools(config)('diagnostics_list_listeners').run({}, call)) as {
      transport: unknown;
      items: unknown[];
    };
    expect(out.transport).toEqual({ name: 'jobs', kind: 'queue', role: 'api' });
    expect(out.items).toEqual([
      { id: 'Audit#handle', lib: 'agent', event: 'run.finished', method: 'handle' },
      { id: 'audit-durable', lib: 'durable', event: '/run\\./', method: 'handle' },
    ]);
    const local = (await tools()('diagnostics_list_listeners').run({}, call)) as {
      transport: unknown;
    };
    expect(local.transport).toEqual({ name: null, kind: 'local', role: 'all' });
  });

  it('diagnostics_list_recent_events reads the buffer, or says it is off', async () => {
    const off = (await tools()('diagnostics_list_recent_events').run({}, call)) as {
      enabled: boolean;
      hint: string;
    };
    expect(off.enabled).toBe(false);
    expect(off.hint).toContain('recent: { size: 500 }');

    startRecentEvents(50);
    emit('durable', 'run.failed', { runId: 'r1' }, { traceId: 'abc' });
    emit('agent', 'run.finished', {});
    const out = (await tools()('diagnostics_list_recent_events').run(
      { lib: 'durable', traceId: 'abc' },
      call,
    )) as { items: Array<{ payload: unknown }>; enabled: boolean; buffered: number };
    expect(out.enabled).toBe(true);
    expect(out.buffered).toBe(2);
    expect(out.items.map((e) => e.payload)).toEqual([{ runId: 'r1' }]);
  });

  it('pageOf clamps', () => {
    expect(pageOf([1, 2, 3], { limit: 2, page: 2 })).toEqual({ items: [3], next: null });
  });

  it('transportInfo identifies the built-in transports', () => {
    expect(transportInfo(transports.redis({ connection: 'main' }))).toEqual({
      kind: 'redis',
      options: { connection: 'main' },
    });
    expect(transportInfo(transports.durable())?.kind).toBe('durable');
    expect(transportInfo(async () => () => {})).toBeUndefined();
  });
});

describe('registerDiagnosticsDevTools', () => {
  const container = (hub: unknown) => ({
    hasBinding: (key: string) => key === 'agora.devTools' && hub !== undefined,
    make: async () => hub,
  });

  it('registers without authorize on a hub that supports endpoint-authorize', async () => {
    const registered: DevToolsLib[] = [];
    const hub: DevToolsHub = {
      version: 1,
      register: (lib) => registered.push(lib),
      supports: (f) => f === 'endpoint-authorize',
    };
    expect(await registerDiagnosticsDevTools(container(hub), { config: () => ({}) })).toBe(
      'registered',
    );
    expect(registered[0]).toMatchObject({ lib: 'diagnostics' });
    expect(registered[0]?.authorize).toBeUndefined();
  });

  it('skips on no hub and an old hub, never throws', async () => {
    const deps = { config: () => ({}) };
    expect(await registerDiagnosticsDevTools(container(undefined), deps)).toBe('no-hub');
    expect(await registerDiagnosticsDevTools(container({ version: 1, register() {} }), deps)).toBe(
      'unsupported',
    );
    const throwing = {
      version: 1,
      supports: () => true,
      register: () => {
        throw new Error('x');
      },
    };
    expect(await registerDiagnosticsDevTools(container(throwing), deps)).toBe('failed');
  });
});

describe('DiagnosticsProvider: dev tools and the recent-events buffer', () => {
  function app(config: DiagnosticsConfig, opts: { hub?: boolean; inProduction?: boolean } = {}) {
    const registered: DevToolsLib[] = [];
    const hub: DevToolsHub = {
      version: 1,
      register: (lib) => registered.push(lib),
      supports: () => true,
    };
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const application = {
      inProduction: opts.inProduction ?? false,
      config: { get: (_k: string, fallback: unknown) => ({ otel: false, ...config }) ?? fallback },
      container: {
        hasBinding: (key: string) => opts.hub === true && key === 'agora.devTools',
        make: async (binding: unknown) =>
          binding === 'agora.devTools' ? hub : binding === 'logger' ? logger : undefined,
      },
      makePath: (...parts: string[]) => ['/nonexistent', ...parts].join('/'),
    } as unknown as ApplicationService;
    return { provider: new DiagnosticsProvider(application), registered };
  }

  it('in development with the hub: registers the tools and starts the buffer', async () => {
    const { provider, registered } = app({}, { hub: true });
    await provider.boot();
    expect(registered.map((l) => l.lib)).toEqual(['diagnostics']);
    expect(recentEventsBuffer()?.started).toBe(true);
    await provider.shutdown();
    expect(recentEventsBuffer()).toBeNull();
  });

  it('in production with the hub: tools yes, buffer off unless `recent` is set', async () => {
    const prod = app({}, { hub: true, inProduction: true });
    await prod.provider.boot();
    expect(prod.registered).toHaveLength(1);
    expect(recentEventsBuffer()).toBeNull();

    const opted = app({ recent: { size: 42 } }, { hub: true, inProduction: true });
    await opted.provider.boot();
    expect(recentEventsBuffer()?.size).toBe(42);
  });

  it('without the hub: nothing by default, the buffer with `recent: true`', async () => {
    const plain = app({});
    await plain.provider.boot();
    expect(recentEventsBuffer()).toBeNull();
    const on = app({ recent: true });
    await on.provider.boot();
    expect(recentEventsBuffer()?.size).toBe(500);
  });

  it('`devTools: false` registers nothing and keeps the default buffer off; `recent: false` too', async () => {
    const noTools = app({ devTools: false }, { hub: true });
    await noTools.provider.boot();
    expect(noTools.registered).toEqual([]);
    expect(recentEventsBuffer()).toBeNull();
    const noRecent = app({ recent: false }, { hub: true });
    await noRecent.provider.boot();
    expect(noRecent.registered).toHaveLength(1);
    expect(recentEventsBuffer()).toBeNull();
  });
});
