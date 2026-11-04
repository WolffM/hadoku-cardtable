/**
 * Clip: the Gauntlet between two people (the operator: "two people, not a player against Sage"). The hero
 * Ashgrove (Fern) and Nightjar (Himmel) sit, both ready, ten decks of one era are revealed, they ban and
 * pick in a snake, each secretly chooses an opening deck, and game 1's board comes up. Nightjar's seat is
 * headless and the driver presses its bans, picks and choice over the room's own HTTP, at a person's pace.
 * No AI seat anywhere in the clip. The operator (cut 5): "generally too slow … we can go through it
 * quickly", so both seats act at one brisk, even pace: a short look at the hero's deck, a short think for
 * Nightjar.
 */
import { test, type Locator, type Page } from '@playwright/test';

import type { GauntletView } from '../../packages/shared/src/gauntlet.ts';
import { says } from '../play/board.ts';
import { confirmYes } from '../play/confirm.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from '../play/harness.ts';
import { deliberateClick, humanMove, humanRest, pressIfThere, until } from './drive.ts';
import { HERO, openPromoFriend, RIVAL, startFilm } from './rig.ts';

const PREFIX = '/cardtable';

/** Hover the tile (its decklist opens beside it), rest, then press it, and move off it. */
async function considerAndPress(page: Page, tile: Locator, restMs: number): Promise<void> {
  const box = await tile.boundingBox();
  if (box === null) return;
  await humanMove(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 0.7);
  await humanRest(page, restMs);
  // The deck's peek can open over its own tile near the board's edge, so the press goes to the tile itself.
  await tile.evaluate((el) => (el as HTMLElement).click());
  await humanMove(page, { x: 60, y: box.y + box.height / 2 }, 0.6);
}

test('gauntlet: two people reveal, ban and pick, choose', async ({ browser }) => {
  const forge = forgeAvailability();
  if (!forge.ok) throw new Error(forge.reason);
  const film = await startFilm('gauntlet');
  let stack: PlayStack | undefined;
  try {
    stack = await startPlayStack(forge);
    const hero = await openPromoFriend(film.hero, HERO);
    const rival = await openPromoFriend(browser, RIVAL);
    const page = hero.page;
    const made = await hero.context.request.post(`${stack.origin}${PREFIX}/api/rooms`, {
      data: { name: 'Modern Gauntlet', gameType: 'constructed-1v1', mode: 'gauntlet', modeOptions: { family: 'modern' }, clientMode: 'builtin' },
    });
    if (!made.ok()) throw new Error(`promo: POST /api/rooms ${made.status()} ${await made.text()}`);
    const roomId = ((await made.json()) as { id: string }).id;
    const roomUrl = `${stack.origin}${PREFIX}/#/room/${roomId}`;
    const api = `${stack.origin}${PREFIX}/api/tables/rooms/${roomId}`;
    const rivalCall = async (path: string, data: unknown): Promise<GauntletView> => {
      const res = await rival.context.request.post(`${api}${path}`, { data });
      if (!res.ok()) throw new Error(`promo: rival ${path} ${res.status()} ${await res.text()}`);
      return (await res.json()) as GauntletView;
    };
    const view = async (): Promise<GauntletView> => (await (await rival.context.request.get(`${api}/gauntlet`)).json()) as GauntletView;

    if (!(await rival.context.request.post(`${stack.origin}${PREFIX}/api/rooms/${roomId}/join`, { data: {} })).ok()) throw new Error('promo: rival join refused');
    // The rival's page asserts its avatar to the room, and later follows the room into the match.
    await rival.page.goto(roomUrl);
    await page.goto(roomUrl);
    await page.getByTestId('constructed').waitFor({ timeout: 30_000 });
    for (const f of [hero, rival]) if (!(await f.context.request.post(`${api}/sit`, { data: {} })).ok()) throw new Error(`promo: ${f.name} sit refused`);
    await rivalCall('/gauntlet/ready', { ready: true });
    await page.getByTestId('ready-toggle').waitFor({ timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await film.beat(1_500);
    await film.roll();
    film.mark('room');
    await film.beat(1_500);

    film.mark('ready');
    await deliberateClick(page, page.getByTestId('ready-toggle'), { hover: 500 });
    await page.getByTestId('gauntlet-pool').getByTestId('gauntlet-deck').nth(9).waitFor({ timeout: 30_000 });
    film.mark('revealed');
    await until('the deal has landed', async () => (await page.getByTestId('gauntlet').getAttribute('data-revealing')) === null, 30_000);
    await film.beat(1_500);

    // The snake: the hero acts on their own turns on camera; Nightjar thinks for a moment and acts on theirs.
    film.mark('snake');
    const banner = page.getByTestId('gauntlet-turn');
    let mine = 0;
    let theirs = 0;
    let rivalDue = 0;
    await until('the choose screen', async () => {
      if ((await page.getByTestId('gauntlet-choose-mine').count()) > 0) return true;
      const v = await view();
      if (v.phase !== 'banpick' || v.step === null) return false;
      // `you` is the rival's own seat: the view is read with the rival's cookie.
      if (v.step.seat === v.you) {
        if (rivalDue === 0) rivalDue = Date.now() + 500 + ((theirs * 397) % 300);
        if (Date.now() < rivalDue) return false;
        rivalDue = 0;
        const open = v.decks.filter((d) => d.status === 'open');
        const deck = open[(theirs * 3 + 1) % open.length]!;
        console.log(`[promo:gauntlet] Nightjar ${v.step.act}s ${deck.name}`);
        // Every act is marked, so the edit can show each ban and pick at real speed and cut only the waits.
        theirs += 1;
        film.mark(`act-${mine + theirs}-rival`);
        await rivalCall('/gauntlet/act', { act: v.step.act, deck: deck.id });
        return false;
      }
      if ((await banner.count()) === 0 || (await banner.getAttribute('data-you')) !== 'true') return false;
      const open = page.getByTestId('gauntlet-pool').locator('[data-testid="gauntlet-deck"][data-status="open"]:enabled');
      const n = await open.count();
      if (n === 0) return false;
      mine += 1;
      console.log(`[promo:gauntlet] Ashgrove act ${mine}: ${(await banner.textContent())?.trim()}`);
      film.mark(`act-${mine + theirs}-hero`);
      await considerAndPress(page, open.nth((mine * 2) % n), mine === 1 ? 700 : 450);
      if (mine === 1) film.mark('banned');
      return false;
    }, 180_000, 100);
    film.mark('choose');
    await film.beat(900);
    const v = await view();
    const rivalDeck = v.decks.find((d) => d.status === 'picked' && d.by === v.you && !d.played);
    if (rivalDeck === undefined) throw new Error(`promo: Nightjar has no deck to choose: ${JSON.stringify(v.decks)}`);
    await rivalCall('/gauntlet/choose', { deck: rivalDeck.id });
    await film.beat(500);
    const myTile = page.getByTestId('gauntlet-choose-mine').locator('[data-testid="gauntlet-deck"]:not([data-played])').first();
    await considerAndPress(page, myTile, 700);
    film.mark('chosen');

    // The match: both seats keep, the hero at a person's pace.
    await until('both hands are kept', async () => {
      for (const p of [page, rival.page]) {
        const text = await says(p);
        if (/play or draw/i.test(text)) await pressIfThere(p.getByTestId('live-play-or-draw-play'));
        else if (/keep your hand/i.test(text)) {
          if (p === page) await page.waitForTimeout(700);
          await pressIfThere(confirmYes(p));
        } else if (/return \d+ card/i.test(text)) await pressIfThere(p.locator('[data-testid="live-decision-ok"]:enabled'));
      }
      return (await page.locator('[aria-label="Game board"]').count()) > 0 && /^(Priority|Waiting)/.test(await says(page));
    }, 120_000, 300, page);
    film.mark('board');
    await film.beat(2_500);
    film.mark('end');
  } finally {
    await film.stop();
    await stack?.stop();
  }
});
