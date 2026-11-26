import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * A stand-in for `@adonis-agora/crypto`'s runtime (the `agora.crypto` binding): keys per partition,
 * a service with principals (embedded crypto), and the app's own `operations`. Only what the relays
 * touch, shaped like the real thing.
 */

interface Principal {
  partition: string;
  capabilities: string[];
  actor: string;
}

const allows = (capabilities: string[], wanted: string) =>
  capabilities.some(
    (c) => c === '*' || c === wanted || (c.endsWith('*') && wanted.startsWith(c.slice(0, -1))),
  );

class CryptoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class FakeCryptoStore {
  readonly keys = new Map<string, { type: string; material: Buffer }>();
  async getKey(partition: string, name: string) {
    const key = this.keys.get(`${partition}/${name}`);
    return key ? { type: key.type } : null;
  }
}

export class FakeCryptoService {
  readonly store = new FakeCryptoStore();
  readonly calls: Array<{ op: string; principal: Principal; name: string }> = [];

  async createKey(principal: Principal, input: { name: string; type: string }) {
    this.calls.push({ op: 'createKey', principal, name: input.name });
    if (!allows(principal.capabilities, `crypto:keys:manage:${input.name}`)) {
      throw new CryptoError('forbidden', 'forbidden');
    }
    const id = `${principal.partition}/${input.name}`;
    if (this.store.keys.has(id)) throw new CryptoError('conflict', 'exists');
    this.store.keys.set(id, { type: input.type, material: randomBytes(32) });
    return { name: input.name };
  }

  #material(principal: Principal, name: string, op: 'encrypt' | 'decrypt'): Buffer {
    this.calls.push({ op, principal, name });
    if (!allows(principal.capabilities, `crypto:${op}:${name}`)) {
      throw new CryptoError('forbidden', `no crypto:${op}:${name}`);
    }
    const key = this.store.keys.get(`${principal.partition}/${name}`);
    if (!key) throw new CryptoError('not_found', `crypto: no key named "${name}"`);
    return key.material;
  }

  async encrypt(principal: Principal, input: { key: string; plaintext: string; aad?: string }) {
    const material = this.#material(principal, input.key, 'encrypt');
    const iv = randomBytes(12);
    const gcm = createCipheriv('aes-256-gcm', material, iv);
    gcm.setAAD(Buffer.from(input.aad ?? ''));
    const body = Buffer.concat([gcm.update(input.plaintext, 'utf8'), gcm.final()]);
    return {
      ciphertext: `agora:ct1:${input.key}:1:${Buffer.concat([iv, gcm.getAuthTag(), body]).toString('base64url')}`,
    };
  }

  async decrypt(principal: Principal, input: { key: string; ciphertext: string; aad?: string }) {
    const material = this.#material(principal, input.key, 'decrypt');
    const raw = Buffer.from(input.ciphertext.split(':').pop() as string, 'base64url');
    const gcm = createDecipheriv('aes-256-gcm', material, raw.subarray(0, 12));
    gcm.setAAD(Buffer.from(input.aad ?? ''));
    gcm.setAuthTag(raw.subarray(12, 28));
    return {
      plaintext: Buffer.concat([gcm.update(raw.subarray(28)), gcm.final()]).toString('utf8'),
    };
  }
}

/** The operations of one partition, as one principal (what `runtime.operations` is). */
export function operationsOf(service: FakeCryptoService, principal: Principal) {
  return {
    encrypt: (input: { key: string; plaintext: string; aad?: string }) =>
      service.encrypt(principal, input),
    decrypt: (input: { key: string; ciphertext: string; aad?: string }) =>
      service.decrypt(principal, input),
    createKey: (input: { name: string; type: string }) => service.createKey(principal, input),
  };
}

/** Crypto embedded in this app (standalone): `service` present, operations with `crypto:*`. */
export function embeddedCrypto(partition = 'shop', service = new FakeCryptoService()) {
  return {
    service,
    runtime: {
      topology: 'standalone' as const,
      partition,
      service,
      operations: operationsOf(service, { partition, capabilities: ['crypto:*'], actor: 'app' }),
    },
  };
}

/** This app is a tenant of a crypto server elsewhere: no `service`, operations limited by its token. */
export function tenantCrypto(
  partition: string,
  server: FakeCryptoService,
  capabilities = ['crypto:encrypt:console-*', 'crypto:decrypt:console-*'],
) {
  return {
    topology: 'tenant' as const,
    partition,
    operations: operationsOf(server, { partition, capabilities, actor: `tenant:${partition}` }),
  };
}

/** An application whose container has (or not) the `agora.crypto` binding. */
export function appWith(runtime: unknown, logger: Record<string, unknown> = {}) {
  return {
    container: {
      hasBinding: (binding: string) => binding === 'agora.crypto' && runtime !== undefined,
      make: async (binding: string) => {
        if (binding === 'agora.crypto') return runtime;
        if (binding === 'logger') return logger;
        throw new Error(`no binding ${binding}`);
      },
    },
  };
}
