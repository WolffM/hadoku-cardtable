/**
 * The Gauntlet coin's box against the pool's, measured on the first frame the coin is drawn. The coin
 * stands only from the title's landing to the first deal (`reveal.ts`, about 2.9 s of the server's
 * 6 s reveal clock, which starts at the ready), so a check that polls for it after a page load
 * misses it on a loaded host. Install before the page loads; open the room, then ready.
 */
import type { Page } from '@playwright/test';

export interface CoinOverPool {
  pool: { x: number; y: number; width: number; height: number };
  coin: { x: number; y: number; width: number; height: number };
}

export async function watchCoinOverPool(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { coinOverPool?: CoinOverPool };
    const box = (el: Element): CoinOverPool['pool'] => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const frame = (): void => {
      const pool = document.querySelector('[data-testid="gauntlet-pool"]');
      const coin = document.querySelector('[data-testid="gauntlet"] .gauntlet__coin');
      if (pool !== null && coin !== null && document.querySelector('[data-testid="coin-toss"]') !== null) {
        w.coinOverPool = { pool: box(pool), coin: box(coin) };
        return;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/** What `watchCoinOverPool` measured, or null when the coin was never drawn. */
export async function coinOverPool(page: Page): Promise<CoinOverPool | null> {
  return page.evaluate(() => (window as unknown as { coinOverPool?: CoinOverPool }).coinOverPool ?? null);
}
