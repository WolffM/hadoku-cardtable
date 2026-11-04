/**
 * Clip (a raw extra, outside cut 5's main structure): a big attack. Twelve creatures of every size swing at a
 * rival at 20 with no blockers: the strikes land weakest first and strongest last (w87a), and the defender's
 * avatar recoils (wavatar). `promo-big-attack.state` has the board.
 */
import { test } from '@playwright/test';

import { autoYield, restCursor, shootScenario, swing, untilWon, wrap, type Shoot } from './drive.ts';

test('bigattack: twelve creatures swing', async ({ browser }) => {
  let shoot: Shoot | undefined;
  try {
    shoot = await shootScenario(browser, 'bigattack', 'promo-big-attack');
    const { film, hero, rival } = shoot;
    const page = hero.page;
    await autoYield(rival.page);
    await restCursor(page);
    film.mark('board');
    await film.beat(2_000);
    film.mark('attack');
    await swing(page, 'all');
    film.mark('declared');
    await untilWon(film, page);
    await film.beat(4_000);
    film.mark('end');
  } finally {
    await wrap(shoot ?? {});
  }
});
