import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Application } from '@adonisjs/core/app';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

/** Every `.stub` shipped by the package: the sources, plus the built copies when a build exists. */
async function stubFiles(): Promise<string[]> {
  const roots = [join(packageRoot, 'stubs'), join(packageRoot, 'dist', 'stubs')];
  const found: string[] = [];
  for (const root of roots) {
    try {
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.stub')) {
          found.push(join(entry.parentPath, entry.name));
        }
      }
    } catch {
      // dist/ only exists after a build — skip it when absent
    }
  }
  return found;
}

describe('published stubs', () => {
  it('ships the config and start stubs', async () => {
    const files = await stubFiles();
    const relative = files.map((file) => file.slice(packageRoot.length));

    expect(relative).toContain(join('stubs', 'config', 'diagnostics.stub'));
    expect(relative).toContain(join('stubs', 'start', 'diagnostics.stub'));
  });

  it('never ships an empty stub', async () => {
    const files = await stubFiles();
    expect(files.length).toBeGreaterThan(0);

    const sizes = await Promise.all(
      files.map(async (file) => [file.slice(packageRoot.length), (await stat(file)).size] as const),
    );
    const empty = sizes.filter(([, size]) => size === 0).map(([file]) => file);

    // An empty stub publishes an EMPTY config/start file into the consuming app.
    expect(empty).toEqual([]);
  });

  it('declares an exports target on every stub', async () => {
    const files = await stubFiles();

    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      expect(contents, file).toMatch(/\{\{\{\s*exports\(\{\s*to:/);
    }
  });

  it('renders every stub through the AdonisJS stub pipeline', async () => {
    const app = new Application(new URL('file:///tmp/agora-diagnostics-stub-render/'), {
      importer: () => {},
      environment: 'console',
    });
    await app.init();
    const stubs = await app.stubs.create();

    for (const root of ['stubs', join('dist', 'stubs')]) {
      const source = join(packageRoot, root);
      const files = (await stubFiles()).filter((file) => file.startsWith(`${source}/`));

      for (const file of files) {
        const name = file.slice(source.length + 1);
        const stub = await stubs.build(name, { source });
        // Raw backticks / `${` in the stub body throw here: the template is compiled
        // into a JS template literal.
        const { contents, destination } = await stub.prepare({});

        expect(contents.trim(), file).not.toBe('');
        expect(destination, file).toMatch(/\.ts$/);
      }
    }
  });
});
