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
 * list's art is genuinely not there when the switch is made. Three cold switches and one back to a
 * year already seen; `[wflash]` lines are the evidence.
 */

import { expect, test, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { createRoom } from './play/board.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

const ART_HOSTS = new Set(['cdn.hadoku.me', 'cards.scryfall.io']);

/** A stand-in card face, drawn rather than shipped: no image bytes enter the repo. */
function face(url: string): string {
  const hue = [...url].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="hsl(${hue} 60% 55%)"/></svg>`;
}

type Watch = { on: boolean; frames: number; dark: string[] };
const begin = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const w = (window as unknown as { __flash: Watch }).__flash;
    w.on = true;
    w.frames = 0;
    w.dark = [];
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
    if (url.hostname === '127.0.0.1') return route.continue();
    if (!ART_HOSTS.has(url.hostname)) return route.abort('blockedbyclient');
    await new Promise((r) => setTimeout(r, 300 + ((n++ * 337) % 1500)));
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: face(url.href) }).catch(() => undefined);
  });
  await context.addInitScript(() => {
    const w = { on: false, frames: 0, dark: [] as string[] };
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
  await createRoom({ context, page }, `wflash grid ${Date.now()}`);

  const picker = page.getByTestId('deck-mine');
  const tiles = picker.getByTestId('deck-option');
  await expect.poll(() => tiles.count(), { timeout: 30_000 }).toBeGreaterThan(6);
  await expect(picker.locator('.deckpick__option--leaving, .skeleton')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(2_500);

  const select = page.getByTestId('format');
  const eras = (await select.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).filter((v) => v !== '');
  const current = await select.inputValue();
  const order = eras.filter((e) => e !== current).slice(0, 3);
  expect(order.length, 'three other years to switch to').toBe(3);

  for (const era of [...order, current]) {
    await begin(page);
    await select.selectOption(era);
    await expect(select).toHaveValue(era);
    await expect.poll(() => tiles.count(), { timeout: 30_000 }).toBeGreaterThan(6);
    await expect(picker.locator('.deckpick__option--leaving, .skeleton')).toHaveCount(0, { timeout: 15_000 });
    // Past every animation, so a late fade-in on the new tiles is sampled too.
    await page.waitForTimeout(800);
    const watch = await end(page);
    console.log(`[wflash] ${era}: ${watch.frames} frames, ${watch.dark.length} dark${watch.dark.length > 0 ? ` — ${watch.dark.slice(0, 6).join(' | ')}` : ''}`);
    expect(watch.frames, `${era}: the sampler saw the switch`).toBeGreaterThan(10);
    expect.soft(watch.dark, `${era}: no frame went dark or to outlines`).toEqual([]);
  }
  await context.close();
});
