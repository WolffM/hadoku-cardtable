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
    // The worker count, not only the per-test budget: with a worker per core
    // on a claw already running three e2e shards, vitest's own main thread is
    // starved and its worker RPC dies — `[vitest-worker]: Timeout calling
    // "onTaskUpdate"` after every test passed (51d7d22 and 69ee77b, 2026-10-08,
    // the deploy gate both times). Four workers keep the run under five
    // minutes and leave the main thread its turn.
    maxWorkers: process.env.CI ? 4 : undefined,
    setupFiles: ['./apps/ui/src/test-setup.ts'],
  },
});
