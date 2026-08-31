/**
 * Type-checks every PUBLISHED stub the way a consumer app does: a scratch AdonisJS-shaped app that
 * depends on `@adonis-agora/diagnostics` by NAME, with each stub rendered by the REAL AdonisJS stub
 * renderer into the file `node ace configure` actually writes, compiled by a real `tsc --noEmit`
 * under NodeNext + strict.
 *
 * WHY THIS EXISTS. A `.stub` is a template that no tsconfig `include` reaches, so it is invisible to
 * every other gate in this repo. The package's own typecheck compiles `src/` against the library's
 * OWN types, which are trivially happy with themselves. `stubs.spec.ts` proves each stub exists, is
 * not empty, and renders — but it operates on text, so it cannot see a type error.
 *
 * That gap is not hypothetical twice over. This package shipped both stubs at ZERO bytes through
 * every gate. And `@adonis-agora/agent` shipped a stub that existed, had content, rendered fine, and
 * still did not compile in a consumer app: its structural `rawQuery` declared `bindings?: unknown[]`,
 * not assignable in either direction to Lucid's `RawQueryBindings`, so no real client satisfied it.
 * "Not empty" is a step below "compiles for the person who receives it".
 *
 * Resolution matters as much as compilation. The scratch app reaches the package through its
 * `exports` map, so what is checked is the PUBLISHED `dist/**\/*.d.ts` a consumer installs — not
 * `src/`, which a check run inside this repo would otherwise pick up. Dropping an export from the
 * root barrel keeps the package's own typecheck green (its internal imports are relative) and fails
 * HERE, with the diagnostic the consumer would get.
 *
 * Exits 0 on success; on failure prints tsc's diagnostics and exits non-zero.
 * Driven by `stub-typecheck.spec.ts`.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Application } from '@adonisjs/core/app';

const pkgRoot = fileURLToPath(new URL('../../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

/**
 * The stubs `configure` publishes. Both are checked: the config file carries the typed
 * `defineConfig` call, and the start file is where a consumer's handlers go — it emits no typed code
 * today, so compiling it is what keeps that true the day someone adds an example to it.
 *
 * The stubs are read from `dist/stubs`, which is what the published `stubsRoot` points at and what
 * `node ace configure` reads in an installed app.
 */
const STUBS = ['config/diagnostics.stub', 'start/diagnostics.stub'];

/**
 * Mirror the package's `node_modules` into the scratch app, entry by entry, so the stubs resolve
 * every peer they import plus anything the published declarations transitively reference. Scoped
 * directories are recreated as real directories so `@adonis-agora/diagnostics` can be added
 * alongside without writing into the package's own tree.
 *
 * Mirroring wholesale rather than naming a fixed list keeps the harness from rotting: a new peer
 * dependency is picked up automatically instead of failing here as a confusing missing-types error.
 */
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

  // The package under test, resolved BY NAME through its `exports` map → dist/**/*.d.ts.
  mkdirSync(join(to, '@adonis-agora'), { recursive: true });
  symlinkSync(pkgRoot, join(to, '@adonis-agora/diagnostics'));
}

/**
 * The config stub ships its cross-process transports as a commented block, with instructions to
 * widen the import and uncomment it. Those instructions are part of what we hand the user, so the
 * code they produce has to compile too — otherwise `transports.redis(...)` could drift out of the
 * published types and every gate would still pass, because the only live line in the generated file
 * is `otel: true`.
 *
 * Derived mechanically from the generated file so it cannot fall out of sync with the stub, and
 * hard-failing if its anchors move: a transform that silently produces nothing checks nothing.
 */
function fanOutVariant(config) {
  const lines = config.split('\n');
  const lastCommentEnd = lines.findLastIndex((line) => line.includes('*/'));
  if (lastCommentEnd === -1)
    throw new Error('config stub: no block comment — transform anchors broken');

  const body = lines
    .slice(lastCommentEnd + 1)
    .map((line) => line.replace(/^(\s*)\/\/ ?/, '$1'))
    .join('\n');

  for (const anchor of ['default:', 'transports:', 'transports.redis(', 'transports.queue(']) {
    if (!body.includes(anchor)) {
      throw new Error(
        `config stub: uncommented block is missing "${anchor}" — transform anchors broken`,
      );
    }
  }

  const widened = [...lines.slice(0, lastCommentEnd + 1), body]
    .join('\n')
    .replace(
      "import { defineConfig } from '@adonis-agora/diagnostics'",
      "import { defineConfig, transports } from '@adonis-agora/diagnostics'",
    );
  if (!widened.includes('defineConfig, transports')) {
    throw new Error('config stub: import line moved — transform anchors broken');
  }
  return widened;
}

const appRoot = mkdtempSync(join(tmpdir(), 'diagnostics-stub-typecheck-'));
try {
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify(
      { name: 'diagnostics-stub-typecheck-app', type: 'module', private: true },
      null,
      2,
    ),
  );
  linkDependencies(appRoot);

  /**
   * The real renderer, pointed at the scratch app: `exports({ to: app.configPath(...) })` resolves
   * against THIS app root, so each stub lands exactly where `node ace configure` would put it —
   * escapes, destinations and all. A hand-rolled regex renderer would be checking a file the
   * generator never writes.
   */
  const app = new Application(pathToFileURL(`${appRoot}/`), {
    importer: () => {},
    environment: 'console',
  });
  await app.init();
  const stubs = await app.stubs.create();
  const source = join(pkgRoot, 'dist', 'stubs');

  let configPath = null;
  for (const name of STUBS) {
    const stub = await stubs.build(name, { source });
    const { contents, destination } = await stub.generate({ force: true });

    // Anything left unrendered would reach tsc as literal braces — a compile error nobody can
    // explain, or worse, one that gets "fixed" by loosening this check until it looks at nothing.
    const leftover = contents.match(/\{\{.*?\}\}/);
    if (leftover) throw new Error(`unrendered template syntax ${leftover[0]} left in ${name}`);
    if (!destination.startsWith(appRoot)) {
      throw new Error(`${name} renders outside the scratch app: ${destination}`);
    }
    if (name.startsWith('config/')) configPath = destination;
  }
  if (configPath === null) throw new Error('config stub did not render — nothing to check');

  writeFileSync(
    join(appRoot, 'config', 'diagnostics_fanout.ts'),
    fanOutVariant(readFileSync(configPath, 'utf8')),
  );

  /**
   * An AdonisJS app's own compiler options: NodeNext + strict, which is what `@adonisjs/tsconfig`
   * sets. Both matter — NodeNext is what makes the package's `exports` map (and therefore its
   * published declarations) the thing being resolved, and `strict` is what turns a variance
   * mismatch from a silent widening into a hard error.
   */
  writeFileSync(
    join(appRoot, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022'],
          types: ['node'],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          esModuleInterop: true,
        },
        include: ['config/**/*.ts', 'start/**/*.ts'],
      },
      null,
      2,
    ),
  );

  try {
    execFileSync(join(repoRoot, 'node_modules/.bin/tsc'), ['-p', join(appRoot, 'tsconfig.json')], {
      cwd: appRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (error) {
    console.error('stub typecheck: FAILED — a published stub does not compile in a consumer app');
    console.error(error.stdout ?? '');
    console.error(error.stderr ?? '');
    process.exit(1);
  }
} finally {
  rmSync(appRoot, { recursive: true, force: true });
}

console.log(`stub typecheck: OK (${STUBS.length} stubs + the config stub's fan-out block)`);
