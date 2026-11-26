import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ApplicationService } from '@adonisjs/core/types';
import type { DiagnosticsConfig } from '../define_config.js';
import { DEFAULT_LISTENERS_PATH } from '../listener_paths.js';
import { appKeyOf, relayModeLabel } from '../transports/auto_auth.js';
import {
  DURABLE_NOT_CONFIGURED,
  DURABLE_NOT_INSTALLED,
  DURABLE_OUTDATED,
  transportAuthOf,
  transportInfo,
} from '../transports/factory.js';
import {
  missingRelayAuth,
  RELAY_CRYPTO_KEY,
  type RelayCipher,
  type RelayCryptoOptions,
} from '../transports/relay_auth.js';
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
  options: { connection?: string },
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
  if (connection === undefined) {
    return {
      status: 'error',
      message: `default transport "${name}" is redis, but no redis connection is selected`,
      fix: 'Set `connection` in config/redis.ts, or pass transports.redis({ connection }) in config/diagnostics.ts',
      docs: `${DOCS}/transports`,
    };
  }
  if (!Object.hasOwn(redis?.connections ?? {}, connection)) {
    return {
      status: 'error',
      message: `default transport "${name}" uses the redis connection "${connection}", which is not in config/redis.ts`,
      fix: `Add "${connection}" to connections in config/redis.ts, or set transports.redis({ connection }) to one that exists`,
      docs: `${DOCS}/transports`,
    };
  }
  return {
    status: 'ok',
    message: `default transport "${name}" (redis, connection ${connection}); authentication: see diagnostics.relay-auth`,
  };
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

const AUTH_DOCS = `${DOCS}/transports#authenticating-the-relay`;
const PROBE = 'agora-doctor:diagnostics-relay';

/** Encrypt then decrypt a probe with `key`: proves this process may use it both ways. */
async function probeCipher(
  cipher: RelayCipher,
  key: string,
  owns?: (ciphertext: string) => boolean,
): Promise<string | null> {
  try {
    const { ciphertext } = await cipher.encrypt({ key, plaintext: PROBE, aad: PROBE });
    const owned = owns ? owns(ciphertext) : ciphertext.startsWith(`agora:ct1:${key}:`);
    if (!owned)
      return `the cipher did not return a "${key}" ciphertext (set crypto.owns for another format)`;
    const { plaintext } = await cipher.decrypt({ key, ciphertext, aad: PROBE, context: PROBE });
    return plaintext === PROBE ? null : 'the probe did not decrypt to itself';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The selected Redis or queue transport, with what it is configured to authenticate with. */
function relayOf(app: ApplicationService) {
  const config = configOf(app);
  const name = config.default;
  const provider = name ? config.transports?.[name] : undefined;
  const kind = transportInfo(provider)?.kind;
  if (!name || (kind !== 'redis' && kind !== 'queue')) return null;
  const auth = transportAuthOf(provider) ?? {};
  return { name, kind, auth, label: `default transport "${name}" (${kind})` };
}

/**
 * `diagnostics.relay-auth`: the mode the Redis or queue transport resolves, as boot does (reads
 * config and the environment only).
 */
async function checkRelayAuth(app: ApplicationService): Promise<AgoraDoctorResult> {
  const relay = relayOf(app);
  if (!relay) return { status: 'skip', message: 'no Redis or queue transport selected' };
  const { auth, kind, label } = relay;
  const what = kind === 'redis' ? 'the Redis relay' : 'the queue transport';
  const short = (value: unknown) => typeof value === 'string' && value.length < 16;
  if (auth.secret !== undefined && short(auth.secret)) {
    return {
      status: 'error',
      message: `${label}: the relay secret is shorter than 16 characters, so the app fails to boot`,
      fix: 'Use a long random secret, the same in every process',
      docs: AUTH_DOCS,
    };
  }
  if (auth.insecure === true && !auth.crypto && auth.secret === undefined) {
    return {
      status: 'warn',
      message:
        kind === 'redis'
          ? `${label} runs with insecure: true: anyone who can publish on Redis can inject diagnostics events`
          : `${label} runs with insecure: true: anyone who can write jobs into the queue backend can inject events and run listeners with their own input`,
      fix: "Remove `insecure` (the app's APP_KEY authenticates the relay automatically), or set `secret`",
      docs: AUTH_DOCS,
    };
  }
  const explicit = relayModeLabel(auth);
  if (explicit !== undefined) return { status: 'ok', message: `${label}: ${explicit}` };
  if (auth.crypto !== false) {
    const appKey = await appKeyOf(app);
    if (appKey !== undefined) {
      const raw = typeof appKey === 'string' ? appKey : appKey.release();
      if (raw.length < 16) {
        return {
          status: 'error',
          message: `${label}: APP_KEY is shorter than 16 characters, so the relay refuses to start`,
          fix: 'Generate one with `node ace generate:key`',
          docs: AUTH_DOCS,
        };
      }
      return { status: 'ok', message: `${label}: app key (auto)` };
    }
  }
  return {
    status: 'error',
    message: `${label} has no way to authenticate its messages: it refuses to start`,
    fix: missingRelayAuth(what, auth.crypto === false).replace('[@adonis-agora/diagnostics] ', ''),
    docs: AUTH_DOCS,
  };
}

/**
 * `diagnostics.relay-auth-key` (deep): with an explicit `crypto`, the key exists and this process
 * can encrypt and decrypt with it. The automatic `APP_KEY` mode has no key to probe.
 */
async function checkRelayAuthKey(app: ApplicationService): Promise<AgoraDoctorResult> {
  const relay = relayOf(app);
  if (!relay) return { status: 'skip', message: 'no Redis or queue transport selected' };
  const { auth, label } = relay;
  if (!auth.crypto) return { status: 'skip', message: `${label} does not use a crypto key` };
  if ((app as { isBooted?: boolean }).isBooted !== true) {
    return { status: 'skip', message: 'the crypto key is not probed without booting' };
  }
  const crypto = auth.crypto as RelayCryptoOptions;
  const key = crypto.key ?? RELAY_CRYPTO_KEY;
  let cipher: RelayCipher;
  try {
    cipher = typeof crypto.cipher === 'function' ? await crypto.cipher() : crypto.cipher;
  } catch (error) {
    return {
      status: 'error',
      message: `${label}: the crypto cipher is not available (${error instanceof Error ? error.message : String(error)})`,
      docs: AUTH_DOCS,
    };
  }
  const problem = await probeCipher(cipher, key, crypto.owns);
  return problem === null
    ? { status: 'ok', message: `${label}: crypto key ${key}, encrypt and decrypt work` }
    : {
        status: 'error',
        message: `${label}: crypto key "${key}" is not usable from this process: ${problem}`,
        fix: `Create the key on the crypto server (\`node ace crypto:keys:create ${key} --type aes256-gcm --application <app>\`), and give every relaying process crypto:encrypt:${key} and crypto:decrypt:${key}`,
        docs: AUTH_DOCS,
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
            return checkRedis(app, name, info.options as { connection?: string });
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
        const size = typeof recent === 'object' && recent !== null ? recent.size : undefined;
        if (size !== undefined && (!Number.isInteger(size) || size < 1)) {
          return {
            status: 'error',
            message: `recent.size is ${String(size)}: it must be a positive integer, so the app fails to boot`,
            fix: 'Set recent.size to a positive integer (default 500) in config/diagnostics.ts',
            docs: `${DOCS}/mcp-tools#recent-events`,
          };
        }
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
    {
      id: 'diagnostics.relay-auth',
      lib: 'diagnostics',
      title: 'Relay authentication',
      run: checkRelayAuth,
    },
    {
      id: 'diagnostics.relay-auth-key',
      lib: 'diagnostics',
      title: 'Relay crypto key',
      cost: 'deep',
      run: checkRelayAuthKey,
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
