import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));

interface Manifest {
  name?: string;
  private?: boolean;
  engines?: { node?: string };
}

/**
 * An exact version — optionally `v`-prefixed — with no range comparator at all. This is what
 * Renovate's `rangeStrategy: "pin"` turns `engines.node` into if it is left to manage it: the one
 * build the bot happened to see, which then warns (or hard-fails under `engine-strict`) on every
 * other Node an installing app runs.
 */
const EXACT_PIN = /^v?\d+(\.\d+)*$/;

/** Whether a semver string expresses a RANGE rather than a single exact version. */
function isRange(value: string): boolean {
  return value.trim() !== '' && !EXACT_PIN.test(value.trim());
}

/** Every workspace package that actually gets published (i.e. not `private`). */
async function publishableManifests(): Promise<{ path: string; manifest: Manifest }[]> {
  const packagesDir = join(workspaceRoot, 'packages');
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const found: { path: string; manifest: Manifest }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(packagesDir, entry.name, 'package.json');
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await readFile(path, 'utf8')) as Manifest;
    } catch {
      continue; // not a package directory
    }
    if (manifest.private === true) continue;
    found.push({ path, manifest });
  }
  return found;
}

describe('publishable package manifests', () => {
  it('finds the publishable packages', async () => {
    const manifests = await publishableManifests();
    expect(manifests.length).toBeGreaterThan(0);
    expect(manifests.map(({ manifest }) => manifest.name)).toContain('@adonis-agora/diagnostics');
  });

  it('declares engines.node as a range, never an exact version', async () => {
    const manifests = await publishableManifests();

    for (const { path, manifest } of manifests) {
      const node = manifest.engines?.node;
      expect(node, `${path}: engines.node is missing`).toBeTypeOf('string');
      // A pinned exact version warns on every other Node and fails under `engine-strict`.
      // Renovate's global `rangeStrategy: "pin"` will do exactly that unless engines is
      // excluded — see the `matchDepTypes: ["engines"]` rule in renovate.json.
      expect(isRange(node as string), `${path}: engines.node "${node}" is an exact version`).toBe(
        true,
      );
    }
  });

  it('rejects the exact-version forms a pinning bot produces', () => {
    for (const pinned of ['v26.7.0', '26.7.0', 'v22.23.2', '22', 'v20.20.2']) {
      expect(isRange(pinned), pinned).toBe(false);
    }

    for (const range of ['>=20.6.0', '^20.6.0', '~20.6.0', '>=20.6.0 <23', '20 || 22', '*']) {
      expect(isRange(range), range).toBe(true);
    }
  });
});

describe('renovate config', () => {
  it("keeps engines out of the bot's hands", async () => {
    // The global `rangeStrategy: "pin"` applies to every dep type it is allowed to touch.
    // Without this rule the bot rewrites engines.node back to a single exact version.
    const config = JSON.parse(await readFile(join(workspaceRoot, 'renovate.json'), 'utf8')) as {
      packageRules?: { matchDepTypes?: string[]; enabled?: boolean }[];
    };

    const rule = config.packageRules?.find((entry) => entry.matchDepTypes?.includes('engines'));

    expect(rule, 'renovate.json needs a packageRule matching the "engines" depType').toBeDefined();
    expect(rule?.enabled).toBe(false);
  });
});
