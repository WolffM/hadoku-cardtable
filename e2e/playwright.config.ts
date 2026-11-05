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
import { PHONE } from './play/phone.ts';

/**
 * Wave 89: every phone spec (`*.phone.spec.ts`) runs ONLY under the `phone` project, in `PHONE`'s
 * context (390×844, touch, dark). The desktop projects below both exclude this pattern explicitly —
 * `chromium`'s `testIgnore` and `firefox`'s `testMatch` allowlist, which already can't match a name
 * it doesn't list — so a phone spec is never picked up twice and never run against the desktop board.
 */
const PHONE_SPEC = /\.phone\.spec\.ts$/;

/**
 * Firefox, because it is the browser a report came from: it sends pointer events Chromium does not
 * (`bl-ui-scale-click`), and a flyer jumped there every 1.4 s while it looped smoothly in Chromium
 * (`fly-jump`, the operator, 2026-10-23), and a deck tile's pips sat below its name there
 * (`deck-tile-row`), and the front page's room list dropped frames scrolling there (`front-scroll-perf`,
 * the operator, 2026-10-28).
 */
const FIREFOX_SPECS = ['bl-ui-scale-click.spec.ts', 'deck-tile-row.spec.ts', 'fly-jump.spec.ts', 'front-scroll-perf.spec.ts'];

/**
 * Of `FIREFOX_SPECS`, the ones proven in Chromium too (not excluded from that project's own
 * `testMatch`) — wave 76 §C: the attacking outline riding a flyer's float must hold in both
 * engines, since `getComputedStyle(el, '::before')`'s animated value is read the same way in each,
 * even though the jump bug `fly-jump.spec.ts` exists for was Firefox-only; and the room list's scroll,
 * where Chromium is the reference Firefox is measured against.
 */
const ALSO_CHROMIUM = ['fly-jump.spec.ts', 'front-scroll-perf.spec.ts'];

/**
 * Wave 89 triage: the existing suite's own proof that the phone driver path (tap-to-read/choose, a
 * card-view cast, a CDP touch drag) works on real specs, not just the lanes' own purpose-written
 * red-first ones. Curated by category — cast, target, combat, prompts, search, stack, mulligan,
 * concede — from a real claw triage (run 41391671524, `verify/w89-e-triage1`, dispatched before A's
 * portrait switch and D's card-view cast path had landed): most of these are RED until both do. That
 * is tracked here, not hidden — `docs/lanes/RULES.md`'s "investigate every red" rather than excluding
 * what is merely not finished yet. These are ordinary desktop specs; they keep running under
 * `chromium` exactly as before, and ALSO run here, under touch.
 */
const PHONE_CORE = [
  // cast
  'af69-searing-blaze.spec.ts',
  'cl-class-level.spec.ts',
  'ch-pool-choice.spec.ts',
  'nf-offer-gap.spec.ts',
  'xw-kessig-x.spec.ts',
  // combat
  'w54-blockers.spec.ts',
  'menace-block.spec.ts',
  'af66-combat-priority.spec.ts',
  // prompts
  'qt-prompt-question.spec.ts',
  'confirm-pairing.spec.ts',
  'dredge-confirm.spec.ts',
  // search (a multi-pick/selection sheet, never a hardcoded desktop size)
  'tk-tinker.spec.ts',
  'dv-delve.spec.ts',
  'cascade-discover.spec.ts',
  // stack
  'af67-yield-stack.spec.ts',
  'af68-unpayable-offer.spec.ts',
  'cp-lethal-blow.spec.ts',
  'w34.spec.ts',
  'arrows.spec.ts',
  // mulligan
  'w62-cointoss.spec.ts',
  'af64-mulligan-order.spec.ts',
  // concede
  'early-end.spec.ts',
  'h1-match-ended.spec.ts',
  'un-unfinished-game.spec.ts',
  // cast-adjacent
  'af61-phyrexian.spec.ts',
  'af57-exact-count.spec.ts',
];

/**
 * Desktop-geometry (or mouse-only, no Settled touch equivalent) specs the same triage showed cannot
 * pass under `phone-core` no matter what lands — kept OUT of `PHONE_CORE` above, and named here too
 * (`phone-core`'s own `testIgnore`) so a future addition to `PHONE_CORE` can't reintroduce one by
 * accident. Each with the reason the triage found. `prompt-bar.spec.ts`, `w87b-stack.spec.ts`,
 * `wresolve-chain.spec.ts` and `af72-stack-hand-size.spec.ts` were in the first draft of `PHONE_CORE`
 * and were pulled back out here once a closer read showed each resizes to a hardcoded desktop size
 * (1280×800 or the trailer's 1920×1080) as the thing it tests — `w34.spec.ts` keeps ONE sub-case doing
 * the same (poison/energy/experience counters "at 1280×800 and 1366×768"); its other cases are real
 * cast/stack coverage, and config-level `testMatch`/`testIgnore` cannot split one file by test title,
 * so that sub-case is a known, accepted false red under `phone-core` rather than a reason to drop the
 * whole file.
 */
const PHONE_CORE_EXCLUDE: readonly (readonly [file: string, reason: string])[] = [
  ['af50-combat-damage.spec.ts', 'own title: "fits 1280×800" — a hardcoded desktop viewport check'],
  ['table-fit.spec.ts', 'measures the desktop table never scrolling, at the default viewport'],
  ['pod-fit.spec.ts', 'draft screen at 1280×800 — draft is Settled 10, out of scope'],
  ['glyph-rail.spec.ts', 'own header: "At 1280×720 and 1920×1080"'],
  ['lobby-fit.spec.ts', 'own header: "At 1280×800, 1366×768 and 1024×700" — lobby/front page, Settled 10 and wzoom\'s own claim'],
  ['masticore-fit.spec.ts', 'own header: "At the default 1280×720"'],
  ['draft-fan-fit.spec.ts', 'draft screen, browser-zoom emulation (deviceScaleFactor) — Settled 10, out of scope'],
  ['drag.spec.ts', 'tests mouse-only nuances (right-click cancel, in-hand drag-reorder) with no Settled touch equivalent'],
  ['prompt-bar.spec.ts', 'own header: "At 1280×800 and at a short window" — resizes to a hardcoded desktop size'],
  ['w87b-stack.spec.ts', "both cases: \"at the trailer's 1920×1080\" (TRAILER constant)"],
  ['wresolve-chain.spec.ts', "\"at the trailer's 1920×1080\" (TRAILER constant)"],
  ['af72-stack-hand-size.spec.ts', 'resizes to a hardcoded 1280×800'],
  ['dv-delve.spec.ts', 'counts the graveyard and exile zones the desktop seat draws; portrait shows those as chip counts and draws no exile'],
];

/**
 * Single tests inside a `PHONE_CORE` file that need a mouse, tagged `@mouse` in their own spec. A
 * project skip would read as a skipped test, which CI's gate refuses, so `phone-core` never runs them.
 */
const MOUSE_ONLY = /@mouse/;

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
      testIgnore: [...FIREFOX_SPECS.filter((spec) => !ALSO_CHROMIUM.includes(spec)), PHONE_SPEC],
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
    {
      name: 'phone',
      testMatch: PHONE_SPEC,
      use: {
        browserName: 'chromium',
        ...PHONE,
        launchOptions: { args: ['--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process'] },
      },
    },
    /**
     * A separate project, not folded into `phone`: `phone` is every LANE's own purpose-written moment
     * (`*.phone.spec.ts`), which must stay exactly that — a desktop spec accidentally matching its
     * glob would be silent and easy to miss. `phone-core` is the opposite case on purpose, an
     * EXPLICIT, named, reviewed list of existing desktop specs ported onto the same `PHONE` context —
     * so a reader of either project's `testMatch` sees what it is at a glance, and `PHONE_CORE`'s own
     * reds (tracked above) read as "this list, on this context" rather than "the phone project turned
     * red" in a scheduled run's summary.
     */
    {
      name: 'phone-core',
      testMatch: PHONE_CORE,
      testIgnore: PHONE_CORE_EXCLUDE.map(([file]) => file),
      grepInvert: MOUSE_ONLY,
      use: {
        browserName: 'chromium',
        ...PHONE,
        launchOptions: { args: ['--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process'] },
      },
    },
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
