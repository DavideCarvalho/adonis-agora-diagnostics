import { readdir } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ListenerClass, registerListenerClass } from './listeners.js';

const SOURCE = /\.(?:[cm]?ts|[cm]?js)$/;
const DECLARATION = /\.d\.[cm]?ts$/;

/**
 * Import every module under `dir` and register the `@OnDiagnostic` methods of its default-exported
 * class. Listener ids are `<path from appRoot without extension>#<method>`, e.g.
 * `app/listeners/diagnostics/track_agent_run#handle`, so they are the same in development (`.ts`)
 * and in a build (`.js`). A missing directory registers nothing. `warn` is told about a module
 * that does not default-export a listener class.
 */
export async function discoverListeners(
  appRoot: string,
  dir: string,
  warn: (message: string) => void = () => {},
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return [];
    throw error;
  }

  const files = entries.filter((entry) => SOURCE.test(entry) && !DECLARATION.test(entry)).sort();
  const seen = new Set<string>();
  const registered: string[] = [];
  for (const entry of files) {
    const file = join(dir, entry);
    const stem = relative(appRoot, file).slice(0, -extname(file).length).split(sep).join('/');
    if (seen.has(stem)) continue;
    seen.add(stem);

    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    const target = mod.default;
    if (typeof target !== 'function' || target.prototype === undefined) {
      warn(`${stem}: no default-exported listener class, skipped`);
      continue;
    }
    if (registerListenerClass(target as ListenerClass, stem) === 0) {
      warn(`${stem}: the default export has no @OnDiagnostic method, skipped`);
      continue;
    }
    registered.push(stem);
  }
  return registered;
}
