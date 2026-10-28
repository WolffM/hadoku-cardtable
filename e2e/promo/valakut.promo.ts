/**
 * Clip: Titan Shift goes off. Scapeshift sacrifices eleven lands, fetches Valakut and ten Mountains, and
 * ten Valakut triggers pop at once — one "same target for all" pick sends all thirty damage face.
 * `promo-valakut.state` has the board.
 */
import { test } from '@playwright/test';

import { pressPaymentAuto, says, stackCount } from '../play/board.ts';
import { answerPrompt } from '../play/prompts.ts';
import { cast, deliberateClick, lifeOf, okEnabled, opponentFace, pickTiles, pressIfThere, selectionTiles, shootScenario, until, wrap, type Shoot } from './drive.ts';

test('valakut: Scapeshift for ten triggers', async ({ browser }) => {
  let shoot: Shoot | undefined;
  try {
    shoot = await shootScenario(browser, 'valakut', 'promo-valakut');
    const { film, hero, rival } = shoot;
    const page = hero.page;
    film.mark('board');
    await film.beat(1_800);

    film.mark('cast');
    await cast(page, 'Scapeshift', { hover: 1_100 });

    // Pay, let the rival pass, say yes to "sacrifice?", until the eleven-land sheet is open.
    await until('the sacrifice sheet', async () => {
      if ((await selectionTiles(page)).length >= 11) return true;
      await pressPaymentAuto(page);
      if ((await stackCount(rival.page)) > 0) await pressIfThere(okEnabled(rival.page));
      await pressIfThere(page.locator('[data-testid="prompt-confirm-yes"]:enabled'));
      return false;
    });
    await film.beat(600);
    film.mark('sacrifice');
    await pickTiles(page, (await selectionTiles(page)).map((t) => t.id), 110);

    // The library search: Valakut first, then every Mountain.
    await until('the search sheet', async () => {
      const tiles = await selectionTiles(page);
      if (tiles.some((t) => /Valakut/.test(t.text))) return true;
      await pressIfThere(page.locator('[data-testid="prompt-confirm-yes"]:enabled'));
      return false;
    });
    await film.beat(700);
    film.mark('search');
    const library = await selectionTiles(page);
    const wanted = [...library.filter((t) => /Valakut/.test(t.text)), ...library.filter((t) => t.text.startsWith('Mountain'))];
    console.log(`[promo:valakut] search offers ${library.length}: picking ${wanted.length} (${wanted.map((t) => t.text).join(' | ').slice(0, 200)})`);
    await pickTiles(page, wanted.map((t) => t.id), 120);

    // Ten triggers: tick "same target for all", point at the rival once.
    await until('the first Valakut target question', async () => {
      if (/Valakut, the Molten Pinnacle/.test(await says(page)) && !/^Priority/.test(await says(page))) return true;
      await answerPrompt(page).catch(() => null);
      await pressIfThere(okEnabled(rival.page));
      return false;
    });
    film.mark('triggers');
    await film.beat(2_200);
    const same = page.getByTestId('live-same-target');
    // At 1920×1080 the box is drawn under the popup's own tiles (a real overlap — reported, not fixed
    // here), so it is ticked without a pointer; the face click below is the shot.
    if ((await same.count()) > 0) await same.evaluate((el) => (el as HTMLInputElement).click());
    await deliberateClick(page, opponentFace(page), { hover: 700 });
    film.mark('targeted');

    await until('the rival is dead', async () => {
      const life = Number((await lifeOf(page, 'theirs').textContent()) ?? '20');
      if (life <= 0 || (await page.getByText(/you win|victory/i).count()) > 0) return true;
      const yes = page.locator('[data-testid="prompt-confirm-yes"]:enabled');
      if (/^Do you want to deal/.test(await says(page))) await pressIfThere(yes);
      await pressIfThere(okEnabled(rival.page));
      await pressIfThere(okEnabled(page));
      return false;
    }, 120_000, 300);
    film.mark('lethal');
    await film.beat(5_000);
    film.mark('end');
  } finally {
    await wrap(shoot ?? {});
  }
});
