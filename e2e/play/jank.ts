/**
 * The page's own long frames, for a timing spec that must tell a slow product from a busy machine.
 *
 * A timing claim judged by the page's clock (a decision opening on an effect's last tenth, the next of a
 * chain setting off after its gap) is late by however long the page's main thread was blocked when the
 * product's timer or frame was due: on a loaded claw that is tens of ms at a time (wresolve-chain, run
 * 42177519336; w80c-common-unlock, run 42204349837). A spec records the long frames Chromium reports and
 * excuses lateness by exactly the time they covered, and nothing more, so a product that is itself slow
 * still fails on a quiet page.
 */
import type { Page } from '@playwright/test';

/** Start recording `page`'s long animation frames (> 50 ms) from now on, as `[start, end]` on its `performance.now()` clock. */
export async function watchLongFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __longFrames: [number, number][] };
    w.__longFrames = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longFrames.push([e.startTime, e.startTime + e.duration]);
    }).observe({ type: 'long-animation-frame', buffered: false });
  });
}

/** What `watchLongFrames` recorded, on `page`'s `performance.now()` clock. */
export const longFrames = (page: Page): Promise<[number, number][]> =>
  page.evaluate(() => (window as unknown as { __longFrames: [number, number][] }).__longFrames);

/** The page's clock at the epoch: an epoch time `t` (a server log's, on the same host) is `t - origin` on it. */
export const timeOrigin = (page: Page): Promise<number> => page.evaluate(() => performance.timeOrigin);

/** How much of `[from, to]` the long frames covered, in ms. */
export const jankIn = (frames: readonly (readonly [number, number])[], from: number, to: number): number =>
  frames.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);
