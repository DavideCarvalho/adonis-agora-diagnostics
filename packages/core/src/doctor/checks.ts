import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ApplicationService } from '@adonisjs/core/types';
import type { DiagnosticsConfig } from '../define_config.js';
import { DEFAULT_LISTENERS_PATH } from '../listener_paths.js';
import {
  DURABLE_NOT_CONFIGURED,
  DURABLE_NOT_INSTALLED,
  DURABLE_OUTDATED,
  type RedisTransportConfig,
  transportInfo,
} from '../transports/factory.js';
import {
  type AgoraDoctorCheck,
  type AgoraDoctorResult,
  installedVersion,
  packageDir,
} from './agora_doctor.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/diagnostics';
const ROLES = ['all', 'api', 'worker'];

function configOf(app: ApplicationService): DiagnosticsConfig {
  return app.config.get<DiagnosticsConfig | undefined>('diagnostics', {}) ?? {};
}

async function readExports(dir: string): Promise<Record<string, unknown> | null> {
  try {
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      exports?: unknown;
    };
    return typeof manifest.exports === 'object' && manifest.exports !== null
      ? (manifest.exports as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function exportPath(exportsField: Record<string, unknown>, subpath: string): string | null {
  const target = exportsField[subpath];
  if (typeof target === 'string') return target;
  if (typeof target === 'object' && target !== null) {
    for (const key of ['import', 'default']) {
      const value = (target as Record<string, unknown>)[key];
      if (typeof value === 'string') return value;
    }
  }
  return null;
}

/** `diagnostics.transport` for a `durable` default: installed, new enough, and configured. */
async function checkDurable(app: ApplicationService, name: string): Promise<AgoraDoctorResult> {
  const dir = await packageDir('@adonis-agora/durable', app.makePath());
  if (dir === null) {
    return { status: 'error', message: `default transport "${name}": ${DURABLE_NOT_INSTALLED}` };
  }
  const exportsField = await readExports(dir);
  const entry = exportsField ? exportPath(exportsField, './diagnostics') : null;
  if (entry === null) {
    return { status: 'error', message: `default transport "${name}": ${DURABLE_OUTDATED}` };
  }
  if (!(app as { isBooted?: boolean }).isBooted) {
    return {
      status: 'ok',
      message: `default transport "${name}" (durable); configuration not checked without booting`,
    };
  }
  try {
    const mod = (await import(pathToFileURL(join(dir, entry)).href)) as {
      isConfigured?: (app: ApplicationService) => boolean | Promise<boolean>;
    };
    if (typeof mod.isConfigured !== 'function') {
      return { status: 'error', message: `default transport "${name}": ${DURABLE_OUTDATED}` };
    }
    if (!(await mod.isConfigured(app))) {
      return {
        status: 'error',
        message: `default transport "${name}": ${DURABLE_NOT_CONFIGURED}`,
        docs: `${DOCS}/transports`,
      };
    }
  } catch (error) {
    return {
      status: 'error',
      message: `default transport "${name}": @adonis-agora/durable/diagnostics failed to load (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  return { status: 'ok', message: `default transport "${name}" (durable), durable is configured` };
}

async function checkRedis(
  app: ApplicationService,
  name: string,
  options: RedisTransportConfig,
): Promise<AgoraDoctorResult> {
  if ((await packageDir('@adonisjs/redis', app.makePath())) === null) {
    return {
      status: 'error',
      message: `default transport "${name}" is redis, but @adonisjs/redis is not installed`,
      fix: 'Install and configure @adonisjs/redis (`node ace add @adonisjs/redis`), or pick another transport',
      docs: `${DOCS}/transports`,
    };
  }
  const redis = app.config.get<{ connection?: string; connections?: Record<string, unknown> }>(
    'redis',
    {},
  );
  const connection = options.connection ?? redis?.connection;
  if (connection === undefined || !Object.hasOwn(redis?.connections ?? {}, connection)) {
    return {
      status: 'error',
      message: `default transport "${name}" uses the redis connection "${String(connection)}", which is not in config/redis.ts`,
      fix: `Add "${String(connection)}" to connections in config/redis.ts, or set transports.redis({ connection }) to one that exists`,
      docs: `${DOCS}/transports`,
    };
  }
  return { status: 'ok', message: `default transport "${name}" (redis, connection ${connection})` };
}

async function checkQueue(app: ApplicationService, name: string): Promise<AgoraDoctorResult> {
  if ((await packageDir('@adonisjs/queue', app.makePath())) === null) {
    return {
      status: 'error',
      message: `default transport "${name}" is queue, but @adonisjs/queue is not installed`,
      fix: 'Install and configure @adonisjs/queue (`node ace add @adonisjs/queue`), or pick another transport',
      docs: `${DOCS}/transports`,
    };
  }
  if (app.config.get('queue', undefined) === undefined) {
    return {
      status: 'error',
      message: `default transport "${name}" is queue, but config/queue.ts is missing`,
      fix: 'Run `node ace configure @adonisjs/queue`',
      docs: `${DOCS}/transports`,
    };
  }
  return {
    status: 'ok',
    message: `default transport "${name}" (queue): run \`node ace queue:work\` to deliver to listeners`,
  };
}

/** The doctor checks of `@adonis-agora/diagnostics` (ids frozen for 1.x). */
export function diagnosticsDoctorChecks(): AgoraDoctorCheck[] {
  return [
    {
      id: 'diagnostics.transport',
      lib: 'diagnostics',
      title: 'Transport',
      async run(app): Promise<AgoraDoctorResult> {
        const config = configOf(app);
        const name = config.default;
        if (!name) return { status: 'ok', message: 'local only (no default transport)' };
        const provider = config.transports?.[name];
        if (provider === undefined) {
          return {
            status: 'error',
            message: `config.default is "${name}", but config.transports.${name} is not defined`,
            fix: `Add ${name} to transports in config/diagnostics.ts, or point default at one that is`,
            docs: `${DOCS}/transports`,
          };
        }
        const info = transportInfo(provider);
        switch (info?.kind) {
          case 'durable':
            return checkDurable(app, name);
          case 'redis':
            return checkRedis(app, name, info.options as RedisTransportConfig);
          case 'queue':
            return checkQueue(app, name);
          default:
            return { status: 'ok', message: `default transport "${name}" (custom)` };
        }
      },
    },
    {
      id: 'diagnostics.role',
      lib: 'diagnostics',
      title: 'Role and transport',
      run(app): AgoraDoctorResult | AgoraDoctorResult[] {
        const config = configOf(app);
        const role = config.role ?? 'all';
        if (!ROLES.includes(role)) {
          return {
            status: 'error',
            message: `config.role is ${JSON.stringify(role)}: it must be 'all', 'api' or 'worker'`,
            docs: `${DOCS}/transports`,
          };
        }
        if (role !== 'all' && !config.default) {
          return {
            status: 'error',
            message: `config.role is "${role}" but no default transport carries events between the api and worker halves`,
            fix: 'Select a transport with `default` in config/diagnostics.ts, or drop `role`',
            docs: `${DOCS}/transports`,
          };
        }
        const forward = config.forward;
        const forwards =
          forward !== undefined &&
          (forward.all === true ||
            (forward.libs?.length ?? 0) > 0 ||
            (forward.channels?.length ?? 0) > 0);
        if (forwards && !config.default) {
          return {
            status: 'warn',
            message:
              '`forward` is set but no default transport is selected, so nothing is forwarded',
            fix: 'Select a transport with `default` in config/diagnostics.ts, or remove `forward`',
            docs: `${DOCS}/transports`,
          };
        }
        return { status: 'ok', message: `role: ${role}` };
      },
    },
    {
      id: 'diagnostics.recent-buffer',
      lib: 'diagnostics',
      title: 'Recent-events buffer',
      run(app): AgoraDoctorResult {
        const recent = configOf(app).recent;
        const on = recent === true || (typeof recent === 'object' && recent !== null);
        if (on && app.inProduction) {
          return {
            status: 'warn',
            message:
              '`recent` keeps the recent-events buffer on in production: it listens to every channel, so every emit builds its event',
            fix: 'Remove `recent` from config/diagnostics.ts unless you need it in production',
            docs: `${DOCS}/mcp-tools#recent-events`,
          };
        }
        if (on) return { status: 'ok', message: 'the recent-events buffer is on' };
        return {
          status: 'ok',
          message:
            recent === false
              ? 'the recent-events buffer is off'
              : 'the recent-events buffer runs outside production with the Agora dev tools',
        };
      },
    },
    {
      id: 'diagnostics.listeners',
      lib: 'diagnostics',
      title: 'Listeners directory',
      async run(app): Promise<AgoraDoctorResult> {
        const path = configOf(app).listenersPath;
        if (path === false) return { status: 'skip', message: 'listener discovery is off' };
        const dir = app.makePath(path ?? DEFAULT_LISTENERS_PATH);
        const exists = await stat(dir)
          .then((s) => s.isDirectory())
          .catch(() => false);
        if (exists)
          return { status: 'ok', message: `listeners from ${path ?? DEFAULT_LISTENERS_PATH}` };
        if (path === undefined) {
          return { status: 'ok', message: `no ${DEFAULT_LISTENERS_PATH} directory (no listeners)` };
        }
        return {
          status: 'warn',
          message: `listenersPath is "${path}", which does not exist: no listener is discovered`,
          fix: 'Create the directory, or fix listenersPath in config/diagnostics.ts',
          docs: `${DOCS}/listeners`,
        };
      },
    },
    {
      id: 'diagnostics.otel',
      lib: 'diagnostics',
      title: 'OpenTelemetry bridge',
      async run(app): Promise<AgoraDoctorResult[]> {
        if (configOf(app).otel === false) {
          return [{ status: 'skip', message: 'the OpenTelemetry bridge is off (otel: false)' }];
        }
        const root = app.makePath();
        if ((await packageDir('@adonis-agora/telescope', root)) !== null) {
          return [
            { status: 'skip', message: 'telescope is installed: telescope.otel checks this' },
          ];
        }
        return checkOtel(await readOtelInstall(root));
      },
    },
  ];
}

/** The OTel SDK packages compared (the API package `@opentelemetry/api` is separate). */
const OTEL_SDK_PACKAGES = [
  '@opentelemetry/core',
  '@opentelemetry/resources',
  '@opentelemetry/sdk-trace-base',
  '@opentelemetry/sdk-trace-node',
  '@opentelemetry/sdk-trace',
  '@opentelemetry/sdk-metrics',
  '@opentelemetry/sdk-logs',
  '@opentelemetry/sdk-node',
  '@opentelemetry/context-async-hooks',
] as const;

/** What {@link checkOtel} reads, as resolved from the app root. */
export interface OtelInstall {
  adonisOtel: string | null;
  sdk: Array<{ name: string; version: string; from: string }>;
  apiFromApp: string | null;
  apiFromDiagnostics: string | null;
}

/** The OpenTelemetry SDK line a package version belongs to (`2` or `3`), or `null`. */
export function sdkLine(name: string, version: string): 2 | 3 | null {
  const major = Number(/^(\d+)/.exec(version)?.[1] ?? Number.NaN);
  const minor = Number(/^\d+\.(\d+)/.exec(version)?.[1] ?? Number.NaN);
  if (major === 2 || major === 3) return major;
  if (major === 0 && minor >= 200 && name.startsWith('@opentelemetry/')) return 2;
  return null;
}

/**
 * `diagnostics.otel`: SDK 2 and SDK 3 packages mixed (error: their providers do not interoperate;
 * `@adonisjs/otel` 2 ships SDK 3), or two copies of `@opentelemetry/api` (warn: the bridge would
 * emit spans into a global the app's SDK never reads).
 */
export function checkOtel(install: OtelInstall): AgoraDoctorResult[] {
  if (install.apiFromApp === null && install.adonisOtel === null && install.sdk.length === 0) {
    return [{ status: 'skip', message: 'OpenTelemetry is not installed' }];
  }
  const results: AgoraDoctorResult[] = [];
  const lines = new Map<2 | 3, string[]>();
  for (const pkg of install.sdk) {
    const line = sdkLine(pkg.name, pkg.version);
    if (line === null) continue;
    lines.set(line, [...(lines.get(line) ?? []), `${pkg.name}@${pkg.version} (${pkg.from})`]);
  }
  const adonisMajor = Number(/^(\d+)/.exec(install.adonisOtel ?? '')?.[1] ?? Number.NaN);
  if (adonisMajor === 2 && !lines.has(3)) lines.set(3, [`@adonisjs/otel@${install.adonisOtel}`]);
  if (lines.has(2) && lines.has(3)) {
    results.push({
      status: 'error',
      message: `OpenTelemetry SDK 2 and SDK 3 are mixed: ${(lines.get(2) ?? []).join(', ')} next to ${(lines.get(3) ?? []).join(', ')}`,
      fix:
        adonisMajor === 2
          ? 'Move every @opentelemetry SDK package to 3.x (the line @adonisjs/otel 2 uses)'
          : 'Keep every @opentelemetry SDK package on one major line',
      docs: `${DOCS}/opentelemetry`,
    });
  }
  if (
    install.apiFromApp !== null &&
    install.apiFromDiagnostics !== null &&
    install.apiFromApp !== install.apiFromDiagnostics
  ) {
    results.push({
      status: 'warn',
      message:
        'two copies of @opentelemetry/api are installed (one for the app, one for diagnostics): bridged spans may land in a global your SDK never reads',
      fix: 'Dedupe @opentelemetry/api (one version for the whole app, e.g. a pnpm override)',
      docs: `${DOCS}/opentelemetry`,
    });
  }
  if (results.length === 0) {
    const line = lines.has(3) ? 'SDK 3' : lines.has(2) ? 'SDK 2' : 'the API only';
    results.push({ status: 'ok', message: `OpenTelemetry is consistent (${line})` });
  }
  return results;
}

async function readOtelInstall(root: string): Promise<OtelInstall> {
  const sdk: OtelInstall['sdk'] = [];
  const seen = new Set<string>();
  const scan = async (from: string, label: string) => {
    for (const name of OTEL_SDK_PACKAGES) {
      const dir = await packageDir(name, from);
      if (dir === null || seen.has(dir)) continue;
      seen.add(dir);
      const version = await installedVersion(name, from);
      if (version !== null) sdk.push({ name, version, from: label });
    }
  };
  await scan(root, 'app');
  const adonisOtelDir = await packageDir('@adonisjs/otel', root);
  if (adonisOtelDir !== null) await scan(adonisOtelDir, '@adonisjs/otel');
  const diagnosticsDir = await packageDir('@adonis-agora/diagnostics', root);
  return {
    adonisOtel: await installedVersion('@adonisjs/otel', root),
    sdk,
    apiFromApp: await packageDir('@opentelemetry/api', root),
    apiFromDiagnostics:
      diagnosticsDir === null ? null : await packageDir('@opentelemetry/api', diagnosticsDir),
  };
}
