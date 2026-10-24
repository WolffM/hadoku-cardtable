import { availableParallelism, totalmem } from 'node:os';

import { defineConfig } from 'vitest/config';

import { BUILD_DEFINES } from './apps/ui/build-defines.js';

const GIB = 1024 ** 3;

/** CI's worker count for this runner (see `maxWorkers`), printed once so a slow run's log names it. */
function ciWorkers(): number {
  const n = Math.max(1, Math.min(4, Math.round(totalmem() / (4 * GIB)), Math.floor(availableParallelism() / 2)));
  console.log(`vitest: ${n} workers (${(totalmem() / GIB).toFixed(1)} GB, ${availableParallelism()} cores)`);
  return n;
}

// Root config for the whole workspace. Individual packages may add their own
// vitest.config.ts; this one is what `pnpm test` runs from the repo root, and
// it deliberately passes with no tests so the gate is green on an empty tree.
export default defineConfig({
  // The UI's build-time globals, the same object the app and embed builds use:
  // without them a test that renders the app hits a bare ReferenceError.
  define: BUILD_DEFINES,
  test: {
    environment: 'node',
    include: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'forge/**', '.claude/**'],
    passWithNoTests: true,
    // On a CI runner, `check` shares the node with three forge-e2e shards, forge-jvm
    // and every wave's proof dispatches; a unit file that takes 60 s here took
    // 231 s there, and two frame-timing cases reddened the DEPLOY GATE twice on
    // d460e2d (2026-10-08) while 120/120 green locally. The budget under CI is
    // generous because a unit test that is slow is not wrong; locally the
    // defaults stay, so a hang is still caught where it is written.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    hookTimeout: process.env.CI ? 30_000 : 10_000,
    // The worker count, not only the per-test budget: a worker per core on a
    // CI runner already running three e2e shards slows every file, and a file that
    // runs past 60 s without an event-loop turn lost its worker RPC —
    // `[vitest-worker]: Timeout calling "onTaskUpdate"` after every test passed
    // (51d7d22 and 69ee77b, 2026-10-08, the deploy gate both times). The turn
    // itself is `test-setup.ts`'s.
    // Under CI, sized to the runner's memory: one worker per 4 GB, at most four.
    // A shard peaks at 3.4–4.1 GB with four workers (cgroup memory.peak,
    // 2026-10-24), and the scheduler may put both shards on one claw beside other
    // repos' jobs. Fixed at four, both shards on the 8 GB claw-2 thrashed and ran
    // 7–9 min with 30 s timeouts across unrelated suites (fa620e4e, CI 40123902777).
    // Sized this way two shards take about half of any claw's memory.
    // Locally, half the cores rather than vitest's all-but-one: this host also
    // carries CI, Forge and other agents, and against the same twelve busy loops
    // (2026-10-16) eleven workers took 596 s with four first-in-file server cases
    // timing out, six took 392 s with none.
    maxWorkers: process.env.CI ? ciWorkers() : Math.max(1, Math.floor(availableParallelism() / 2)),
    setupFiles: ['./apps/ui/src/test-setup.ts'],
  },
});
