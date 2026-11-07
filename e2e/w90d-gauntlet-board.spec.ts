/**
 * The Gauntlet's reveal and ban/pick board, reorganised so the pool gets the width (the operator,
 * on the gauntlet mode view: *"gotta reorganize these cards so they fit better"*).
 *
 * Measured on the old `.gauntlet__board` (a fixed 1fr | 5fr | 1fr grid, the pool always five
 * across): at 1440×900 the side columns took 2/7 of the width for three empty slots, and the
 * pool's names were cut ("Scap…", "B…", "Red …"). This proves, at 1440×900:
 *
 *  - both player columns are entirely inside the viewport;
 *  - no pool tile's deck name or pilot is clipped (`scrollWidth` ≤ `clientWidth`);
 *  - the coin overlay still covers the pool exactly, during the reveal;
 *  - a ban and a pick are each still one click, on the board a player presses.
 *
 * No Forge: `drawGauntlet`/`act` are pure server-side logic (`apps/server/src/room/gauntlet.ts`),
 * and the AI's own bans and picks run off a server timer, not a match. The era is pinned
 * (`modern-2012-07-13`) to a pool whose longest archetype name is 13 characters and longest
 * pilot 17 — representative deck text, not the single worst case the 15-era modern library can deal
 * (`decks/modern-*`'s own longest, "Crashing Footfalls Cascade", would need a tile wider than a
 * phone screen to ever not ellipsis, same as a long name already does in the room's own picker).
 *
 * `[w90d-gauntlet-board]` lines are the evidence.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import type { GauntletView } from '../packages/shared/src/gauntlet.ts';
import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { coinOverPool, watchCoinOverPool } from './gauntletCoin.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

const ERA = 'modern-2012-07-13';

async function send<T>(request: APIRequestContext, method: 'GET' | 'POST', path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const res = method === 'GET' ? await request.get(`${EDGE_ORIGIN}${PREFIX}/api${path}`) : await request.post(`${EDGE_ORIGIN}${PREFIX}/api${path}`, { data: data ?? {} });
  return { status: res.status(), body: (await res.json()) as T };
}

/** Every pool tile's name and pilot: `false` when a box held less than its own text needed. */
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

/** Waits for this seat's turn to `act`, presses the first open deck in the pool and returns its id. */
async function actOnOwnTurn(page: Page, act: 'Ban' | 'Pick'): Promise<string> {
  const banner = page.getByTestId('gauntlet-turn');
  await expect(banner).toHaveAttribute('data-you', 'true', { timeout: 20_000 });
  await expect(banner).toContainText(act);
  const open = page.getByTestId('gauntlet-pool').locator('[data-testid="gauntlet-deck"][data-status="open"]:enabled').first();
  const id = (await open.getAttribute('data-deck-id'))!;
  await open.click();
  return id;
}

test.describe.configure({ mode: 'serial' });

test('the Gauntlet board at 1440×900: both columns on screen, no pool name or pilot clipped, the coin covers the pool, a ban and a pick are each one click', async ({ browser }) => {
  test.setTimeout(2 * 60_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: 'alice', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  const page = await context.newPage();
  await watchCoinOverPool(page);
  try {
    await page.goto(`${PREFIX}/`);
    const created = await send<{ id: string }>(context.request, 'POST', '/rooms', {
      name: `e2e w90d gauntlet board ${Date.now()}`,
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
    expect(ready.body.decks).toHaveLength(10);
    console.log(`[w90d-gauntlet-board] drew era=${ready.body.era?.title} first=${String(ready.body.first)} decks=${ready.body.decks.map((d) => d.id).join(',')}`);

    await expect(page.getByTestId('gauntlet-title')).toHaveText(ready.body.era!.title, { timeout: 15_000 });

    // The coin, while it is up, covers the pool exactly — the redesign must not have broken its `inset: 0`.
    await expect.poll(() => coinOverPool(page), { timeout: 15_000, message: 'the coin was drawn' }).not.toBeNull();
    const coinBox = (await coinOverPool(page))!;
    console.log(`[w90d-gauntlet-board] coin over pool: ${JSON.stringify(coinBox)}`);
    expect(coinBox.coin, 'the coin overlay is the pool’s own box').toEqual(coinBox.pool);

    await expect(page.getByTestId('gauntlet-pool').getByTestId('gauntlet-deck')).toHaveCount(10, { timeout: 15_000 });
    await expect(page.getByTestId('gauntlet')).not.toHaveAttribute('data-revealing', /.*/, { timeout: 15_000 });

    // Both columns entirely inside the viewport — the old grid ran P2's column off the right edge.
    const cols = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      return [0, 1].map((seat) => {
        const el = document.querySelector<HTMLElement>(`[data-testid="gauntlet-column"][data-seat="${seat}"]`)!;
        const r = el.getBoundingClientRect();
        return { seat, left: r.left, right: r.right, vw };
      });
    });
    console.log(`[w90d-gauntlet-board] columns: ${JSON.stringify(cols)}`);
    for (const c of cols) {
      expect(c.left, `seat ${c.seat}'s column starts on screen`).toBeGreaterThanOrEqual(0);
      expect(c.right, `seat ${c.seat}'s column ends on screen`).toBeLessThanOrEqual(c.vw);
    }

    // No pool tile's name or pilot is clipped.
    const fit = await poolTextFits(page);
    const clipped = fit.filter((f) => !f.fits);
    console.log(`[w90d-gauntlet-board] pool text: ${fit.length} checked, clipped=${JSON.stringify(clipped)}`);
    expect(clipped, 'no pool deck name or pilot is clipped').toEqual([]);

    // The pool's columns follow the width (`auto-fill`, never a fixed five): more than one, and
    // none narrower than the floor the room's own deck chooser uses (190px, `screens.css`'s `.deckpick`).
    const poolTracks = await page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-testid="gauntlet-pool"]')!)
        .gridTemplateColumns.split(' ')
        .map((px) => Number.parseFloat(px)),
    );
    console.log(`[w90d-gauntlet-board] pool column tracks at 1440: ${JSON.stringify(poolTracks)}`);
    expect(poolTracks.length, 'the pool is more than one column wide').toBeGreaterThan(1);
    for (const track of poolTracks) expect(track, 'no pool column is narrower than the floor').toBeGreaterThanOrEqual(189);

    // A ban is one click.
    const banned = await actOnOwnTurn(page, 'Ban');
    const bannedTile = page.locator(`[data-deck-id="${banned}"]`);
    await expect(bannedTile).toHaveAttribute('data-status', 'banned');
    await expect(bannedTile.getByTestId('gauntlet-cross')).toBeVisible();
    console.log(`[w90d-gauntlet-board] banned ${banned} in one click`);

    // A pick is one click, and lands in the picker's own column.
    const picked = await actOnOwnTurn(page, 'Pick');
    const view = await send<GauntletView>(context.request, 'GET', `/tables/rooms/${roomId}/gauntlet`);
    const column = page.locator(`[data-testid="gauntlet-column"][data-seat="${view.body.you}"]`);
    await expect(column.locator(`[data-deck-id="${picked}"]`), 'the pick is in its picker’s column').toHaveCount(1);
    console.log(`[w90d-gauntlet-board] picked ${picked} in one click`);

    // Still no clipping, and both columns still on screen, once a pick and a ban have reshuffled the board.
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
