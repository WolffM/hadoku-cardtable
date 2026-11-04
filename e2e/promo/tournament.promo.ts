/**
 * Clip: a Swiss tournament, filmed from a player who is NOT the room's leader (the operator: "from a
 * non-manager perspective so we dont get the extra management buttons"). Vexmoor makes the room and
 * runs it; the hero Ashgrove joins, sits and readies like anyone else. Eight entrants: four friends and
 * four AI, seated so round 1 (`@hadoku/draft`'s `round1`: seat i plays seat i + 4) pairs Ashgrove with
 * Nightjar, two people, and Vexmoor with Lumen; the AI play each other. The field locks and pairs, the
 * hero is carried to their table where the face-off rushes in, and the hub shows the round's bracket.
 */
import { test, type Locator, type Page } from '@playwright/test';

import { forgeAvailability, startPlayStack, type PlayStack } from '../play/harness.ts';
import { deliberateClick, humanMove, until } from './drive.ts';
import { HERO, openPromoFriend, RIVAL, startFilm } from './rig.ts';

const PREFIX = '/cardtable';
/** Round 1 pairs seat i with seat i + 4: the hero (0) with Nightjar (4), Vexmoor (1) with Lumen (5). */
const SEATS: Record<string, number> = { [HERO]: 0, vexmoor: 1, [RIVAL]: 4, lumen: 5 };
const AI_SEATS = [2, 3, 6, 7];

/** A hand on the wheel: small notches down until `target` is wholly in view (a jump cut reads as a glitch). */
async function wheelTo(page: Page, target: Locator): Promise<void> {
  for (let n = 0; n < 40; n++) {
    const box = await target.boundingBox();
    if (box === null || box.y + Math.min(box.height, 700) <= 1040) return;
    await page.mouse.wheel(0, 90);
    await page.waitForTimeout(70);
  }
}

test('tournament: eight entrants, the field pairs', async ({ browser }) => {
  const forge = forgeAvailability();
  if (!forge.ok) throw new Error(forge.reason);
  const film = await startFilm('tournament');
  let stack: PlayStack | undefined;
  try {
    stack = await startPlayStack(forge);
    const base = `${stack.origin}${PREFIX}/api`;
    const hero = await openPromoFriend(film.hero, HERO);
    const leader = await openPromoFriend(browser, 'vexmoor');
    const friends = [hero, leader, await openPromoFriend(browser, RIVAL), await openPromoFriend(browser, 'lumen')];
    const call = async (f: (typeof friends)[number], method: 'POST' | 'PATCH', path: string, data: unknown): Promise<unknown> => {
      const res = await f.context.request.fetch(`${base}${path}`, { method, data });
      if (!res.ok()) throw new Error(`promo: ${f.name} ${method} ${path} ${res.status()} ${await res.text()}`);
      return res.json();
    };
    const { id: roomId } = (await call(leader, 'POST', '/rooms', { name: 'Saturday Swiss — Modern Gauntlet', gameType: 'constructed-1v1', mode: 'gauntlet', modeOptions: { family: 'modern' }, clientMode: 'builtin' })) as { id: string };
    await call(leader, 'PATCH', `/rooms/${roomId}`, { settings: { tournament: true, tournamentDecks: 'per-round' } });
    const roomUrl = `${stack.origin}${PREFIX}/#/room/${roomId}`;
    for (const f of friends) if (f !== leader) await call(f, 'POST', `/rooms/${roomId}/join`, {});
    for (const f of friends) await f.page.goto(roomUrl);
    await hero.page.getByTestId('constructed').waitFor({ timeout: 30_000 });
    await hero.page.waitForLoadState('networkidle').catch(() => undefined);
    await film.beat(1_500);
    await film.roll();
    film.mark('lobby');
    await film.beat(1_200);

    // The field fills in on camera: the friends sit, then the leader seats the AI.
    film.mark('seats');
    for (const f of friends) {
      await call(f, 'POST', `/rooms/${roomId}/pod/sit`, { seat: SEATS[f.name]! });
      await film.beat(450);
    }
    for (const seat of AI_SEATS) {
      await call(leader, 'POST', `/rooms/${roomId}/pod/ai`, { seat, on: true });
      await film.beat(300);
    }
    await film.beat(1_000);
    for (const f of friends) if (f !== hero) await call(f, 'POST', `/rooms/${roomId}/ready`, { ready: true });
    await film.beat(800);

    film.mark('ready');
    await deliberateClick(hero.page, hero.page.getByTestId('ready-toggle'), { hover: 500 });
    await hero.page.getByTestId('table-page').waitFor({ timeout: 30_000 });
    film.mark('paired');
    await hero.page.getByTestId('table-seats').waitFor({ timeout: 30_000 });
    // The face-off: the two avatars rush in from the page's edges and clash (`FaceOff.tsx`'s REVEAL_MS ≈ 1.4 s).
    film.mark('faceoff');
    await film.beat(3_500);

    film.mark('bracket');
    await deliberateClick(hero.page, hero.page.getByTestId('table-hub'), { hover: 400 });
    await hero.page.getByTestId('pod-tables').waitFor({ timeout: 30_000 });
    await film.beat(4_000);
    film.mark('end');
  } finally {
    await film.stop();
    await stack?.stop();
  }
});

/**
 * Clip: the end of a tournament. The seeded "Testing: Tournament — finished (8 players)" room
 * (`apps/server/room/testing-rooms.ts`, admin-only) opened from the front page: the podium rises, then a
 * slow look down the Swiss bracket to the FINAL, the winner's path lit by a press, and the standings.
 */
test('tournament: the podium', async ({ browser }) => {
  const forge = forgeAvailability();
  if (!forge.ok) throw new Error(forge.reason);
  const film = await startFilm('podium');
  let stack: PlayStack | undefined;
  try {
    stack = await startPlayStack(forge);
    const hero = await openPromoFriend(film.hero, 'admin');
    const page = hero.page;
    const row = page.getByTestId('room-row').filter({ has: page.getByTestId('room-name').getByText('Testing: Tournament — finished (8 players)', { exact: true }) });
    await until('the finished tournament is listed', async () => {
      await page.goto(`${stack!.origin}${PREFIX}/`);
      return row.isVisible({ timeout: 5_000 }).catch(() => false);
    }, 90_000, 1_000);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await film.beat(1_000);
    await film.roll();
    film.mark('list');
    await film.beat(800);
    await deliberateClick(page, row.getByTestId('room-enter'), { hover: 500 });
    await page.getByTestId('pod-podium').waitFor({ timeout: 30_000 });
    film.mark('podium');
    await humanMove(page, { x: 1700, y: 300 });
    await film.beat(4_500);

    film.mark('bracket');
    await wheelTo(page, page.getByTestId('pod-bracket-final'));
    await film.beat(1_500);
    const winner = page.locator('[data-testid="pod-final-row"][data-place="1"]');
    film.mark('path');
    await deliberateClick(page, winner, { hover: 500 });
    await film.beat(3_000);
    film.mark('standings');
    await wheelTo(page, page.getByTestId('pod-standings'));
    await film.beat(3_000);
    film.mark('end');
  } finally {
    await film.stop();
    await stack?.stop();
  }
});
