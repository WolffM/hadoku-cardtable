/**
 * The operator, 2026-10-29: *"games that are in-progress for >8hrs should be forced into a draw and
 * players sent back to the lobby"* — "every game", and back to "their room", with the result shown.
 *
 * Two real browsers, a real Forge match. The room sweep runs on a clock eight hours and a minute
 * past the match's start (`POST /api/play/sweep`, behind `CARDTABLE_PLAY_PROBE` like play's other
 * probes): Forge ends the game as a draw. Both seats see a Draw, with why; both go back to the room
 * the match came from; and the room's table records a drawn game. The room is not swept with it:
 * the draw is the room's activity.
 *
 * `[w82]` lines are the evidence; each seat's result screen is attached as a still.
 */
import { expect, test } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { enterMatch } from './play/enter.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const PREFIX = '/cardtable';
const EIGHT_HOURS_ON = 8 * 60 * 60_000 + 60_000;
const ROOM_URL = /#\/room\/(r-[0-9a-f]{12})$/;

const result = (f: Friend) => f.page.getByTestId('game-result');

test(titled('a game eight hours in is called a draw: both seats see why, go back to their room, and the table records a drawn game'), async ({ browser }, testInfo) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { matchId, roomUrl } = await enterMatch(alice, bob, stack.origin);
    const roomId = ROOM_URL.exec(roomUrl)?.[1];
    expect(roomId, 'the room the match came from').toBeDefined();

    const swept = await alice.context.request.post(`${stack.origin}${PREFIX}/api/play/sweep`, { data: { aheadMs: EIGHT_HOURS_ON } });
    expect(swept.status(), 'the sweep ran').toBe(204);

    for (const f of [alice, bob]) {
      await expect(result(f), `${f.name}'s result screen`).toBeVisible({ timeout: 45_000 });
      await expect(result(f), `${f.name} sees a draw`).toHaveAttribute('data-result', 'draw');
      await expect(result(f).locator('.live__result-ending'), `${f.name} is told why`).toHaveText('The game ran for 8 hours and ended in a draw');
      const still = testInfo.outputPath(`${f.name}-forced-draw.png`);
      await f.page.screenshot({ path: still });
      await testInfo.attach(`${f.name}-forced-draw.png`, { path: still, contentType: 'image/png' });
      console.log(`[w82] ${f.name}: ${await result(f).locator('.confirm__title').textContent()} — ${await result(f).locator('.live__result-ending').textContent()}`);
    }

    for (const f of [alice, bob]) {
      await result(f).getByTestId('game-result-room').click();
      await expect(f.page, `${f.name} is back in the room the match came from`).toHaveURL(roomUrl, { timeout: 15_000 });
      await expect(f.page.getByTestId('constructed')).toBeVisible({ timeout: 15_000 });
    }

    const room = await alice.context.request.get(`${stack.origin}${PREFIX}/api/rooms/${roomId}`);
    expect(room.ok(), 'the room is still there').toBe(true);
    const body = (await room.json()) as { tables: { matchId: string | null; series: { games: { matchId: string; winner: number | null }[] } }[] };
    console.log(`[w82] room ${roomId} after the draw: ${JSON.stringify(body.tables[0])}`);
    expect(body.tables[0]?.matchId, 'no game in play').toBeNull();
    expect(body.tables[0]?.series.games, 'the table records a drawn game').toEqual([{ matchId, winner: null }]);
  } finally {
    await stack.stop();
  }
});
