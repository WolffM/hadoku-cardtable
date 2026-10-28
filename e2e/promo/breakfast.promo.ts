/**
 * Clip: Cephalid Breakfast. With Full control on, Nomads en-Kor targets Cephalid Illusionist four times
 * while holding priority — four mill triggers stack up, resolve, and mill the whole library (both
 * Narcomoebas come along) — then Thassa's Oracle wins on an empty library. `promo-breakfast.state` has it.
 */
import { test, type Page } from '@playwright/test';

import { clickPermanent, isOffered, ownNamed, pressPaymentAuto, says, stackCount } from '../play/board.ts';
import { answerPrompt } from '../play/prompts.ts';
import { cast, deliberateClick, okEnabled, pressIfThere, restCursor, shootScenario, until, wrap, type Shoot } from './drive.ts';

const LOOPS = 4;

const libraryOf = async (page: Page): Promise<number> =>
  Number(((await page.locator('.seat[data-viewer] [data-testid="library-count"]').first().getAttribute('aria-label')) ?? '').replace(/\D/g, '') || NaN);

async function glide(page: Page, id: number, rest: number): Promise<void> {
  const box = await page.locator(`[data-board-card="${id}"]`).first().boundingBox();
  if (box !== null) await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.7, { steps: 10 });
  await page.waitForTimeout(rest);
}

test('breakfast: Nomads at the Illusionist, four deep, into Thassa’s Oracle', async ({ browser }) => {
  let shoot: Shoot | undefined;
  try {
    shoot = await shootScenario(browser, 'breakfast', 'promo-breakfast');
    const { film, hero, rival } = shoot;
    const page = hero.page;
    const nomads = (await ownNamed(page, 'Nomads en-Kor'))[0]!;
    const illusionist = (await ownNamed(page, 'Cephalid Illusionist'))[0]!;
    film.mark('board');
    await film.beat(1_500);

    // Hold priority between activations.
    const full = page.getByTestId('live-full-control');
    if ((await full.getAttribute('aria-pressed')) !== 'true') await deliberateClick(page, full, { hover: 300 });
    await film.beat(500);

    film.mark('loop');
    for (let n = 1; n <= LOOPS; n++) {
      // A glide for the camera, then the board's own press: the mill chips land over the two creatures.
      await glide(page, nomads, n === 1 ? 700 : 120);
      // The Illusionist's own mill chip is drawn over Nomads from the second round on, so the press goes to
      // the card's button itself (the cursor is not in the footage).
      await until(`Nomads is offered (${n})`, async () => isOffered(page, nomads), 30_000, 150, page);
      await page.locator(`[data-board-card="${nomads}"] button`).first().evaluate((b) => (b as HTMLButtonElement).click());
      await glide(page, illusionist, n === 1 ? 500 : 100);
      await until(`the Illusionist is targeted (${n})`, async () => {
        const list = page.locator('section[data-prompt="getChoices"] li', { hasText: 'Cephalid Illusionist' }).first();
        if ((await list.count()) > 0) {
          await list.locator('label').click();
          await page.locator('section[data-prompt="getChoices"] [data-testid="prompt-submit"]').click();
          return true;
        }
        return clickPermanent(page, illusionist, 500);
      }, 20_000, 150, page);
      await until(`activation ${n} is on the stack`, async () => (await stackCount(page)) >= n, 20_000, 100, page);
      console.log(`[promo:breakfast] activation ${n}: stack ${await stackCount(page)}, says "${(await says(page)).slice(0, 80)}"`);
    }
    await restCursor(page);
    film.mark('stacked');
    await film.beat(1_800);

    // Let it all resolve: pass, let the rival pass, say yes to each Narcomoeba.
    film.mark('mill');
    await until('the library is empty and the stack done', async () => {
      if ((await libraryOf(page)) === 0 && (await stackCount(page)) === 0) return true;
      await pressIfThere(page.locator('[data-testid="prompt-confirm-yes"]:enabled'));
      await answerPrompt(page).catch(() => null);
      await pressIfThere(okEnabled(rival.page));
      if ((await stackCount(page)) > 0) await pressIfThere(okEnabled(page));
      return false;
    }, 90_000, 300, page);
    film.mark('milled');
    console.log(`[promo:breakfast] library ${await libraryOf(page)}; Narcomoebas out: ${(await ownNamed(page, 'Narcomoeba')).length}`);
    await film.beat(1_500);

    film.mark('oracle');
    await cast(page, "Thassa's Oracle", { hover: 1_200 });
    await until('the game is won', async () => {
      if ((await page.getByText(/victory/i).count()) > 0) return true;
      await pressPaymentAuto(page);
      await pressIfThere(page.locator('[data-testid="prompt-confirm-yes"]:enabled'));
      await answerPrompt(page).catch(() => null);
      await pressIfThere(okEnabled(rival.page));
      if ((await stackCount(page)) > 0) await pressIfThere(okEnabled(page));
      return false;
    }, 90_000, 300, page);
    film.mark('win');
    await film.beat(4_000);
    film.mark('end');
  } finally {
    await wrap(shoot ?? {});
  }
});
