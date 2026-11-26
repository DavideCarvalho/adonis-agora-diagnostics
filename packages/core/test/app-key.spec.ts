import { defineConfig, drivers } from '@adonisjs/core/encryption';
import { Secret } from '@adonisjs/core/helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diagnosticsDoctorChecks } from '../src/doctor/checks.js';
import { appKeyOf, resolveRelayAuth } from '../src/transports/auto_auth.js';
import { transports } from '../src/transports/factory.js';
import { deriveRelayKey, type RelaySecret } from '../src/transports/relay_auth.js';

/**
 * APP_KEY resolution (SECURITY-UNIFORM-SPEC §13c): `config/app.ts`'s `appKey` → the default entry of
 * `config/encryption.ts` (AdonisJS 7) → `process.env.APP_KEY`, as a `Secret` or a string.
 */

const KEY = 'app-key-from-config-0123456789';
const ENCRYPTION_KEY = 'app-key-from-encryption-012345';
const ENV_KEY = 'app-key-from-the-environment-0';

const appWith = (config: Record<string, unknown>) => ({
  config: { get: (key: string, fallback?: unknown) => (key in config ? config[key] : fallback) },
});

const release = (value: RelaySecret | undefined) =>
  typeof value === 'string' ? value : value?.release();

const savedEnv = process.env.APP_KEY;
beforeEach(() => {
  delete process.env.APP_KEY;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.APP_KEY;
  else process.env.APP_KEY = savedEnv;
});

describe('appKeyOf', () => {
  it('reads config/app.ts appKey, as a string or a Secret', async () => {
    expect(release(await appKeyOf(appWith({ 'app.appKey': KEY })))).toBe(KEY);
    const secret = new Secret(KEY);
    expect(await appKeyOf(appWith({ 'app.appKey': secret }))).toBe(secret);
  });

  it('reads the default entry of config/encryption.ts (AdonisJS 7 defineConfig + drivers)', async () => {
    // EduLiberta's file: the key only lives here.
    const legacy = defineConfig({
      default: 'legacy',
      list: { legacy: drivers.legacy({ keys: [new Secret(ENCRYPTION_KEY)] }) },
    });
    expect(release(await appKeyOf(appWith({ encryption: legacy })))).toBe(ENCRYPTION_KEY);

    // The default entry wins over the others, and its first key over older ones.
    const several = defineConfig({
      default: 'app',
      list: {
        backup: drivers.aes256gcm({ id: 'backup', keys: ['backup-key-0123456789abcdef'] }),
        app: drivers.aes256gcm({ id: 'app', keys: [ENCRYPTION_KEY, 'old-key-0123456789abcdef'] }),
      },
    });
    expect(release(await appKeyOf(appWith({ encryption: several })))).toBe(ENCRYPTION_KEY);

    // No default: the first entry.
    const noDefault = defineConfig({
      list: { only: drivers.aes256gcm({ id: 'only', keys: [ENCRYPTION_KEY] }) },
    });
    expect(release(await appKeyOf(appWith({ encryption: noDefault })))).toBe(ENCRYPTION_KEY);
  });

  it('reads already-resolved and flat encryption configs (keys[0] or key)', async () => {
    const resolvedList = { default: 'a', list: { a: { keys: [ENCRYPTION_KEY] } } };
    expect(release(await appKeyOf(appWith({ encryption: resolvedList })))).toBe(ENCRYPTION_KEY);
    const singleKey = { default: 'a', list: { a: { key: new Secret(ENCRYPTION_KEY) } } };
    expect(release(await appKeyOf(appWith({ encryption: singleKey })))).toBe(ENCRYPTION_KEY);
    expect(release(await appKeyOf(appWith({ encryption: { keys: [ENCRYPTION_KEY] } })))).toBe(
      ENCRYPTION_KEY,
    );
  });

  it('falls back to process.env.APP_KEY', async () => {
    process.env.APP_KEY = ENV_KEY;
    expect(await appKeyOf(appWith({}))).toBe(ENV_KEY);
    // An encryption config without a usable key falls through to it too.
    const empty = defineConfig({ list: { a: drivers.aes256gcm({ id: 'a', keys: [''] }) } });
    expect(await appKeyOf(appWith({ encryption: empty }))).toBe(ENV_KEY);
  });

  it('takes the sources in order: app.appKey, then encryption, then the environment', async () => {
    process.env.APP_KEY = ENV_KEY;
    const encryption = defineConfig({
      default: 'a',
      list: { a: drivers.aes256gcm({ id: 'a', keys: [ENCRYPTION_KEY] }) },
    });
    expect(release(await appKeyOf(appWith({ 'app.appKey': KEY, encryption })))).toBe(KEY);
    expect(release(await appKeyOf(appWith({ encryption })))).toBe(ENCRYPTION_KEY);
    expect(await appKeyOf(appWith({}))).toBe(ENV_KEY);
  });

  it('is undefined with no source, and survives a throwing config', async () => {
    expect(await appKeyOf(appWith({}))).toBeUndefined();
    const broken = {
      config: {
        get: () => {
          throw new Error('boom');
        },
      },
    };
    expect(await appKeyOf(broken)).toBeUndefined();
    const failingProvider = {
      type: 'provider',
      resolver: async () => Promise.reject(new Error('x')),
    };
    expect(await appKeyOf(appWith({ encryption: failingProvider }))).toBeUndefined();
  });

  it('derives the same relay key from every source holding the same APP_KEY', async () => {
    const fromEncryption = await resolveRelayAuth(
      appWith({
        encryption: defineConfig({
          default: 'legacy',
          list: { legacy: drivers.legacy({ keys: [new Secret(KEY)] }) },
        }),
      }),
      {},
      'the Redis relay',
    );
    const fromApp = await resolveRelayAuth(appWith({ 'app.appKey': KEY }), {}, 'the Redis relay');
    process.env.APP_KEY = KEY;
    const fromEnv = await resolveRelayAuth(appWith({}), {}, 'the Redis relay');
    const keyOf = (r: { options: { appKey?: RelaySecret } }) =>
      deriveRelayKey(r.options.appKey as RelaySecret).toString('hex');
    expect(fromEncryption.description).toBe('app key (auto)');
    expect(keyOf(fromEncryption)).toBe(keyOf(fromApp));
    expect(keyOf(fromEnv)).toBe(keyOf(fromApp));
  });

  it('the doctor finds a key that lives only in config/encryption.ts', async () => {
    const check = diagnosticsDoctorChecks().find((c) => c.id === 'diagnostics.relay-auth');
    const result = await check?.run(
      appWith({
        diagnostics: { default: 'q', transports: { q: transports.queue() } },
        encryption: defineConfig({
          default: 'legacy',
          list: { legacy: drivers.legacy({ keys: [new Secret(ENCRYPTION_KEY)] }) },
        }),
      }) as never,
    );
    expect(result).toMatchObject({
      status: 'ok',
      message: 'default transport "q" (queue): app key (auto)',
    });
    expect(JSON.stringify(result)).not.toContain(ENCRYPTION_KEY);
  });
});
