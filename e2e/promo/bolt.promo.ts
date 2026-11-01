/**
 * Clip: Lightning Bolt to the face of a rival at 3, and the Victory screen. `promo-bolt.state` has the board.
 */
import { test } from '@playwright/test';

import { says } from '../play/board.ts';
import { autoYield, cast, deliberateClick, opponentFace, pressIfThere, okEnabled, restCursor, shootScenario, until, untilWon, wrap, type Shoot } from './drive.ts';

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
    await until('Bolt asks for its target', async () => /target/i.test(await says(page)), 30_000, 200, page);
    await deliberateClick(page, opponentFace(page), { hover: 500 });
    film.mark('targeted');
    await restCursor(page);
    await until('Bolt is paid for', async () => !(await pressIfThere(page.locator('[data-testid="live-payment-ok"]:enabled'))) && (await okEnabled(page).count()) > 0, 30_000, 250, page);
    await untilWon(film, page);
    await film.beat(4_500);
    film.mark('end');
  } finally {
    await wrap(shoot ?? {});
  }
});
