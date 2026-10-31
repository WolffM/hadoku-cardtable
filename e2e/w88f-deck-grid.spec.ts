/**
 * The room's deck grid across an era switch, in a real browser against the real built server.
 *
 * The operator, 2026-10-30: *"30 years of real tournament decks: while flipping through the decks
 * they sort of pop into existence. can we make this loading animation better? how do we smoothen the
 * switching between each list?"* The rule it answers to (`preload-both-decks-art`): never draw a face
 * before its art decodes.
 *
 * Card art is served here by a route that answers every art host with a drawn SVG after a delay, so a
 * tile that paints its `<img>` before the bytes land is visible to the sampler — a frame-by-frame
 * `requestAnimationFrame` scan of every painted art `<img>` in the grid. Three era flips, then a deck
 * is chosen off the new grid: the grid is a working control once the switch has settled.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { createRoom } from './play/board.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

/** Hosts card art may come from (CLAUDE.md, D15; unrestricted since D18). */
const ART_HOSTS = new Set(['cdn.hadoku.me', 'cards.scryfall.io']);

/** A stand-in card face, drawn rather than shipped: no image bytes enter the repo. */
function face(url: string): string {
  const hue = [...url].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="hsl(${hue} 50% 40%)"/></svg>`;
}

async function open(browser: Browser, name: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  let n = 0;
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (!ART_HOSTS.has(url.hostname)) return route.abort('blockedbyclient');
    // Slow, and unevenly so: some faces land well after the grid has its list.
    await new Promise((r) => setTimeout(r, 150 + ((n++ * 137) % 900)));
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: face(url.href) }).catch(() => undefined);
  });
  // Every frame: any art <img> in the grid that is painted while it has no decoded image is a violation.
  await context.addInitScript(() => {
    const seen = { frames: 0, paintedArt: 0, leaving: 0, violations: [] as string[] };
    (window as unknown as { __deckGrid: typeof seen }).__deckGrid = seen;
    const tick = (): void => {
      seen.frames++;
      const grid = document.querySelector('[data-testid="deck-mine"]');
      if (grid !== null) {
        if (grid.querySelector('.deckpick__option--leaving') !== null) seen.leaving++;
        for (const img of grid.querySelectorAll<HTMLImageElement>('.deckpick__art img')) {
          if (!img.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
          if (img.complete && img.naturalWidth > 0) seen.paintedArt++;
          else if (seen.violations.length < 20) seen.violations.push(`${img.closest('[data-deck-id]')?.getAttribute('data-deck-id') ?? '?'} ${img.src}`);
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return { context, page: await context.newPage() };
}

type Seen = { frames: number; paintedArt: number; leaving: number; violations: string[] };
const seen = (page: Page): Promise<Seen> => page.evaluate(() => (window as unknown as { __deckGrid: Seen }).__deckGrid);

test('flipping eras: the old grid fades, no face paints before its art, and the grid works afterwards', async ({ browser }) => {
  const alice = await open(browser, 'alice');
  const page = alice.page;
  await page.goto(`${PREFIX}/`);
  await expect(page.getByTestId('room-create-open')).toBeVisible();
  await createRoom(alice, `w88f grid ${Date.now()}`);

  const picker = page.getByTestId('deck-mine');
  const tiles = picker.getByTestId('deck-option');
  await expect.poll(() => tiles.count(), { timeout: 30_000 }).toBeGreaterThan(0);

  const select = page.getByTestId('format');
  const eras = (await select.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).filter((v) => v !== '');
  const current = await select.inputValue();
  const flips = eras.filter((e) => e !== current).slice(0, 3);
  expect(flips.length, 'three other eras to flip through').toBe(3);

  for (const era of flips) {
    const before = (await seen(page)).leaving;
    await select.selectOption(era);
    await expect(select).toHaveValue(era);
    // The new era's decks, and only those: every tile left over from the last era has gone.
    await expect.poll(() => tiles.count(), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(picker.locator('.deckpick__option--leaving')).toHaveCount(0, { timeout: 10_000 });
    expect.soft((await seen(page)).leaving, `${era}: the old grid was drawn leaving, not dropped`).toBeGreaterThan(before);
    await page.waitForTimeout(1_500);
  }

  const after = await seen(page);
  console.log(`[w88f] ${after.frames} frames sampled, ${after.paintedArt} painted art samples, ${after.violations.length} undecoded`);
  expect(after.paintedArt, 'art was painted at all (a sampler that saw none proves nothing)').toBeGreaterThan(0);
  expect.soft(after.violations, 'no tile painted art before it decoded').toEqual([]);

  // Interactive: a deck off the final grid is chosen, and Ready comes alive for it.
  const first = tiles.first();
  await first.click();
  await expect(first).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('ready-toggle')).toBeEnabled();
  await alice.context.close();
});
