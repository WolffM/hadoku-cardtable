/**
 * Clip: storm. Rite of Flame, Desperate Ritual, Pyretic Ritual and Lotus Petal, then Grapeshot with storm
 * four: five Grapeshots stack up and go at the rival's face. `promo-storm.state` has the board.
 */
import { test } from '@playwright/test';

import { says, stackCount } from '../play/board.ts';
import { autoYield, cast, deliberateClick, faceTargetable, opponentFace, pressIfThere, resolveStack, restCursor, shootScenario, until, untilWon, wrap, type Shoot } from './drive.ts';

const RITUALS = ['Rite of Flame', 'Desperate Ritual', 'Pyretic Ritual', 'Lotus Petal'];

test('storm: five Grapeshots', async ({ browser }) => {
  let shoot: Shoot | undefined;
  try {
    shoot = await shootScenario(browser, 'storm', 'promo-storm');
    const { film, hero, rival } = shoot;
    const page = hero.page;
    await autoYield(rival.page);
    film.mark('board');
    await film.beat(1_500);
    film.mark('chain');
    for (const name of RITUALS) {
      await cast(page, name, { hover: 450 });
      await resolveStack(page, `${name} resolves`);
    }
    film.mark('grapeshot');
    await cast(page, 'Grapeshot', { hover: 700 });
    // The original's target, then each copy's: keep the rival's face (no new targets), or point at it.
    let heard = '';
    await until('the Grapeshots are on the stack', async () => {
      const text = await says(page);
      if (text !== heard) console.log(`[promo:storm] ${(heard = text).replace(/\s+/g, ' ').slice(0, 140)}`);
      if ((await stackCount(page)) >= 2 || (await page.getByTestId('game-result').count()) > 0) return true;
      if (/new targets/i.test(text)) await pressIfThere(page.locator('[data-testid="prompt-confirm-no"]:enabled'));
      else if (await faceTargetable(page)) await deliberateClick(page, opponentFace(page), { hover: 250 });
      else await pressIfThere(page.locator('[data-testid="live-payment-ok"]:enabled'));
      return false;
    }, 60_000, 200, page);
    film.mark('copies');
    await restCursor(page);
    await untilWon(film, page);
    await film.beat(4_000);
    film.mark('end');
  } finally {
    await wrap(shoot ?? {});
  }
});
