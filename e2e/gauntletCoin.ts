/**
 * The Gauntlet coin's box against the pool's, measured with the page's clock held inside the coin's
 * moment. The coin stands only from the title's landing to the first deal (`reveal.ts`, about 2.9 s of
 * the server's 6 s reveal clock, which starts at the ready), read from `Date.now() - revealAt`; a
 * screen that draws the reveal late joins it where it is and never draws the coin, as it should. So
 * the spec does not race that window on the runner's wall clock (a nightly at load missed it,
 * 2026-11-26): it fixes the page's time at a moment inside it, measures, and lets time run again.
 *
 * Order: `installRevealClock` before the page loads, `freezeForReady` just before the ready (so the
 * reveal cannot run past the coin while the ready travels), then `coinOverPool` with the ready's
 * `revealAt`.
 */
import { expect, type Page } from '@playwright/test';

import { GAUNTLET_REVEAL_MS } from '../packages/shared/src/gauntlet.ts';

export interface CoinOverPool {
  pool: { x: number; y: number; width: number; height: number };
  coin: { x: number; y: number; width: number; height: number };
}

/** A second past the title's landing (`reveal.ts`'s `TITLE_MS`, 15% of the reveal); the coin stands 2.9 s from there. */
const COIN_AT_MS = Math.round(GAUNTLET_REVEAL_MS * 0.15) + 1_000;

/** The page's clock under the spec's hand; time runs as usual until it is fixed. Before the page loads. */
export async function installRevealClock(page: Page): Promise<void> {
  await page.clock.install();
}

/**
 * The page's time stops just before the ready: whenever the ready's view arrives, the screen reads a
 * moment before the reveal began and waits on its title timer, which `coinOverPool` then lands inside
 * the coin.
 */
export async function freezeForReady(page: Page): Promise<void> {
  await page.clock.setFixedTime(Date.now());
}

/** The coin's and the pool's boxes, with the page held at the coin; the page's time runs again after. */
export async function coinOverPool(page: Page, revealAt: number): Promise<CoinOverPool> {
  await page.clock.setFixedTime(revealAt + COIN_AT_MS);
  try {
    let measured: CoinOverPool | null = null;
    await expect
      .poll(
        async () => {
          measured = await page.evaluate(() => {
            const box = (el: Element): CoinOverPool['pool'] => {
              const r = el.getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height };
            };
            const pool = document.querySelector('[data-testid="gauntlet-pool"]');
            const coin = document.querySelector('[data-testid="gauntlet"] .gauntlet__coin');
            if (pool === null || coin === null || document.querySelector('[data-testid="coin-toss"]') === null) return null;
            return { pool: box(pool), coin: box(coin) };
          });
          return measured !== null;
        },
        { timeout: 15_000, message: 'the coin is drawn while the page stands inside its moment' },
      )
      .toBe(true);
    return measured!;
  } finally {
    await page.clock.setSystemTime(Date.now());
  }
}
