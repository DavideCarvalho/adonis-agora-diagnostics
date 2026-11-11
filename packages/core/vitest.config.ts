import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Legacy (`experimentalDecorators`) decorators, the flavour AdonisJS apps compile with: the
  // listener specs use `@OnDiagnostic` on real classes.
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: false },
      },
    }),
  ],
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.{spec,test}.ts'],
    pool: 'forks',
  },
});
