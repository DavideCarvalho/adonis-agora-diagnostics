#!/usr/bin/env node
/**
 * Runs `publint` and `@arethetypeswrong/cli` against every non-private package under
 * `packages/`. Run it after `pnpm build`: both tools pack the package, so they see exactly
 * the files that would reach npm. ESM-only packages (`"type": "module"` with no `require`
 * condition) are checked with attw's `esm-only` profile.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages');

const hasRequireCondition = (exports) => JSON.stringify(exports ?? {}).includes('"require"');

let checked = 0;
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = join(packagesDir, entry.name);
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.private === true) continue;

  const esmOnly = manifest.type === 'module' && !hasRequireCondition(manifest.exports);
  const run = (...args) => execFileSync('pnpm', ['exec', ...args], { cwd: dir, stdio: 'inherit' });

  console.log(`\n== ${manifest.name}`);
  run('publint', '--strict');
  run('attw', '--pack', '.', ...(esmOnly ? ['--profile', 'esm-only'] : []));
  checked++;
}

if (checked === 0) {
  console.error('check:package found no publishable packages under packages/.');
  process.exit(1);
}
