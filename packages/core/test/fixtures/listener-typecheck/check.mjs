/**
 * Type-checks `app.ts` — listeners, typed through a `ChannelRegistry` augmentation — the way a
 * consumer app compiles it: by NAME through the package `exports` map (the published `dist/**.d.ts`),
 * under NodeNext + strict. Twice: with `experimentalDecorators` (what AdonisJS apps use) and with
 * standard decorators. `app.ts` holds `@ts-expect-error` lines, so a type that stopped rejecting a
 * wrong payload fails here as an unused directive.
 *
 * Exits 0 on success. Driven by `listener-typecheck.spec.ts`.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('../../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

function linkDependencies(appRoot) {
  const from = join(pkgRoot, 'node_modules');
  const to = join(appRoot, 'node_modules');
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      mkdirSync(join(to, entry), { recursive: true });
      for (const scoped of readdirSync(join(from, entry))) {
        symlinkSync(join(from, entry, scoped), join(to, entry, scoped));
      }
      continue;
    }
    symlinkSync(join(from, entry), join(to, entry));
  }
  mkdirSync(join(to, '@adonis-agora'), { recursive: true });
  symlinkSync(pkgRoot, join(to, '@adonis-agora/diagnostics'));
}

const failures = [];
for (const experimentalDecorators of [true, false]) {
  const appRoot = mkdtempSync(join(tmpdir(), 'diagnostics-listener-typecheck-'));
  try {
    writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ type: 'module', private: true }));
    linkDependencies(appRoot);
    copyFileSync(fileURLToPath(new URL('./app.ts', import.meta.url)), join(appRoot, 'app.ts'));
    writeFileSync(
      join(appRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022', 'esnext.decorators'],
          types: ['node'],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          experimentalDecorators,
          ...(experimentalDecorators ? { emitDecoratorMetadata: true } : {}),
        },
        include: ['app.ts'],
      }),
    );
    execFileSync(join(repoRoot, 'node_modules/.bin/tsc'), ['-p', join(appRoot, 'tsconfig.json')], {
      cwd: appRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (error) {
    failures.push(
      `experimentalDecorators=${experimentalDecorators}\n${error.stdout ?? ''}${error.stderr ?? ''}`,
    );
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error('listener typecheck: FAILED');
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log('listener typecheck: OK (experimentalDecorators and standard decorators)');
