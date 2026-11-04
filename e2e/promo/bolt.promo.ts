/**
 * Clip: Lightning Bolt to the face of a rival at 3, and the Victory screen. `promo-bolt.state` has the board.
 */
import { test } from '@playwright/test';

import { autoYield, cast, deliberateClick, faceTargetable, opponentFace, restCursor, shootScenario, until, untilWon, wrap, type Shoot } from './drive.ts';

test('bolt: three to the face', async ({ browser }) => {
  let shoot: Shoot | undefined;
  try {
    shoot = await shootScenario(browser, 'bolt', 'promo-bolt');
    const { film, hero, rival } = shoot;
    const page = hero.page;
    await autoYield(rival.page);
    film.mark('board');
    await film.beat(1_800);
    film.mark('cast');
    await cast(page, 'Lightning Bolt', { hover: 900 });
    await until('Bolt asks for its target', () => faceTargetable(page), 30_000, 150, page);
    await deliberateClick(page, opponentFace(page), { hover: 500 });
    film.mark('targeted');
    await restCursor(page);
    await untilWon(film, page);
    await film.beat(4_500);
    film.mark('end');
  } finally {
    await wrap(shoot ?? {});
  }
});
