import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * `@OnDiagnostic` and `onDiagnostic` are typed through the `ChannelRegistry`. That can only be
 * checked by compiling consumer code against the published declarations, with a registry
 * augmentation; see `fixtures/listener-typecheck/check.mjs`.
 */
describe('listener types, in a consumer app (published declarations)', () => {
  const harness = fileURLToPath(
    new URL('./fixtures/listener-typecheck/check.mjs', import.meta.url),
  );
  const distTypes = fileURLToPath(new URL('../dist/src/index.d.ts', import.meta.url));

  if (!existsSync(distTypes)) {
    if (process.env.CI) {
      it('type-checks the listener fixture', () => {
        expect.fail(`${distTypes} does not exist: run \`pnpm build\` before \`pnpm test\`.`);
      });
    } else {
      it.skip('dist/ does not exist — run `pnpm build` first', () => {});
    }
  } else {
    it('types the payload from the registry and rejects a mismatched listener', async () => {
      const { stdout } = await execFileAsync(process.execPath, [harness], { timeout: 115_000 });
      expect(stdout).toContain('listener typecheck: OK');
    }, 120_000);
  }
});
