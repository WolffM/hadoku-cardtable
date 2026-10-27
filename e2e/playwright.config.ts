/**
 * Two browser contexts, one pod, the real built server. See `README.md`.
 *
 * Headless, one worker, no retries: a retry would turn a flaky isolation
 * failure into a green run, and this test exists to report exactly that kind of
 * failure rather than to absorb it.
 *
 * The browser is chosen per spec file, here and only here: a spec runs in
 * Chromium unless it is listed under a project of another browser. CI installs
 * exactly the browsers these projects name (`install-browsers.ts` reads them
 * from this config), so a spec cannot need a browser the runner lacks.
 */

import { defineConfig } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX } from './identities.ts';

/**
 * Firefox, because it is the browser a report came from: it sends pointer events Chromium does not
 * (`bl-ui-scale-click`), and a flyer jumped there every 1.4 s while it looped smoothly in Chromium
 * (`fly-jump`, the operator, 2026-10-23), and a deck tile's pips sat below its name there
 * (`deck-tile-row`).
 */
const FIREFOX_SPECS = ['bl-ui-scale-click.spec.ts', 'deck-tile-row.spec.ts', 'fly-jump.spec.ts'];

/**
 * Of `FIREFOX_SPECS`, the ones proven in Chromium too (not excluded from that project's own
 * `testMatch`) — wave 76 §C: the attacking outline riding a flyer's float must hold in both
 * engines, since `getComputedStyle(el, '::before')`'s animated value is read the same way in each,
 * even though the jump bug `fly-jump.spec.ts` exists for was Firefox-only.
 */
const ALSO_CHROMIUM = ['fly-jump.spec.ts'];

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: './.run/test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  // A whole draft is 45 picks per seat, paced under the server's pick rate
  // limit (15 burst, then 4 a second) — about 20 s of picking per run.
  timeout: 6 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  projects: [
    {
      name: 'chromium',
      testIgnore: FIREFOX_SPECS.filter((spec) => !ALSO_CHROMIUM.includes(spec)),
      use: {
        browserName: 'chromium',
        // One renderer for the room edge and the play edge: Chromium's site isolation moves a
        // cross-origin navigation to a new process and Playwright's screencast stops at the hop,
        // so every recording ended at the moment the match began (the operator's review page,
        // 2026-10-09: "there's still a ton of just white screen" — the room, then nothing).
        launchOptions: { args: ['--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process'] },
      },
    },
    { name: 'firefox', testMatch: FIREFOX_SPECS, use: { browserName: 'firefox' } },
  ],
  use: {
    headless: true,
    baseURL: EDGE_ORIGIN,
    actionTimeout: 20_000,
    navigationTimeout: 20_000,
    // Never a trace: recording one slows every test, and the timing specs
    // sample frames. Same sha, three of them ×5 on the claws: 7 of 25 red in
    // 16 min traced, 25 of 25 green in 8.4 min untraced (runs 40471245587,
    // 40471255011).
    trace: 'off',
    // On CI a failing test keeps a screenshot of every page it had open,
    // taken as it fails, so nothing runs while the test does. It lands in
    // `outputDir`, which every e2e job's evidence step uploads: one policy for
    // ci.yml, forge-e2e, e2e-nightly and a targeted dispatch alike. A red a
    // re-run cannot reproduce (issue #3's unanswered OK) is only diagnosable
    // from the run it happened in. Off locally, where a lane re-runs a red
    // under its own eyes.
    screenshot: process.env.CI ? 'only-on-failure' : 'off',
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
