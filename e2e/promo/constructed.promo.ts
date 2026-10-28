/**
 * Clip: the headliner — historical constructed with a friend. The front page with rooms open, a room made,
 * Legacy picked, a trip through the eras (2008, 2014, 2025), the real decklists hovered, both friends
 * choose a deck and ready, and the match's board comes up with the two decks drawn.
 */
import { test, type Page } from '@playwright/test';

import { forgeAvailability, startPlayStack, type PlayStack } from '../play/harness.ts';
import { confirmYes } from '../play/confirm.ts';
import { says } from '../play/board.ts';
import { deliberateClick, pressIfThere, restCursor, until } from './drive.ts';
import { HERO, openPromoFriend, RIVAL, startFilm } from './rig.ts';

const PREFIX = '/cardtable';

/** A room someone else has open, so the front page is not empty. Made through the same POST the form sends. */
async function openRoomAs(page: Page, origin: string, body: Record<string, unknown>): Promise<void> {
  const res = await page.context().request.post(`${origin}${PREFIX}/api/rooms`, { data: { clientMode: 'builtin', ...body } });
  if (!res.ok()) throw new Error(`promo: POST /api/rooms ${res.status()} ${await res.text()}`);
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

    const page = hero.page;
    await page.goto(`${origin}${PREFIX}/`);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await film.beat(2_000);
    await film.roll();
    film.mark('front');
    await film.beat(2_200);

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
    await restCursor(page).catch(() => undefined);
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
