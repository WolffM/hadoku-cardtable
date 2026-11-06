/**
 * The draft opens without a frozen frame. Filmed on main (trailer clip "draft"), the pod's first frame
 * took 1,006 ms: `SeatBar` searched every seat's pile room (`pack-queue.ts`'s `pileRoom`, ~600 ms of
 * arithmetic for a pod of eight) inside the render that first draws the pod. The search now runs a
 * slice per task after that frame (`pileSearch`, `SeatBar`'s `usePiles`), and no task from the swap
 * to the piles drawn may be long.
 *
 * Measured on the REAL screen (`apps/ui/src/fit/draft-load.html` mounts `DraftScreen` for a pod of
 * eight, with packs waiting), BUILT for production with the app's own Vite config — a dev server's
 * React is several times slower and would measure a frame no player draws — by the main thread's own
 * tasks timed on its CPU clock (`mainThreadTasks`), with Chromium's long-animation-frame entries (every
 * frame over 50 ms, its length and the script that ran in it) as evidence. A task over 100 ms of CPU on
 * the reference host is red; on a slower machine the limit scales with its measured CPU speed
 * (`cpu-speed.ts`), on the same clock. The draft screen's own first render
 * is one task of ~30 ms on hokon; main's (the search in it) was 550 ms and more.
 *
 * Built for production whatever ran first in the worker (a dev server sets NODE_ENV for its whole
 * process), and checked to be (`fit-pages.ts`).
 *
 * Not the wall: a CI runner shares its cores, and that one task read 168–348 ms on the wall across five
 * claw runs whatever the runner's measured speed (the frame and the speed sample do not see the same
 * load). Its CPU time is what the product spent.
 *
 * Needs no server: it only reads the screen. No Forge, never skipped. `[wperf3]` lines are the evidence.
 */
import { expect, test } from '@playwright/test';

import { cpuFactor, mainThreadTasks } from './cpu-speed.ts';
import { buildFitPage, type FitPages } from './fit-pages.ts';

/** The longest main-thread task allowed from the swap to the piles drawn, in CPU ms on the reference host. */
const LONGEST_MS = 100;

declare global {
  interface Window {
    /** The fit page's swap from the skeleton to the draft (`fit/draft-load.tsx`). */
    load: () => void;
    longFrames: { ms: number; scripts: { invoker: string; ms: number }[] }[];
  }
}

test.use({ viewport: { width: 1280, height: 800 } });

let fit: FitPages | null = null;
let base = '';

test.beforeAll(async () => {
  test.setTimeout(120_000);
  // Production and checked, whatever ran before in this worker (`fit-pages.ts`).
  fit = await buildFitPage('draft-load');
  base = fit.base;
});

test.afterAll(async () => {
  await fit?.close();
});

test('the draft opens with no long frame: the pod is drawn first, its piles searched a slice at a time', async ({ page }) => {
  // Every seat with packs waiting, so every seat's pile is searched and drawn.
  const queue = [1, 2, 3, 1, 2, 3, 1, 2];
  await page.goto(`${base}src/fit/draft-load.html?q=${queue.join(',')}`);
  await expect(page.locator('[data-testid="pod-waiting"]')).toBeVisible();
  // Let the skeleton settle as it would on a slow socket.
  await page.waitForTimeout(500);
  const { factor, workloadMs } = await cpuFactor(page);
  const limit = Math.round(LONGEST_MS * factor);
  await page.evaluate(() => {
    window.longFrames = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { scripts: (PerformanceEntry & { invoker: string })[] })[]) {
        window.longFrames.push({ ms: Math.round(e.duration), scripts: e.scripts.map((s) => ({ invoker: s.invoker, ms: Math.round(s.duration) })) });
      }
    }).observe({ type: 'long-animation-frame', buffered: false });
  });
  const stop = await mainThreadTasks(page);
  const swapped = Date.now();
  await page.evaluate(() => window.load());
  await expect(page.getByTestId('draft-screen')).toBeVisible();
  await expect(page.locator('.packq__pack[data-testid]'), 'every waiting pack is drawn').toHaveCount(queue.reduce((a, b) => a + b, 0), { timeout: 15_000 });
  const drawn = Date.now() - swapped;
  // The frame the last pile lands in is reported once it ends.
  await page.waitForTimeout(500);
  const tasks = await stop();
  const frames = await page.evaluate(() => window.longFrames);
  const longest = tasks.reduce<(typeof tasks)[number] | null>((a, t) => (a === null || t.cpuMs > a.cpuMs ? t : a), null);
  if (longest === null) throw new Error('the trace has no task from the swap to the piles drawn');
  const parts = Object.entries(longest.parts).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ');
  const tasksOver = tasks.filter((t) => t.wallMs > 50).map((t) => ({ cpu: Math.round(t.cpuMs), wall: Math.round(t.wallMs) }));
  console.log(
    `[wperf3] draft open: cpu workload ${workloadMs.toFixed(1)} ms (×${factor.toFixed(2)} the reference), limit ${limit} ms; longest task ${longest.cpuMs.toFixed(1)} ms cpu (${longest.wallMs.toFixed(1)} ms wall: ${parts}); piles drawn ${drawn} ms after the swap; ` +
      `tasks over 50 ms wall: ${JSON.stringify(tasksOver)}; frames over 50 ms: ${JSON.stringify(frames)}`,
  );
  expect(longest.cpuMs, `the longest main-thread task from the swap to the piles drawn, in CPU ms (${JSON.stringify(tasksOver)})`).toBeLessThanOrEqual(limit);
});
