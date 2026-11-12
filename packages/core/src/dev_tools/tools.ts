import diagnostics_channel from 'node:diagnostics_channel';
import { CHANNEL_PREFIX } from '../channel.js';
import { registeredListeners } from '../listeners.js';
import { recentEventsBuffer } from '../recent.js';
import { registeredChannels } from '../registry.js';
import type { DiagnosticsRole } from '../role.js';
import { transportInfo } from '../transports/factory.js';
import type { DevTool, DevToolInputProperty, DevToolsHub } from './contract.js';
import { DEV_TOOLS_BINDING } from './contract.js';

/** What the tools read about this process's setup, at call time. */
export interface DiagnosticsDevToolsDeps {
  /** `config/diagnostics.ts` (`default`, `role`, `transports`). */
  config: () => {
    default?: string;
    role?: DiagnosticsRole;
    transports?: Record<string, unknown>;
  };
}

const limit: DevToolInputProperty = {
  type: 'integer',
  description: 'How many items to return (default 20, max 100).',
  minimum: 1,
  maximum: 100,
};
const page: DevToolInputProperty = {
  type: 'integer',
  description: 'Page number, from 1 (the `next` of the previous answer).',
  minimum: 1,
};
const lib: DevToolInputProperty = {
  type: 'string',
  description: "Only this library ('durable', 'resilience', 'authkit'…).",
};

function intOf(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(max, Math.floor(value)))
    : fallback;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** One page of `items` in the `{ items, next }` shape every dev-tools list returns. */
export function pageOf<T>(items: readonly T[], input: Record<string, unknown>) {
  const size = intOf(input.limit, 20, 100);
  const number = intOf(input.page, 1);
  const start = (number - 1) * size;
  return {
    items: items.slice(start, start + size),
    next: start + size < items.length ? number + 1 : null,
  };
}

/** `agora:durable:run.completed` → `{ lib: 'durable', event: 'run.completed' }`. */
function parseChannel(name: string): { lib: string; event: string } {
  const rest = name.slice(CHANNEL_PREFIX.length + 1);
  const at = rest.indexOf(':');
  return at === -1
    ? { lib: rest, event: '' }
    : { lib: rest.slice(0, at), event: rest.slice(at + 1) };
}

/** Subscribers of a channel, when Node exposes the count; the recent-events buffer is not counted. */
function subscriberCount(name: string): number | null {
  const channel = diagnostics_channel.channel(name) as unknown as { _subscribers?: unknown[] };
  if (!Array.isArray(channel._subscribers)) return null;
  const own = recentEventsBuffer()?.started ? 1 : 0;
  return Math.max(0, channel._subscribers.length - own);
}

function describeTransport(deps: DiagnosticsDevToolsDeps) {
  const config = deps.config();
  const role = config.role ?? 'all';
  if (!config.default) return { name: null, kind: 'local', role };
  const info = transportInfo(config.transports?.[config.default]);
  return { name: config.default, kind: info?.kind ?? 'custom', role };
}

const RECENT_OFF =
  'The recent-events buffer is off in this process. It runs outside production when the Agora dev tools are installed; set `recent: { size: 500 }` in config/diagnostics.ts to turn it on anywhere.';

/** The diagnostics developer tools (all read-only): channels, listeners and recent events. */
export function diagnosticsDevTools(deps: DiagnosticsDevToolsDeps): DevTool[] {
  return [
    {
      name: 'diagnostics_list_channels',
      kind: 'read',
      description:
        'Every agora:<lib>:<event> diagnostics channel this process has seen, with its lib, event and ' +
        'how many subscribers it has (0 = emitting it costs nothing). Paged: { items, next }.',
      input: {
        type: 'object',
        properties: {
          lib,
          subscribed: {
            type: 'boolean',
            description: 'true: only channels someone listens to; false: only silent ones.',
          },
          limit,
          page,
        },
      },
      async run(input) {
        const only = str(input.lib);
        const items = registeredChannels()
          .sort()
          .map((channel) => {
            const subscribers = subscriberCount(channel);
            return { channel, ...parseChannel(channel), subscribers };
          })
          .filter((c) => only === undefined || c.lib === only)
          .filter((c) =>
            typeof input.subscribed === 'boolean'
              ? (c.subscribers ?? 0) > 0 === input.subscribed
              : true,
          );
        return pageOf(items, input);
      },
    },
    {
      name: 'diagnostics_list_listeners',
      kind: 'read',
      description:
        'The app listeners (@OnDiagnostic classes and onDiagnostic references): id, lib, event matcher ' +
        'and method, plus the transport that runs them (local, redis, queue or durable) and this ' +
        "process's role. Paged: { items, next }.",
      input: { type: 'object', properties: { lib, limit, page } },
      async run(input) {
        const only = str(input.lib);
        const items = registeredListeners()
          .filter((l) => only === undefined || l.lib === only)
          .map((l) => ({
            id: l.id,
            lib: l.lib,
            event:
              l.event === undefined ? '*' : l.event instanceof RegExp ? String(l.event) : l.event,
            method: l.method,
          }));
        return { transport: describeTransport(deps), ...pageOf(items, input) };
      },
    },
    {
      name: 'diagnostics_list_recent_events',
      kind: 'read',
      description:
        'The newest diagnostics events of the process that answers (lib, event, traceId, payload cut to ' +
        '2 KB, secret-looking keys redacted). Filter by lib, event (exact, or /regex/) and traceId.',
      input: {
        type: 'object',
        properties: {
          lib,
          event: {
            type: 'string',
            description: "An exact event name, or a /regex/ like '/run\\.(failed|cancelled)/'.",
          },
          traceId: { type: 'string', description: 'Only events of this trace.' },
          limit,
        },
      },
      async run(input) {
        const buffer = recentEventsBuffer();
        if (buffer === null) {
          return { items: [], next: null, enabled: false, scope: 'this process', hint: RECENT_OFF };
        }
        const libFilter = str(input.lib);
        const event = str(input.event);
        const traceId = str(input.traceId);
        const items = buffer.list({
          ...(libFilter !== undefined ? { lib: libFilter } : {}),
          ...(event !== undefined ? { event } : {}),
          ...(traceId !== undefined ? { traceId } : {}),
          limit: intOf(input.limit, 20, 100),
        });
        return {
          items,
          next: null,
          enabled: true,
          scope: 'this process',
          buffered: buffer.count,
          size: buffer.size,
        };
      },
    },
  ];
}

/** The slice of the AdonisJS container {@link registerDiagnosticsDevTools} uses. */
export interface DevToolsContainer {
  hasBinding(binding: string): boolean;
  make(binding: string): Promise<unknown>;
}

/**
 * Register the diagnostics tools into the dev-tools hub, when the agent's MCP provider bound one and
 * it can gate a lib without a console (`supports('endpoint-authorize')`). Never throws: returns why
 * it did not register.
 */
export async function registerDiagnosticsDevTools(
  container: DevToolsContainer,
  deps: DiagnosticsDevToolsDeps,
): Promise<'registered' | 'no-hub' | 'unsupported' | 'failed'> {
  if (!container.hasBinding(DEV_TOOLS_BINDING)) return 'no-hub';
  try {
    const hub = (await container.make(DEV_TOOLS_BINDING)) as DevToolsHub | undefined;
    if (hub?.version !== 1) return 'unsupported';
    if (typeof hub.supports !== 'function' || !hub.supports('endpoint-authorize')) {
      return 'unsupported';
    }
    hub.register({
      lib: 'diagnostics',
      title: 'Diagnostics bus',
      tools: diagnosticsDevTools(deps),
    });
    return 'registered';
  } catch {
    return 'failed';
  }
}
