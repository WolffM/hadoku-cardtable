/**
 * Clip: a board wipe. Blasphemous Act for {R} into thirteen creatures, and every one of them dies at once.
 * `promo-blasphemous.state` has the board.
 */
import { test, type Page } from '@playwright/test';

import { pressPaymentAuto, stackCount } from '../play/board.ts';
import { cast, okEnabled, pressIfThere, restCursor, shootScenario, until, wrap, type Shoot } from './drive.ts';

/** Every creature on either battlefield: the ones that carry a power/toughness box (`Board.tsx`'s `board-card__pt`). */
const creatures = (page: Page) => page.locator('[data-zone="battlefield"] [data-board-card]:has(.board-card__pt[data-pt=""])');

test('blasphemous: thirteen creatures die at once', async ({ browser }) => {
  let shoot: Shoot | undefined;
  try {
    shoot = await shootScenario(browser, 'blasphemous', 'promo-blasphemous');
    const { film, hero, rival } = shoot;
    const page = hero.page;
    film.mark('board');
    console.log(`[promo:blasphemous] creatures on the board: ${await creatures(page).count()}`);
    await film.beat(2_000);

    film.mark('cast');
    await cast(page, 'Blasphemous Act', { hover: 1_300 });
    await until('Blasphemous Act is on the stack', async () => {
      if ((await stackCount(page)) > 0) return true;
      await pressPaymentAuto(page);
      return false;
    }, 30_000, 250, page);
    await restCursor(page);
    film.mark('on-stack');

    await until('the board is empty', async () => {
      if ((await stackCount(page)) === 0 && (await creatures(page).count()) === 0) return true;
      await pressIfThere(okEnabled(rival.page));
      return false;
    }, 60_000, 250, page);
    film.mark('wiped');
    await film.beat(4_500);
    film.mark('end');
  } finally {
    await wrap(shoot ?? {});
  }
});
