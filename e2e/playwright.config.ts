/**
 * Two browser contexts, one pod, the real built server. See `README.md`.
 *
 * Headless Chromium, one worker, no retries: a retry would turn a flaky
 * isolation failure into a green run, and this test exists to report exactly
 * that kind of failure rather than to absorb it.
 */

import { defineConfig } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX } from './identities.ts';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: './.run/test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  // A whole draft is 45 picks per seat, paced under the server's pick rate
  // limit (8 burst, then 1 per 1.5 s) — about 75 s of picking per run.
  timeout: 6 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    // One renderer for the room edge and the play edge: Chromium's site isolation moves a
    // cross-origin navigation to a new process and Playwright's screencast stops at the hop,
    // so every recording ended at the moment the match began (the operator's review page,
    // 2026-10-09: "there's still a ton of just white screen" — the room, then nothing).
    launchOptions: { args: ['--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process'] },
    browserName: 'chromium',
    headless: true,
    baseURL: EDGE_ORIGIN,
    actionTimeout: 20_000,
    navigationTimeout: 20_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: 'node harness.ts',
    cwd: import.meta.dirname,
    // Public and unauthenticated by design — the monitoring probe's route —
    // so it answers before any identity exists. The harness itself refuses to
    // come up unless the server's own /health is a 200, not a 503.
    url: `${EDGE_ORIGIN}${PREFIX}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
