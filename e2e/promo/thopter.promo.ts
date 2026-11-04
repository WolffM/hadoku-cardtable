/**
 * Clip: the Thopter Foundry engine (cut 5's combo section). Thopter Foundry sacrifices Sword of the Meek for a
 * 1/1 Thopter and a life; the Thopter entering brings the Sword back from the graveyard onto it; and again,
 * once per mana, one continuous take with every click shown. The operator (cut 5): "this can be clicked
 * faster", so after the first loop the hand knows the way: quick moves, short rests, a brisk pick. `promo-thopter-sword.state` has the board.
 */
import { test, type Page } from '@playwright/test';

import { clickPermanent, ownNamed, pressPaymentAuto, stackCount } from '../play/board.ts';
import { answerPrompt } from '../play/prompts.ts';
import { autoYield, humanMove, humanRest, lifeOf, okEnabled, pickTiles, pressIfThere, restCursor, selectionTiles, shootScenario, until, wrap, type Shoot } from './drive.ts';

const LOOPS = 6;

/** The hero's life: each loop gains exactly one, so it counts loops (the token's name and the attached Sword read unreliably). */
const life = async (page: Page): Promise<number> => Number((await lifeOf(page, 'mine').textContent()) ?? '0');

/** Rest on the Foundry, press it, sacrifice the Sword, pay, and let it all resolve: one more Thopter, the Sword back. */
async function loop(page: Page, n: number): Promise<void> {
  const before = await life(page);
  const [foundry] = await ownNamed(page, 'Thopter Foundry');
  if (foundry === undefined) throw new Error('promo: no Thopter Foundry');
  const box = await page.locator(`[data-board-card="${foundry}"]`).boundingBox();
  if (box !== null) await humanMove(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, n === 0 ? 1 : 0.6);
  await humanRest(page, n === 0 ? 700 : 120);
  if (!(await clickPermanent(page, foundry))) throw new Error('promo: Thopter Foundry is not offered');
  await until(`loop ${n + 1}: a Thopter and the Sword back`, async () => {
    const tiles = await selectionTiles(page);
    if (tiles.length > 0) {
      const sword = tiles.filter((t) => /Sword of the Meek/.test(t.text));
      await pickTiles(page, (sword.length > 0 ? sword : tiles.slice(0, 1)).map((t) => t.id), 80, n === 0 ? 300 : 120);
      return false;
    }
    // The Sword's "you may return it" is a yes; any other ask takes its default.
    if (await pressIfThere(page.locator('[data-testid="prompt-confirm-yes"]:enabled'))) return false;
    await answerPrompt(page).catch(() => null);
    await pressPaymentAuto(page);
    if ((await stackCount(page)) > 0) await pressIfThere(okEnabled(page));
    return (await life(page)) > before && (await stackCount(page)) === 0 && (await page.getByTestId('live-prompt').count()) === 0;
  }, 45_000, 80, page);
}

test('thopter: Foundry and Sword of the Meek, six times round', async ({ browser }) => {
  let shoot: Shoot | undefined;
  try {
    shoot = await shootScenario(browser, 'thopter', 'promo-thopter-sword');
    const { film, hero, rival } = shoot;
    const page = hero.page;
    await autoYield(rival.page);
    await restCursor(page);
    film.mark('board');
    await film.beat(1_800);
    for (let n = 0; n < LOOPS; n++) {
      film.mark(`loop-${n + 1}`);
      await loop(page, n);
    }
    await restCursor(page);
    film.mark('done');
    await film.beat(3_500);
    film.mark('end');
  } finally {
    await wrap(shoot ?? {});
  }
});
