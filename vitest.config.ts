import { defineConfig } from 'vitest/config';

import { APP_NAME } from './apps/ui/app-name.js';

// Root config for the whole workspace. Individual packages may add their own
// vitest.config.ts; this one is what `pnpm test` runs from the repo root, and
// it deliberately passes with no tests so the gate is green on an empty tree.
export default defineConfig({
  define: {
    // Must mirror apps/ui's vite.config.ts: `define` is a build-time
    // substitution, so without this a test that renders the app hits a bare
    // ReferenceError and fails looking like anything else.
    __HADOKU_APP_NAME__: JSON.stringify(APP_NAME),
  },
  test: {
    environment: 'node',
    include: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'forge/**', '.claude/**'],
    passWithNoTests: true,
  },
});
