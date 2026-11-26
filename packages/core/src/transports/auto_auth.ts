import {
  missingRelayAuth,
  RELAY_CRYPTO_KEY,
  type RelayAuthOptions,
  type RelaySecret,
  relayAuthMode,
} from './relay_auth.js';

/**
 * The automatic mode of the AdonisJS transports: with nothing configured, a relay authenticates with
 * a key derived from the app's `APP_KEY` (see {@link appKeyOf} for where it is read). The relays only talk between processes of one app (web,
 * workers, schedulers), and those share `APP_KEY`: zero configuration, no crypto server, no grant.
 * `@adonis-agora/crypto` is used only when configured explicitly (`crypto: { cipher }`), for relays
 * between apps.
 */

interface AppLike {
  config?: { get?(key: string, fallback?: unknown): unknown };
}

const present = (value: unknown): value is RelaySecret => {
  if (typeof value === 'string') return value.length > 0;
  if (value === null || typeof value !== 'object') return false;
  const release = (value as { release?: unknown }).release;
  if (typeof release !== 'function') return false;
  try {
    const raw = (value as { release(): unknown }).release();
    return typeof raw === 'string' && raw.length > 0;
  } catch {
    return false;
  }
};

/** A config value that may be an AdonisJS config provider (`{ resolver(app) }`), resolved. */
async function resolved(value: unknown, app: unknown): Promise<unknown> {
  if (value === null || typeof value !== 'object') return value;
  const resolver = (value as { resolver?: unknown }).resolver;
  if (typeof resolver !== 'function') return value;
  try {
    return await (resolver as (app: unknown) => unknown).call(value, app);
  } catch {
    return undefined;
  }
}

/** The first key of an encryption config entry, whatever its shape (`keys[0]`, `key`). */
function keyOfEntry(entry: unknown): unknown {
  if (entry === null || typeof entry !== 'object') return undefined;
  const { keys, key } = entry as { keys?: unknown; key?: unknown };
  if (Array.isArray(keys)) return keys.find((k) => present(k));
  return key;
}

/**
 * The key of `config/encryption.ts` (AdonisJS 7): the first key of its default entry
 * (`list[default]`, else the first entry), resolving the lazy config providers `defineConfig` and
 * `drivers.*` return. A flat `{ keys }` / `{ key }` config is read as is.
 */
async function encryptionKeyOf(app: unknown): Promise<unknown> {
  let raw: unknown;
  try {
    raw = (app as AppLike)?.config?.get?.('encryption');
  } catch {
    return undefined;
  }
  const config = await resolved(raw, app);
  if (config === null || typeof config !== 'object') return undefined;
  const { list, default: name } = config as { list?: unknown; default?: unknown };
  if (list !== null && typeof list === 'object') {
    const entries = list as Record<string, unknown>;
    const chosen =
      typeof name === 'string' && Object.hasOwn(entries, name) ? name : Object.keys(entries)[0];
    return chosen === undefined ? undefined : keyOfEntry(await resolved(entries[chosen], app));
  }
  return keyOfEntry(config);
}

/**
 * The app's `APP_KEY` (SECURITY-UNIFORM-SPEC §13c, identical in every lib): `config/app.ts`'s
 * `appKey`, else the default entry of `config/encryption.ts` (AdonisJS 7), else the `APP_KEY`
 * environment variable. A `Secret` (`.release()`) or a string; never logged.
 */
export async function appKeyOf(app: unknown): Promise<RelaySecret | undefined> {
  let fromApp: unknown;
  try {
    fromApp = (app as AppLike)?.config?.get?.('app.appKey');
  } catch {
    fromApp = undefined;
  }
  if (present(fromApp)) return fromApp;
  const fromEncryption = await encryptionKeyOf(app);
  if (present(fromEncryption)) return fromEncryption;
  const fromEnv = process.env.APP_KEY;
  return present(fromEnv) ? fromEnv : undefined;
}

/** What {@link resolveRelayAuth} settled on. */
export interface ResolvedRelayAuth {
  /** The options to start the relay with (exactly one mode). */
  options: RelayAuthOptions;
  mode: 'appKey' | 'secret' | 'crypto' | 'insecure';
  /** `true` when the mode was picked by itself (`APP_KEY`). */
  auto: boolean;
  /** How the mode is described in the boot log and the doctor (`app key (auto)`). */
  description: string;
}

/** The boot log / doctor label of an explicit mode. */
export function relayModeLabel(config: RelayAuthOptions): string | undefined {
  const mode = relayAuthMode(config);
  if (mode === 'none') return undefined;
  if (mode === 'appKey') return 'app key';
  if (mode === 'crypto') {
    const key =
      typeof config.crypto === 'object' && config.crypto
        ? (config.crypto.key ?? RELAY_CRYPTO_KEY)
        : RELAY_CRYPTO_KEY;
    return `crypto (key ${key})`;
  }
  return mode;
}

/**
 * The authentication a relay of this app uses: what `config` sets explicitly, else the app's
 * `APP_KEY` (unless `crypto: false`). Throws the actionable boot error when none resolves.
 */
export async function resolveRelayAuth(
  app: unknown,
  config: RelayAuthOptions,
  what: string,
): Promise<ResolvedRelayAuth> {
  const explicit = relayAuthMode(config);
  if (explicit !== 'none') {
    return {
      options: config,
      mode: explicit,
      auto: false,
      description: relayModeLabel(config) ?? explicit,
    };
  }
  if (config.crypto !== false) {
    const appKey = await appKeyOf(app);
    if (appKey !== undefined) {
      return { options: { appKey }, mode: 'appKey', auto: true, description: 'app key (auto)' };
    }
  }
  throw new TypeError(missingRelayAuth(what, config.crypto === false));
}
