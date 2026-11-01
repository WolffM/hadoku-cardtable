/**
 * Clip: the trailer's last shot. Progenitus, a 10/10 with protection from everything, swings into a rival
 * at 10: the hit lands at the top of the weight curve, with its sound, and the game is won.
 * `promo-progenitus.state` has the board.
 */
import { test } from '@playwright/test';

import { ownNamed } from '../play/board.ts';
import { autoYield, restCursor, shootScenario, swing, untilWon, wrap, type Shoot } from './drive.ts';

test('progenitus: ten to the face', async ({ browser }) => {
  let shoot: Shoot | undefined;
  try {
    shoot = await shootScenario(browser, 'progenitus', 'promo-progenitus');
    const { film, hero, rival } = shoot;
    const page = hero.page;
    await autoYield(rival.page);
    await restCursor(page);
    film.mark('board');
    await film.beat(2_000);
    const [progenitus] = await ownNamed(page, 'Progenitus');
    if (progenitus === undefined) throw new Error('promo: no Progenitus on the battlefield');
    film.mark('attack');
    await swing(page, [progenitus]);
    film.mark('declared');
    await untilWon(film, page);
    await film.beat(5_000);
    film.mark('end');
  } finally {
    await wrap(shoot ?? {});
  }
});
