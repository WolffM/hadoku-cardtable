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
    // On a claw, `check` shares the node with three forge-e2e shards, forge-jvm
    // and every wave's proof dispatches; a unit file that takes 60 s here took
    // 231 s there, and two frame-timing cases reddened the DEPLOY GATE twice on
    // d460e2d (2026-10-08) while 120/120 green locally. The budget under CI is
    // generous because a unit test that is slow is not wrong; locally the
    // defaults stay, so a hang is still caught where it is written.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    hookTimeout: process.env.CI ? 30_000 : 10_000,
    setupFiles: ['./apps/ui/src/test-setup.ts'],
  },
});
