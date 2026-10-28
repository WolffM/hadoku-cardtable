/**
 * Clip: Emrakul hits the table. Cast for free off Omniscience into a crowded board, fifteen power lands
 * at the heaviest weight the board draws (`live/entries.ts`): cracks, shake, two rings of cards knocked
 * away. `promo-emrakul.state` has the board.
 */
import { test } from '@playwright/test';

import { pressPaymentAuto } from '../play/board.ts';
import { answerPrompt } from '../play/prompts.ts';
import { cast, okEnabled, pressIfThere, restCursor, shootScenario, until, wrap, type Shoot } from './drive.ts';

test('emrakul: fifteen power lands', async ({ browser }) => {
  let shoot: Shoot | undefined;
  try {
    shoot = await shootScenario(browser, 'emrakul', 'promo-emrakul');
    const { film, hero, rival } = shoot;
    const page = hero.page;
    const emrakul = page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]', { hasText: 'Emrakul' });
    film.mark('board');
    await film.beat(2_000);

    film.mark('cast');
    await cast(page, 'Emrakul, the Aeons Torn', { hover: 1_500 });
    await until('Emrakul lands', async () => {
      if ((await emrakul.count()) > 0) return true;
      await pressIfThere(page.locator('[data-testid="prompt-confirm-yes"]:enabled'));
      await pressPaymentAuto(page);
      await answerPrompt(page).catch(() => null);
      await pressIfThere(okEnabled(rival.page));
      return false;
    }, 60_000, 200, page);
    film.mark('landed');
    await restCursor(page);
    await film.beat(5_000);
    film.mark('end');
  } finally {
    await wrap(shoot ?? {});
  }
});
