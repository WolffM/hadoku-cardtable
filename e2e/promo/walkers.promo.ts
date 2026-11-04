/**
 * Clip: three planeswalker moments in one main phase. Oko turns the rival's Tarmogoyf into an Elk, Jace,
 * the Mind Sculptor Brainstorms, and Elspeth, Knight-Errant ultimates for her emblem.
 * `promo-walkers.state` has the board.
 */
import { test, type Page } from '@playwright/test';

import { clickPermanent, ownNamed, stackCount } from '../play/board.ts';
import type { Film } from './rig.ts';
import { autoYield, deliberateClick, humanMove, humanRest, okEnabled, pickTiles, pressIfThere, resolveStack, restCursor, selectionTiles, shootScenario, theirCard, until, wrap, type Shoot } from './drive.ts';

/** Rest on the walker, press it, and pick the loyalty ability whose words match `ability`. */
async function activate(page: Page, film: Film, walker: string, ability: RegExp, label: string): Promise<void> {
  const [id] = await ownNamed(page, walker);
  if (id === undefined) throw new Error(`promo: no ${walker}`);
  const box = await page.locator(`[data-board-card="${id}"]`).boundingBox();
  if (box !== null) await humanMove(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await humanRest(page, 700);
  if (!(await clickPermanent(page, id))) throw new Error(`promo: ${walker} is not offered`);
  const choice = page.locator('section[data-prompt="getAbilityToPlay"] [data-testid="prompt-choice"]').filter({ hasText: ability });
  await choice.first().waitFor({ timeout: 15_000 });
  await humanRest(page, 500);
  film.mark(label);
  await deliberateClick(page, choice.first(), { hover: 400 });
}

test('walkers: an Elk, a Brainstorm, an emblem', async ({ browser }) => {
  let shoot: Shoot | undefined;
  try {
    shoot = await shootScenario(browser, 'walkers', 'promo-walkers');
    const { film, hero, rival } = shoot;
    const page = hero.page;
    await autoYield(rival.page);
    film.mark('board');
    await film.beat(1_500);

    await activate(page, film, 'Oko, Thief of Crowns', /Elk/, 'oko');
    await until('Oko asks for a target', async () => (await theirCard(page, 'Tarmogoyf').getAttribute('data-selectable')) !== null, 20_000, 150, page);
    await deliberateClick(page, theirCard(page, 'Tarmogoyf').locator('button').first(), { hover: 500 });
    await restCursor(page);
    await resolveStack(page, 'the Elk');
    film.mark('elk');
    await film.beat(1_800);

    await activate(page, film, 'Jace, the Mind Sculptor', /Draw three/i, 'jace');
    let putBack = false;
    await until('Brainstorm puts two back', async () => {
      const tiles = await selectionTiles(page);
      if (tiles.length > 0) {
        await pickTiles(page, tiles.slice(0, 2).map((t) => t.id), 450);
        putBack = true;
        return false;
      }
      if ((await stackCount(page)) > 0) await pressIfThere(okEnabled(page));
      return putBack && (await stackCount(page)) === 0;
    }, 60_000, 300, page);
    film.mark('brainstormed');
    await film.beat(1_500);

    await activate(page, film, 'Elspeth, Knight-Errant', /emblem/i, 'elspeth');
    await restCursor(page);
    await resolveStack(page, 'the emblem');
    film.mark('emblem');
    await film.beat(3_500);
    film.mark('end');
  } finally {
    await wrap(shoot ?? {});
  }
});
