import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * Compiles every PUBLISHED stub inside a scratch consumer app, against the real `@adonisjs/*` types
 * and this package's SHIPPED declarations.
 *
 * This closes a coverage gap that is invisible to every other gate here. A `.stub` is a template
 * that no tsconfig `include` reaches, so nothing type-checks the code a user actually receives from
 * `node ace configure`. The package's own typecheck compiles `src/` against the library's own types,
 * which are trivially happy with themselves, and `stubs.spec.ts` proves the stubs exist, are not
 * empty and render — but it operates on text, so it cannot see a type error.
 *
 * Both halves of that gap have already bitten. This package published both stubs at ZERO bytes.
 * And `@adonis-agora/agent` published a stub that existed, had content, rendered fine, and still did
 * not compile in a consumer app: its structural `rawQuery` declared `bindings?: unknown[]`, which is
 * not assignable in either direction to Lucid's `RawQueryBindings`, so no real client satisfied it.
 * Its whole suite stayed green. "Not empty" is a step below "compiles for the person who gets it".
 *
 * The scratch app resolves the package BY NAME through its `exports` map, so what is checked is the
 * published `dist/**\/*.d.ts` — dropping a symbol from the root barrel leaves the package's own
 * typecheck green (its internal imports are relative) and fails here, with the consumer's diagnostic.
 */
describe('the published stubs compile in a consumer app (real @adonisjs types)', () => {
  const harness = fileURLToPath(new URL('./fixtures/stub-typecheck/check.mjs', import.meta.url));
  const distTypes = fileURLToPath(new URL('../dist/src/index.d.ts', import.meta.url));

  // Resolving the package by name makes a built package a precondition: a hard failure under CI
  // (where `pnpm test` gates the publish), a convenience skip on a machine that has not built yet.
  if (!existsSync(distTypes)) {
    if (process.env.CI) {
      it('type-checks the rendered stubs', () => {
        expect.fail(
          [
            `${distTypes} does not exist, so this spec cannot check anything.`,
            'It is the only check that the generated code COMPILES for a consumer; under CI a',
            'missing build is a failure, not a skip. Run `pnpm build` before `pnpm test`.',
          ].join(' '),
        );
      });
    } else {
      it.skip('dist/ does not exist — run `pnpm --filter @adonis-agora/diagnostics build` first', () => {});
    }
  } else {
    // A cold `tsc` over the Adonis declaration graph is a few seconds; 90s is a ceiling that will
    // not flake under full-suite load but still fails rather than hangs.
    it('type-checks the rendered stubs against the published declarations', async () => {
      const { stdout } = await execFileAsync(process.execPath, [harness], { timeout: 85_000 });
      expect(stdout).toContain('stub typecheck: OK');
    }, 90_000);
  }
});
