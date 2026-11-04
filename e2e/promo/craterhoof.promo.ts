/**
 * Clip: Craterhoof Behemoth into six elves. Each creature gets +7/+7 and trample, and all six that can
 * attack swing at once: the strikes land weakest first. `promo-craterhoof.state` has the board.
 */
import { test } from '@playwright/test';

import { ownNamed } from '../play/board.ts';
import { autoYield, cast, resolveStack, restCursor, shootScenario, swing, until, untilWon, wrap, type Shoot } from './drive.ts';

test('craterhoof: six elves swing', async ({ browser }) => {
  let shoot: Shoot | undefined;
  try {
    shoot = await shootScenario(browser, 'craterhoof', 'promo-craterhoof');
    const { film, hero, rival } = shoot;
    const page = hero.page;
    await autoYield(rival.page);
    film.mark('board');
    await film.beat(1_800);
    film.mark('cast');
    await cast(page, 'Craterhoof Behemoth', { hover: 1_000 });
    await resolveStack(page, 'the Behemoth resolves');
    await until('the Behemoth lands', async () => (await ownNamed(page, 'Craterhoof Behemoth')).length > 0, 30_000, 200, page);
    film.mark('landed');
    // Its trigger goes on the stack as it lands: resolve that too.
    await page.waitForTimeout(800);
    await resolveStack(page, 'the Behemoth’s trigger resolves');
    await restCursor(page);
    film.mark('pumped');
    await film.beat(1_500);
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
