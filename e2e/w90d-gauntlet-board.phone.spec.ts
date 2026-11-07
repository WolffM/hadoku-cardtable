/**
 * The Gauntlet's reveal and ban/pick board at 390×844 (the operator, on the gauntlet mode view:
 * *"gotta reorganize these cards so they fit better"*).
 *
 * Measured on the old `.gauntlet__board` (a fixed 1fr | 5fr | 1fr grid, the pool always five
 * across): at 390 both player columns were cut at the screen edges ("P1 e..", "P2 H."), and deck and
 * pilot names in the pool were cut to 6-8 characters. This proves, at 390×844:
 *
 *  - the page never scrolls sideways;
 *  - both player columns are entirely inside the viewport;
 *  - no pool tile's deck name or pilot is clipped (`scrollWidth` ≤ `clientWidth`);
 *  - the pool is 2 or 3 columns, not five squeezed ones;
 *  - the coin overlay still covers the pool exactly, during the reveal;
 *  - a ban and a pick are each still one tap, on the board a player presses.
 *
 * No Forge (see `w90d-gauntlet-board.spec.ts`'s own doc for why, and why the era is pinned).
 * `[w90d-gauntlet-board-phone]` lines are the evidence.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import type { GauntletView } from '../packages/shared/src/gauntlet.ts';
import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { coinOverPool, watchCoinOverPool } from './gauntletCoin.ts';
import { keepPrefsLocal } from './prefsLocal.ts';
import { noSideways, PHONE } from './play/phone.ts';

test.use(PHONE);

const ERA = 'modern-2012-07-13';

async function send<T>(request: APIRequestContext, method: 'GET' | 'POST', path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const res = method === 'GET' ? await request.get(`${EDGE_ORIGIN}${PREFIX}/api${path}`) : await request.post(`${EDGE_ORIGIN}${PREFIX}/api${path}`, { data: data ?? {} });
  return { status: res.status(), body: (await res.json()) as T };
}

async function poolTextFits(page: Page): Promise<{ id: string | null; part: string; fits: boolean; need: number; have: number }[]> {
  return page.evaluate(() => {
    const tiles = [...document.querySelectorAll<HTMLElement>('[data-testid="gauntlet-pool"] [data-testid="gauntlet-deck"]')];
    return tiles.flatMap((tile) =>
      (['deckpick__name', 'deckpick__pilot'] as const).flatMap((cls) => {
        const el = tile.querySelector<HTMLElement>(`.${cls}`);
        if (el === null) return [];
        return [{ id: tile.dataset.deckId ?? null, part: cls, fits: el.scrollWidth <= el.clientWidth, need: el.scrollWidth, have: el.clientWidth }];
      }),
    );
  });
}

/** Waits for this seat's turn to `act`, taps the first open deck in the pool (a REAL touch tap) and returns its id. */
async function tapOwnTurn(page: Page, act: 'Ban' | 'Pick'): Promise<string> {
  const banner = page.getByTestId('gauntlet-turn');
  await expect(banner).toHaveAttribute('data-you', 'true', { timeout: 20_000 });
  await expect(banner).toContainText(act);
  const open = page.getByTestId('gauntlet-pool').locator('[data-testid="gauntlet-deck"][data-status="open"]:enabled').first();
  const id = (await open.getAttribute('data-deck-id'))!;
  await open.tap();
  return id;
}

test.describe.configure({ mode: 'serial' });

test('the Gauntlet board at 390×844: no sideways scroll, both columns on screen, no pool name or pilot clipped, 2 or 3 pool columns, the coin covers the pool, a ban and a pick are each one tap', async ({ browser }) => {
  test.setTimeout(2 * 60_000);
  const context = await browser.newContext({ ...PHONE });
  await context.addCookies([{ name: SESSION_COOKIE, value: 'alice', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  const page = await context.newPage();
  await watchCoinOverPool(page);
  try {
    await page.goto(`${PREFIX}/`);
    const created = await send<{ id: string }>(context.request, 'POST', '/rooms', {
      name: `e2e w90d gauntlet board phone ${Date.now()}`,
      gameType: 'constructed-1v1',
      mode: 'gauntlet',
      modeOptions: { family: 'modern', era: ERA },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const roomId = created.body.id;
    // The room is open before the ready starts the reveal's clock, so this screen sees the coin.
    await page.goto(`${PREFIX}/#/room/${roomId}`);
    await expect(page.getByTestId('constructed')).toBeVisible({ timeout: 15_000 });
    expect((await send(context.request, 'POST', `/tables/rooms/${roomId}/sit`)).status).toBe(200);
    const ready = await send<GauntletView>(context.request, 'POST', `/tables/rooms/${roomId}/gauntlet/ready`, { ready: true, ai: true });
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect(ready.body.era?.id).toBe(ERA);
    console.log(`[w90d-gauntlet-board-phone] drew era=${ready.body.era?.title} first=${String(ready.body.first)} decks=${ready.body.decks.map((d) => d.id).join(',')}`);

    await expect(page.getByTestId('gauntlet-title')).toHaveText(ready.body.era!.title, { timeout: 15_000 });

    await noSideways(page);

    await expect.poll(() => coinOverPool(page), { timeout: 15_000, message: 'the coin was drawn' }).not.toBeNull();
    const coinBox = (await coinOverPool(page))!;
    console.log(`[w90d-gauntlet-board-phone] coin over pool: ${JSON.stringify(coinBox)}`);
    expect(coinBox.coin, 'the coin overlay is the pool’s own box').toEqual(coinBox.pool);
    await noSideways(page);

    await expect(page.getByTestId('gauntlet-pool').getByTestId('gauntlet-deck')).toHaveCount(10, { timeout: 15_000 });
    await expect(page.getByTestId('gauntlet')).not.toHaveAttribute('data-revealing', /.*/, { timeout: 15_000 });
    await noSideways(page);

    const cols = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      return [0, 1].map((seat) => {
        const r = document.querySelector(`[data-testid="gauntlet-column"][data-seat="${seat}"]`)!.getBoundingClientRect();
        return { seat, left: r.left, right: r.right, vw };
      });
    });
    console.log(`[w90d-gauntlet-board-phone] columns: ${JSON.stringify(cols)}`);
    for (const c of cols) {
      expect(c.left, `seat ${c.seat}'s column starts on screen`).toBeGreaterThanOrEqual(0);
      expect(c.right, `seat ${c.seat}'s column ends on screen`).toBeLessThanOrEqual(c.vw);
    }

    const fit = await poolTextFits(page);
    const clipped = fit.filter((f) => !f.fits);
    console.log(`[w90d-gauntlet-board-phone] pool text: ${fit.length} checked, clipped=${JSON.stringify(clipped)}`);
    expect(clipped, 'no pool deck name or pilot is clipped').toEqual([]);

    const poolCols = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="gauntlet-pool"]')!).gridTemplateColumns.split(' ').length);
    console.log(`[w90d-gauntlet-board-phone] pool columns at 390: ${poolCols}`);
    expect([2, 3], 'the pool is 2 or 3 columns, not five squeezed ones').toContain(poolCols);

    const banned = await tapOwnTurn(page, 'Ban');
    const bannedTile = page.locator(`[data-deck-id="${banned}"]`);
    await expect(bannedTile).toHaveAttribute('data-status', 'banned');
    await expect(bannedTile.getByTestId('gauntlet-cross')).toBeVisible();
    console.log(`[w90d-gauntlet-board-phone] banned ${banned} in one tap`);
    await noSideways(page);

    const picked = await tapOwnTurn(page, 'Pick');
    const view = await send<GauntletView>(context.request, 'GET', `/tables/rooms/${roomId}/gauntlet`);
    const column = page.locator(`[data-testid="gauntlet-column"][data-seat="${view.body.you}"]`);
    await expect(column.locator(`[data-deck-id="${picked}"]`), 'the pick is in its picker’s column').toHaveCount(1);
    console.log(`[w90d-gauntlet-board-phone] picked ${picked} in one tap`);

    await noSideways(page);
    const fit2 = await poolTextFits(page);
    expect(fit2.filter((f) => !f.fits), 'no pool deck name or pilot is clipped after acting').toEqual([]);
    const cols2 = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      return [0, 1].map((seat) => {
        const r = document.querySelector(`[data-testid="gauntlet-column"][data-seat="${seat}"]`)!.getBoundingClientRect();
        return r.left >= 0 && r.right <= vw;
      });
    });
    expect(cols2, 'both columns still on screen after acting').toEqual([true, true]);
  } finally {
    await context.close();
  }
});
