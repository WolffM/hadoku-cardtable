/**
 * The room's deck grid on a year or format switch: the old decks crossfade straight into the new
 * ones, and nothing goes dark in between.
 *
 * The operator, 2026-11-02, on the promo film: *"when a new year is selected, there's a brief flash
 * where all cards turn to black twice"*. The frames showed the old tiles fading to dark, then a
 * screen of empty outlines for ~250 ms, then the new art popping in tile by tile.
 *
 * Every frame of a switch is sampled (`requestAnimationFrame`). A frame is DARK when the grid draws
 * an outline, or when any box of the grid's first row has no tile in it showing decoded art at full
 * strength: the art `<img>` and every element between it and the grid at opacity ≥ 0.9. Two tiles
 * stacked in one box (the old over the new, mid-crossfade) light it if either does. Card art comes
 * from a route that answers every art host with a drawn face after an uneven delay, so the new
 * list's art is genuinely not there when the switch is made. Three switches, each to the year
 * beside the last, and one back to a year already seen; `[wflash]` lines are the evidence.
 *
 * And the old grid is not held long. The operator, 2026-11-01, on the first film: *"when going to
 * the 3rd year the old images stick for a few seconds before actually swapping to the next set"*.
 * The years beside the one shown warm while the grid is idle (`deckNeighbours.ts`), so after a
 * pause each switch here crosses within {@link HOLD_MS} of the old grid first being held.
 */

import { expect, test, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { createRoom } from './play/board.ts';
import { keepPrefsLocal } from './prefsLocal.ts';
import { choosePool, poolEras, poolValue } from './play/pool.ts';
import { isArtRequest } from './art.ts';

/** The longest a switch to a warmed list may hold the old grid. */
const HOLD_MS = 400;


/** A stand-in card face, drawn rather than shipped: no image bytes enter the repo. */
function face(url: string): string {
  const hue = [...url].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="hsl(${hue} 60% 55%)"/></svg>`;
}

type Watch = { on: boolean; frames: number; dark: string[]; heldAt: number | null; crossedAt: number | null };
const begin = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const w = (window as unknown as { __flash: Watch }).__flash;
    w.on = true;
    w.frames = 0;
    w.dark = [];
    w.heldAt = null;
    w.crossedAt = null;
  });
const end = (page: Page): Promise<Watch> =>
  page.evaluate(() => {
    const w = (window as unknown as { __flash: Watch }).__flash;
    w.on = false;
    return { ...w, dark: [...w.dark] };
  });

test('a year switch crossfades the old decks straight into the new, with no dark frame between', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: 'alice', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  let n = 0;
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!isArtRequest(url)) return url.hostname === '127.0.0.1' ? route.continue() : route.abort('blockedbyclient');
    await new Promise((r) => setTimeout(r, 300 + ((n++ * 337) % 1500)));
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: face(url.href) }).catch(() => undefined);
  });
  await context.addInitScript(() => {
    const w = { on: false, frames: 0, dark: [] as string[], heldAt: null as number | null, crossedAt: null as number | null };
    (window as unknown as { __flash: typeof w }).__flash = w;
    const strength = (el: Element, grid: Element): number => {
      let o = 1;
      for (let at: Element | null = el; at !== null && at !== grid; at = at.parentElement) o *= Number(getComputedStyle(at).opacity);
      return o;
    };
    const tick = (): void => {
      const grid = document.querySelector('[data-testid="deck-mine"]');
      if (w.on && grid !== null) {
        w.frames++;
        const why: string[] = [];
        if (grid.querySelector('.skeleton') !== null) why.push('outlines');
        // The old grid first held, then the first frame the new list's tiles are drawn.
        if (w.heldAt === null && grid.querySelector('.deckpick__option--leaving') !== null) w.heldAt = performance.now();
        else if (w.heldAt !== null && w.crossedAt === null && grid.querySelector('[data-testid="deck-option"]') !== null) w.crossedAt = performance.now();
        const top = grid.getBoundingClientRect().top;
        const boxes = new Map<number, boolean>();
        for (const tile of grid.querySelectorAll('.deckpick__option')) {
          const r = tile.getBoundingClientRect();
          if (Math.abs(r.top - top) > 2) continue;
          const img = tile.querySelector<HTMLImageElement>('.deckpick__art img');
          const lit = img !== null && img.complete && img.naturalWidth > 0 && strength(img, grid) >= 0.9;
          const col = Math.round(r.left);
          boxes.set(col, (boxes.get(col) ?? false) || lit);
        }
        if (boxes.size === 0) why.push('no tiles');
        const unlit = [...boxes.values()].filter((lit) => !lit).length;
        if (unlit > 0) why.push(`${unlit}/${boxes.size} boxes dark`);
        if (why.length > 0 && w.dark.length < 40) w.dark.push(`frame ${w.frames}: ${why.join(', ')}`);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const page = await context.newPage();
  await page.goto(`${PREFIX}/`);
  await expect(page.getByTestId('room-create-open')).toBeVisible();
  await createRoom({ page }, `wflash grid ${Date.now()}`);

  const picker = page.getByTestId('deck-mine');
  const tiles = picker.getByTestId('deck-option');
  await expect.poll(() => tiles.count(), { timeout: 30_000 }).toBeGreaterThan(6);
  await expect(picker.locator('.deckpick__option--leaving, .skeleton')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(2_500);

  const eras = await poolEras(page);
  const current = await poolValue(page);
  // Each switch to the year beside the last (the slider lays them out oldest first, so a room on the
  // newest steps back through the three before it).
  const at = eras.indexOf(current);
  const order = at + 3 < eras.length ? eras.slice(at + 1, at + 4) : eras.slice(Math.max(0, at - 3), at).reverse();
  expect(order.length, 'three years in a row to step through').toBe(3);

  for (const era of [...order, current]) {
    // Idle long enough for the years beside this one to warm.
    await page.waitForTimeout(3_000);
    await begin(page);
    await choosePool(page, era);
    await expect.poll(() => tiles.count(), { timeout: 30_000 }).toBeGreaterThan(6);
    await expect(picker.locator('.deckpick__option--leaving, .skeleton')).toHaveCount(0, { timeout: 15_000 });
    // Past every animation, so a late fade-in on the new tiles is sampled too.
    await page.waitForTimeout(800);
    const watch = await end(page);
    const held = watch.heldAt === null || watch.crossedAt === null ? null : Math.round(watch.crossedAt - watch.heldAt);
    console.log(`[wflash] ${era}: ${watch.frames} frames, old grid held ${held ?? '?'} ms, ${watch.dark.length} dark${watch.dark.length > 0 ? ` — ${watch.dark.slice(0, 6).join(' | ')}` : ''}`);
    expect(watch.frames, `${era}: the sampler saw the switch`).toBeGreaterThan(10);
    expect.soft(watch.dark, `${era}: no frame went dark or to outlines`).toEqual([]);
    expect.soft(held, `${era}: the old grid crossed into the new within ${HOLD_MS} ms`).not.toBeNull();
    expect.soft(held ?? Infinity, `${era}: the old grid crossed into the new within ${HOLD_MS} ms`).toBeLessThanOrEqual(HOLD_MS);
  }
  await context.close();
});
