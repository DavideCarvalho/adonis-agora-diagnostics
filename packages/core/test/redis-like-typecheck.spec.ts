import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/** Type-checks `types/ioredis.ts`: ioredis 6 and ioredis 5 clients satisfy `RedisLike`. */
it('accepts ioredis 6 and ioredis 5 clients as RedisLike', async () => {
  const tsc = fileURLToPath(new URL('../../../node_modules/.bin/tsc', import.meta.url));
  const project = fileURLToPath(new URL('./types/tsconfig.json', import.meta.url));
  const result = await execFileAsync(tsc, ['-p', project], { timeout: 115_000 }).then(
    ({ stdout, stderr }) => `${stdout}${stderr}`,
    (error: { stdout?: string; stderr?: string }) => `${error.stdout ?? ''}${error.stderr ?? ''}`,
  );
  expect(result).toBe('');
}, 120_000);
