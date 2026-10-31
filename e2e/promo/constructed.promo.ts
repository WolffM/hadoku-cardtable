/**
 * Clip: the headliner — historical constructed with a friend. The front page with rooms open and a game
 * just played looping in its live slot, a room made,
 * Legacy picked, a trip through the eras (2008, 2014, 2025), the real decklists hovered, both friends
 * choose a deck and ready, and the match's board comes up with the two decks drawn.
 */
import { test, type Browser, type Page } from '@playwright/test';

import { forgeAvailability, startPlayStack, type PlayStack } from '../play/harness.ts';
import { confirmYes } from '../play/confirm.ts';
import { pressPaymentAuto, says, stackCount } from '../play/board.ts';
import { startScenarioMatch } from '../play/scenario.ts';
import { cast, deliberateClick, okEnabled, pressIfThere, until } from './drive.ts';
import { HERO, openPromoFriend, RIVAL, startFilm, TAGS } from './rig.ts';

const PREFIX = '/cardtable';

/** A room someone else has open, so the front page is not empty. Made through the same POST the form sends. */
async function openRoomAs(page: Page, origin: string, body: Record<string, unknown>): Promise<void> {
  const res = await page.context().request.post(`${origin}${PREFIX}/api/rooms`, { data: { clientMode: 'builtin', ...body } });
  if (!res.ok()) throw new Error(`promo: POST /api/rooms ${res.status()} ${await res.text()}`);
}

/**
 * A short game two other friends finish before the camera rolls — Blasphemous Act into a full board, then a
 * concession — so the front page's live slot has a recorded game to loop.
 */
async function playReplayedGame(browser: Browser, stack: PlayStack): Promise<void> {
  const { alice: wiper, bob: wiped } = await startScenarioMatch(browser, stack, 'promo-blasphemous', {
    seats: { open: [() => openPromoFriend(browser, 'vexmoor'), () => openPromoFriend(browser, 'lumen')], names: [TAGS.vexmoor!, TAGS.lumen!] },
  });
  const creatures = (page: Page) => page.locator('[data-zone="battlefield"] [data-board-card]:has(.board-card__pt[data-pt=""])');
  await wiper.page.waitForTimeout(1_500);
  await cast(wiper.page, 'Blasphemous Act', { hover: 900 });
  await until('the replayed game’s wipe resolves', async () => {
    if ((await stackCount(wiper.page)) === 0 && (await creatures(wiper.page).count()) === 0) return true;
    await pressPaymentAuto(wiper.page);
    await pressIfThere(okEnabled(wiped.page));
    return false;
  }, 60_000, 250, wiper.page);
  await wiper.page.waitForTimeout(3_000);
  await wiped.page.getByTestId('live-concede').click();
  await wiped.page.getByTestId('live-concede-yes').click();
  await wiper.page.getByTestId('game-result').waitFor({ timeout: 30_000 });
  for (const f of [wiper, wiped]) await f.context.close();
}

const deckTile = (page: Page, name: RegExp) => page.getByTestId('deck-mine').locator('[data-deck-id]', { hasText: name }).first();

async function pickEra(page: Page, value: string): Promise<void> {
  const select = page.getByTestId('format');
  await deliberateClick(page, select, { hover: 300 });
  await page.keyboard.press('Escape');
  await select.selectOption(value);
  await page.waitForTimeout(1_400);
}

test('constructed: historical decks with a friend', async ({ browser }) => {
  const forge = forgeAvailability();
  if (!forge.ok) throw new Error(forge.reason);
  const film = await startFilm('constructed');
  let stack: PlayStack | undefined;
  try {
    stack = await startPlayStack(forge);
    const origin = stack.origin;
    const hero = await openPromoFriend(film.hero, HERO, { filmed: true });
    const rival = await openPromoFriend(browser, RIVAL);
    const vexmoor = await openPromoFriend(browser, 'vexmoor');
    const lumen = await openPromoFriend(browser, 'lumen');
    for (const f of [rival, vexmoor, lumen]) await f.page.goto(`${origin}${PREFIX}/`);
    await openRoomAs(vexmoor.page, origin, { name: 'Vintage Cube — 8 seats', gameType: 'draft' });
    await openRoomAs(lumen.page, origin, { name: 'Modern Gauntlet', gameType: 'constructed-1v1', mode: 'gauntlet', modeOptions: { family: 'modern' } });
    await openRoomAs(rival.page, origin, { name: 'All Random — Legacy', gameType: 'constructed-1v1', mode: 'random', modeOptions: { pool: 'legacy' } });

    await playReplayedGame(browser, stack);

    const page = hero.page;
    await page.goto(`${origin}${PREFIX}/`);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    // The live slot's replay takes a few seconds to draw its first frame cold: roll once it has art.
    await until('the replay card draws', async () => (await page.locator('[data-testid="front-live-slot"] img').count()) > 0, 30_000, 200, page);
    await film.beat(1_000);
    await film.roll();
    film.mark('front');
    // The live slot loops the game just played: long enough to see the wipe in it.
    await film.beat(7_000);

    film.mark('create');
    await deliberateClick(page, page.getByTestId('room-create-open'), { hover: 500 });
    await page.getByTestId('room-create-name').pressSequentially('Friday Night Legacy', { delay: 55 });
    await page.getByTestId('room-create-type-constructed-1v1').check();
    await page.getByTestId('room-create-constructed-mode-classic').check();
    await film.beat(500);
    await deliberateClick(page, page.getByTestId('room-create-submit'), { hover: 300 });
    await page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
    const roomUrl = page.url();
    await film.beat(1_200);

    film.mark('legacy');
    await deliberateClick(page, page.getByRole('tab', { name: 'Legacy', exact: true }), { hover: 400 });
    await film.beat(1_000);
    film.mark('eras');
    for (const era of ['legacy-2008-07-25', 'legacy-2014-07-18', 'legacy-2025-06-30']) await pickEra(page, era);

    film.mark('decks');
    for (const name of [/Cephalid/, /Reanimator/, /Omnitell/]) {
      const tile = deckTile(page, name);
      const box = await tile.boundingBox();
      if (box === null) continue;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3, { steps: 20 });
      await film.beat(1_900);
    }

    film.mark('pick');
    await deliberateClick(page, deckTile(page, /Omnitell/), { hover: 200 });
    // Off the grid, into the empty right of "At the table", so no decklist peek stays open over the pick.
    await page.mouse.move(1300, 400, { steps: 14 });
    await rival.page.goto(roomUrl);
    await until('the rival can pick a deck', async () => (await rival.page.getByTestId('deck-mine').locator('[data-deck-id]').count()) > 0, 30_000);
    await deckTile(rival.page, /Death And Taxes/).click();
    await film.beat(1_500);

    film.mark('ready');
    await deliberateClick(page, page.getByTestId('ready-toggle'), { hover: 400 });
    await rival.page.getByTestId('ready-toggle').click();
    await page.waitForURL(/#\/match\/m-[0-9a-f]{12}$/, { timeout: 120_000 });
    film.mark('match');

    // Keep both hands, the hero's at a viewer's pace.
    await until('both hands are kept', async () => {
      for (const p of [page, rival.page]) {
        const text = await says(p);
        if (/play or draw/i.test(text)) await pressIfThere(p.getByTestId(p === page ? 'live-play-or-draw-play' : 'live-play-or-draw-draw'));
        else if (/keep your hand/i.test(text)) {
          if (p === page) await page.waitForTimeout(1_800);
          await pressIfThere(confirmYes(p));
        } else if (/return \d+ card/i.test(text)) await pressIfThere(p.locator('[data-testid="live-decision-ok"]:enabled'));
      }
      return /^Priority:/.test(await says(page));
    }, 90_000, 300);
    film.mark('board');
    await film.beat(4_000);
    film.mark('end');
  } finally {
    await film.stop();
    await stack?.stop();
  }
});
