/**
 * Clip: the Gauntlet. Ten decks of one era are revealed, the two seats ban and pick in a snake (the AI on
 * its own turns), the hero secretly chooses an opening deck, and game 1's board comes up.
 */
import { test, type Page } from '@playwright/test';

import { forgeAvailability, startPlayStack, type PlayStack } from '../play/harness.ts';
import { until } from './drive.ts';
import { HERO, openPromoFriend, startFilm } from './rig.ts';

const PREFIX = '/cardtable';

/** Hover the tile (its decklist opens beside it), rest, then press it. */
async function considerAndPress(page: Page, tile: ReturnType<Page['locator']>, restMs: number): Promise<void> {
  const box = await tile.boundingBox();
  if (box === null) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 16 });
  await page.waitForTimeout(restMs);
  // The deck's peek can open over its own tile near the board's edge; the cursor is not in the footage.
  await tile.evaluate((el) => (el as HTMLElement).click());
  await page.mouse.move(40, 540, { steps: 10 });
}

test('gauntlet: reveal, ban and pick, choose', async () => {
  const forge = forgeAvailability();
  if (!forge.ok) throw new Error(forge.reason);
  const film = await startFilm('gauntlet');
  let stack: PlayStack | undefined;
  try {
    stack = await startPlayStack(forge);
    const hero = await openPromoFriend(film.hero, HERO, { filmed: true });
    const page = hero.page;
    const made = await hero.context.request.post(`${stack.origin}${PREFIX}/api/rooms`, {
      data: { name: 'Modern Gauntlet', gameType: 'constructed-1v1', mode: 'gauntlet', modeOptions: { family: 'modern' }, clientMode: 'builtin' },
    });
    if (!made.ok()) throw new Error(`promo: POST /api/rooms ${made.status()} ${await made.text()}`);
    const roomId = ((await made.json()) as { id: string }).id;
    await page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
    await page.getByTestId('constructed').waitFor({ timeout: 30_000 });
    const api = `${stack.origin}${PREFIX}/api/tables/rooms/${roomId}`;
    if (!(await hero.context.request.post(`${api}/sit`, { data: {} })).ok()) throw new Error('promo: sit refused');
    await film.beat(1_500);
    await film.roll();
    film.mark('room');
    await film.beat(1_500);

    film.mark('ready');
    const ready = await hero.context.request.post(`${api}/gauntlet/ready`, { data: { ready: true, ai: true } });
    if (!ready.ok()) throw new Error(`promo: gauntlet ready ${await ready.text()}`);
    await page.getByTestId('gauntlet-pool').getByTestId('gauntlet-deck').nth(9).waitFor({ timeout: 30_000 });
    film.mark('revealed');
    await until('the deal has landed', async () => (await page.getByTestId('gauntlet').getAttribute('data-revealing')) === null, 30_000);
    await film.beat(1_500);

    // The snake: act on each of the hero's own turns until the choose screen opens.
    film.mark('snake');
    const banner = page.getByTestId('gauntlet-turn');
    let acts = 0;
    await until('the choose screen', async () => {
      if ((await page.getByTestId('gauntlet-choose-mine').count()) > 0) return true;
      if ((await banner.count()) === 0 || (await banner.getAttribute('data-you')) !== 'true') return false;
      const open = page.getByTestId('gauntlet-pool').locator('[data-testid="gauntlet-deck"][data-status="open"]:enabled');
      if ((await open.count()) === 0) return false;
      acts += 1;
      console.log(`[promo:gauntlet] act ${acts}: ${(await banner.textContent())?.trim()}`);
      await considerAndPress(page, open.nth(acts % Math.max(1, await open.count())), acts <= 2 ? 1_600 : 700);
      return false;
    }, 120_000, 300);
    film.mark('choose');
    await film.beat(1_800);
    const mine = page.getByTestId('gauntlet-choose-mine').locator('[data-testid="gauntlet-deck"]:not([data-played])').first();
    await considerAndPress(page, mine, 1_500);
    await page.locator('[aria-label="Game board"]').waitFor({ timeout: 60_000 });
    film.mark('board');
    await film.beat(4_000);
    film.mark('end');
  } finally {
    await film.stop();
    await stack?.stop();
  }
});
