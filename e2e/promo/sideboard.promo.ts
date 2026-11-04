/**
 * Clip (a raw extra, outside cut 5's main structure): sideboarding between games. Ashgrove and Nightjar play
 * game 1 of a Legacy match in a room; Nightjar concedes; both press Rematch, which makes it a best of three and
 * opens the sideboard step; the hero brings two cards in from the sideboard and takes two out, readies, and
 * game 2's board comes up. `w72-sideboard.spec.ts` drives the same flow as a test.
 */
import { test, type Page } from '@playwright/test';

import { says } from '../play/board.ts';
import { confirmYes } from '../play/confirm.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from '../play/harness.ts';
import { submitCreateRoom } from '../play/rooms.ts';
import { deliberateClick, humanRest, pressIfThere, until } from './drive.ts';
import { HERO, openPromoFriend, RIVAL, startFilm } from './rig.ts';

const PREFIX = '/cardtable';
const MATCH_URL = /#\/match\/(m-[0-9a-f]{12})$/;
const ERA = 'legacy-2025-06-30';

const deckTile = (page: Page, name: RegExp) => page.getByTestId('deck-mine').locator('[data-deck-id]', { hasText: name }).first();

/** Both seats keep, the hero at a person's pace, until the hero's board is up. */
async function keepBoth(hero: Page, rival: Page): Promise<void> {
  await until('both hands are kept', async () => {
    for (const p of [hero, rival]) {
      const text = await says(p);
      if (/play or draw/i.test(text)) await pressIfThere(p.getByTestId('live-play-or-draw-play'));
      else if (/keep your hand/i.test(text)) await pressIfThere(confirmYes(p));
      else if (/return \d+ card/i.test(text)) await pressIfThere(p.locator('[data-testid="live-decision-ok"]:enabled'));
    }
    return /^(Priority|Waiting)/.test(await says(hero));
  }, 120_000, 300, hero);
}

test('sideboard: between games, two cards in, two out', async ({ browser }) => {
  const forge = forgeAvailability();
  if (!forge.ok) throw new Error(forge.reason);
  const film = await startFilm('sideboard');
  let stack: PlayStack | undefined;
  try {
    stack = await startPlayStack(forge);
    const origin = stack.origin;
    const hero = await openPromoFriend(film.hero, HERO);
    const rival = await openPromoFriend(browser, RIVAL);
    // Made through the form, as a person would: a room made over the API left the page's controls disabled.
    await hero.page.goto(`${origin}${PREFIX}/`);
    await submitCreateRoom(hero.page, { name: 'Friday Night Legacy', gameType: 'constructed-1v1' });
    await hero.page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
    const roomUrl = hero.page.url();
    await rival.page.goto(roomUrl);
    await hero.page.getByTestId('constructed').waitFor({ timeout: 30_000 });
    await hero.page.getByRole('tab', { name: 'Legacy', exact: true }).click();
    await hero.page.getByTestId('format').selectOption(ERA);
    await until('both can pick a deck', async () => {
      for (const p of [hero.page, rival.page]) if ((await p.getByTestId('deck-mine').locator('[data-deck-id]').count()) === 0) return false;
      return true;
    }, 30_000);
    await deckTile(hero.page, /Omnitell|Show and Tell|Sneak/).click();
    await deckTile(rival.page, /Death And Taxes|Taxes/).click();
    await hero.page.getByTestId('ready-toggle').click();
    await rival.page.getByTestId('ready-toggle').click();
    await hero.page.waitForURL(MATCH_URL, { timeout: 120_000 });
    const game1 = MATCH_URL.exec(hero.page.url())?.[1];
    await keepBoth(hero.page, rival.page);
    await hero.page.waitForLoadState('networkidle').catch(() => undefined);
    await film.beat(1_000);
    await film.roll();
    film.mark('board');
    await film.beat(2_000);

    // Game 1 ends: Nightjar concedes.
    await rival.page.getByTestId('live-concede').click();
    await rival.page.getByTestId('live-concede-yes').click();
    await hero.page.getByTestId('game-result').waitFor({ timeout: 45_000 });
    film.mark('result');
    await film.beat(1_500);
    await rival.page.getByTestId('game-result-rematch').click({ timeout: 15_000 });
    await deliberateClick(hero.page, hero.page.getByTestId('game-result-rematch'), { hover: 500 });
    film.mark('rematch');
    await hero.page.getByTestId('game-result-next').waitFor({ timeout: 20_000 });
    await rival.page.getByTestId('game-result-next').click({ timeout: 20_000 });
    await deliberateClick(hero.page, hero.page.getByTestId('game-result-next'), { hover: 400 });
    const step = hero.page.getByTestId('sideboard-step');
    await step.waitFor({ timeout: 20_000 });
    film.mark('sideboard');
    await film.beat(1_500);

    // Two in from the sideboard first (Ready needs a full main), then two out.
    for (let i = 0; i < 2; i++) {
      await deliberateClick(hero.page, step.getByTestId('side-grid').locator('[data-testid="card"]').first(), { hover: 900 });
      await humanRest(hero.page, 500);
    }
    film.mark('in');
    for (let i = 0; i < 2; i++) {
      await deliberateClick(hero.page, step.getByTestId('main-grid').locator('[data-testid="card"]').last(), { hover: 900 });
      await humanRest(hero.page, 500);
    }
    film.mark('out');
    await film.beat(800);
    await rival.page.getByTestId('sideboard-ready').click({ timeout: 15_000 });
    await deliberateClick(hero.page, hero.page.getByTestId('sideboard-ready'), { hover: 500 });
    film.mark('ready');
    await until('game 2 starts', async () => {
      const id = MATCH_URL.exec(hero.page.url())?.[1];
      return id !== undefined && id !== game1;
    }, 120_000, 300, hero.page);
    await keepBoth(hero.page, rival.page);
    film.mark('game2');
    await film.beat(3_000);
    film.mark('end');
  } finally {
    await film.stop();
    await stack?.stop();
  }
});
