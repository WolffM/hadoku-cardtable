/**
 * Clip: Cephalid Breakfast, Teneggi's 2007 list. With Full control on, Nomads en-Kor targets Cephalid
 * Illusionist four times while holding priority — four mill triggers stack up, resolve, and mill the whole
 * library (three Narcomoebas come along) — then Dread Return's flashback sacrifices the Narcomoebas for
 * Sutured Ghoul, Dragon Breath gives it haste, and it swings for the game. The rival is on Auto Yield.
 * `promo-breakfast.state` has it.
 */
import { test, type Page } from '@playwright/test';

import { clickPermanent, isOffered, ownNamed, pressPaymentAuto, says, stackCount } from '../play/board.ts';
import { passToDeclareAttackers } from '../play/combat.ts';
import { answerPrompt } from '../play/prompts.ts';
import { autoYield, deliberateClick, okEnabled, pickTiles, pressIfThere, restCursor, selectionTiles, shootScenario, until, wrap, type Shoot } from './drive.ts';

const LOOPS = 4;
const YARD = '.seat [data-zone="graveyard"][data-owner="you"]';

const libraryOf = async (page: Page): Promise<number> =>
  Number(((await page.locator('.seat[data-viewer] [data-testid="library-count"]').first().getAttribute('aria-label')) ?? '').replace(/\D/g, '') || NaN);

/** Full control on or off, by the board's own toggle. */
async function setFullControl(page: Page, on: boolean): Promise<void> {
  const full = page.getByTestId('live-full-control');
  if (((await full.getAttribute('aria-pressed')) === 'true') !== on) await deliberateClick(page, full, { hover: 300 });
}

/** A card in the viewer's own graveyard, by name. */
async function yardCard(page: Page, name: string): Promise<number> {
  const card = page.locator(`${YARD} [data-board-card]`, { hasText: name }).first();
  await until(`${name} is in the graveyard`, async () => (await card.count()) > 0, 20_000, 150, page);
  return Number(await card.getAttribute('data-board-card'));
}

/**
 * Pick a flashback card up from the graveyard pile and let go over the table (`w69-flashback.spec.ts`'s
 * gesture): pressed on the strip the pile shows of it, carried, released.
 */
async function castFromYard(page: Page, id: number): Promise<void> {
  const at = await page.evaluate(
    ([sel, cardId]) => {
      const li = document.querySelector<HTMLElement>(`${sel} li[data-card-id="${cardId}"]`)!;
      const next = li.nextElementSibling as HTMLElement | null;
      const box = li.getBoundingClientRect();
      const px = next === null ? box.height : Math.max(0, next.getBoundingClientRect().top - box.top);
      return { x: box.left + box.width / 2, y: box.top + Math.min(px, box.height) / 2 };
    },
    [YARD, id] as const,
  );
  const field = (await page.locator('.seat[data-viewer] [data-zone="battlefield"]').first().boundingBox())!;
  await page.mouse.move(at.x, at.y, { steps: 16 });
  await page.waitForTimeout(900);
  await page.mouse.down();
  await page.mouse.move(field.x + field.width / 2, field.y + field.height * 0.35, { steps: 24 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await restCursor(page);
}

async function glide(page: Page, id: number, rest: number): Promise<void> {
  const box = await page.locator(`[data-board-card="${id}"]`).first().boundingBox();
  if (box !== null) await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.7, { steps: 10 });
  await page.waitForTimeout(rest);
}

test('breakfast: Nomads at the Illusionist, four deep, into Sutured Ghoul', async ({ browser }) => {
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
    await autoYield(rival.page);
    await setFullControl(page, true);
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
      if ((await stackCount(page)) > 0) await pressIfThere(okEnabled(page));
      return false;
    }, 90_000, 300, page);
    film.mark('milled');
    console.log(`[promo:breakfast] library ${await libraryOf(page)}; Narcomoebas out: ${(await ownNamed(page, 'Narcomoeba')).length}`);
    await film.beat(1_500);

    // Dread Return's flashback, picked up from the graveyard like a hand card: three Narcomoebas for Sutured Ghoul.
    await setFullControl(page, false);
    film.mark('dread-return');
    const dread = await yardCard(page, 'Dread Return');
    await castFromYard(page, dread);
    film.mark('dread-cast');
    let heard = '';
    await until('Sutured Ghoul is on the battlefield', async () => {
      const text = await says(page);
      if (text !== heard) console.log(`[promo:breakfast] ${(heard = text).replace(/\s+/g, ' ').slice(0, 140)}`);
      if ((await ownNamed(page, 'Sutured Ghoul')).length > 0 && (await stackCount(page)) === 0 && !/exile|imprint/i.test(text)) return true;
      const tiles = await selectionTiles(page);
      if (/sacrifice/i.test(text) && tiles.length > 0) {
        await pickTiles(page, tiles.filter((t) => t.text.startsWith('Narcomoeba')).map((t) => t.id), 300);
        return false;
      }
      // Imprint: every creature card in the graveyard moved across to "Chosen", at a readable pace.
      const notChosen = page.locator('[data-testid="zone-source"] li[data-key]');
      if ((await notChosen.count()) > 0) {
        film.mark('imprint');
        await page.waitForTimeout(900);
        while ((await notChosen.count()) > 0) {
          await notChosen.first().evaluate((el) => (el as HTMLElement).click());
          await page.waitForTimeout(260);
        }
        await page.waitForTimeout(700);
        await pressIfThere(page.locator('[data-testid="live-prompt"] [data-testid="prompt-submit"]:enabled'));
        return false;
      }
      const ghoul = page.locator('section[data-prompt="getChoices"] li', { hasText: 'Sutured Ghoul' }).first();
      if ((await ghoul.count()) > 0) {
        await ghoul.locator('label').click();
        await page.locator('section[data-prompt="getChoices"] [data-testid="prompt-submit"]').click();
        return false;
      }
      if (/target/i.test(text) && tiles.some((t) => t.text.startsWith('Sutured Ghoul'))) {
        await pickTiles(page, [tiles.find((t) => t.text.startsWith('Sutured Ghoul'))!.id], 300);
        return false;
      }
      await pressIfThere(page.locator('[data-testid="prompt-confirm-yes"]:enabled'));
      await pressPaymentAuto(page);
      if ((await stackCount(page)) > 0) await pressIfThere(okEnabled(page));
      return false;
    }, 90_000, 300, page);
    const ghoul = (await ownNamed(page, 'Sutured Ghoul'))[0]!;
    film.mark('ghoul');
    await glide(page, ghoul, 1_800);
    await restCursor(page);
    await film.beat(800);

    // Hasty from Dragon Breath: into combat, and swing.
    film.mark('attack');
    await passToDeclareAttackers(page);
    await deliberateClick(page, page.locator(`[data-board-card="${ghoul}"] button`).first(), { hover: 500 });
    await film.beat(600);
    await until('the game is won', async () => {
      if ((await page.getByText(/victory/i).count()) > 0) return true;
      await pressIfThere(okEnabled(page));
      return false;
    }, 60_000, 400, page);
    film.mark('win');
    await film.beat(4_000);
    film.mark('end');
  } finally {
    await wrap(shoot ?? {});
  }
});
