/**
 * The whole walk from a drafted deck to the end of a series, alone in a pod of AI — the operator's
 * own playtest, 2026-11-19 (room `r-866a09a00c52`), and what they said of its first film: *"the game
 * should take you directly to sideboarding after game1. only after a match is over should it take
 * you back to the room"*, and of the table's page, *"why isn't it just an 'enter game' button?"*
 *
 * The room's page is where a player lands before a match and after it, and nothing carries them
 * off it (*"the main room page should be the default landing zone … when your next match is ready
 * it should light up"*). Inside a match the walk stays on the game's own page: a finished game's
 * result, its sideboard step, then one press into the next game (the operator, 2026-11-16 and again
 * 2026-11-19: *"allow players to click to enter the game"*). And a table has ONE way on from the
 * room, read off the room's record (`games/magic/ui/src/screens/tableDoor.ts`), the same on my lit
 * card, on the table's page and after a reload:
 *
 *   1. Play on the built deck goes to the room's page, and I stay there: my own table's card is lit,
 *      no game exists, and nothing moves me, a reload included.
 *   2. My press on the lit card opens my table's page — the face-off — which starts the game and
 *      offers one plain button, Enter game; my press is what opens the board.
 *   3. Game 1 over: the result, whose one way on (Next) is the sideboard step, on the game's own
 *      page — no room page, no table page.
 *   4. Ready makes game 2, which waits behind exactly one Enter game, the same button, still on
 *      the game's own page; my press opens game 2.
 *   5. Once I have been at game 2, every way back from the room says Return to game, and the
 *      sideboard's address goes back to the table.
 *   6. The series over: the result stays until I press, its lit way on is Back to room, and that
 *      is the room's page, where my finished match is no longer lit.
 *
 * `[door-walk]` lines are the evidence, one per step, with the page's layout shift since the step
 * before (`layout-shift` entries without recent input, summed): logged, not yet asserted, until a
 * few runs say what a whole-page load here costs. Dispatched with `video=true`, the recording of
 * this spec is the film of the flow.
 */
import { expect, test, type Page } from '@playwright/test';

import { trimMainDeck } from './deckBuilder.ts';
import { PREFIX } from './identities.ts';
import { draftUntilDone, fillWithAi, readyPod, sitPodAt } from './podSeats.ts';
import { litCard, makeTitled, resizeWindow, roomIdFromAddress, toMyTable } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;
const MATCH_URL = /#\/match\/(m-[0-9a-f]{12})$/;
const say = (line: string): void => console.log(`[door-walk] ${line}`);

/** Sums the page's layout shift since the last call, and starts counting again. */
async function shiftSince(page: Page): Promise<string> {
  const total = await page.evaluate(() => {
    const w = window as unknown as { __shift?: number };
    const was = w.__shift ?? 0;
    w.__shift = 0;
    return was;
  });
  return total.toFixed(3);
}

/** The table's one way on, wherever this page draws it: exactly one, of the kind the room's record says. */
async function expectDoor(page: Page, kind: 'enter' | 'return' | 'sideboard', why: string): Promise<void> {
  await expect(page.locator(`[data-door="${kind}"]`), why).toBeVisible({ timeout: UI_TIMEOUT });
  await expect(page.locator('[data-door]'), `${why}: and it is the only way on`).toHaveCount(1);
}

/** The room's own page, by its address: a path, with no hash (`routeAddress`). */
async function expectOnRoomPage(page: Page, roomId: string, why: string): Promise<void> {
  await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).hash}`, { timeout: UI_TIMEOUT, message: why }).toBe(`${PREFIX}/room/${roomId}`);
  await expect(page.getByTestId('pod-tables'), `${why}: the bracket`).toBeVisible({ timeout: UI_TIMEOUT });
}

/**
 * My own table's card on the room's page: lit, the only one lit, and its way on what the room's record
 * says — a door of `kind`, or (null) a plain link to the table's page, there being no game to enter yet.
 */
async function expectLit(page: Page, kind: 'enter' | 'return' | 'sideboard' | null, why: string): Promise<void> {
  const lit = litCard(page);
  await expect(lit, `${why}: my card is lit, and no other`).toHaveCount(1, { timeout: UI_TIMEOUT });
  const way = lit.getByTestId('pod-tables-play');
  await expect(way, `${why}: one way on`).toHaveCount(1);
  if (kind === null) await expect(way, `${why}: no game yet, so no door: the table’s page`).not.toHaveAttribute('data-door', /.*/, { timeout: UI_TIMEOUT });
  else await expect(way, why).toHaveAttribute('data-door', kind, { timeout: UI_TIMEOUT });
}

test(titled('a drafted deck to a series’ end: Play lands on the room’s page with my table lit; the face-off and one Enter game; game 1 goes to its sideboard step and one Enter game into game 2 on the game’s own page; the series’ end goes back to the room'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(10 * 60_000);

  const stack = await startPlayStack(forge);
  const origin = stack.origin;
  try {
    const alice: Player = await openFriend(browser, 'alice');
    const page = alice.page;
    await alice.context.addInitScript(() => {
      const w = window as unknown as { __shift?: number };
      w.__shift = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
          if (!entry.hadRecentInput) w.__shift = (w.__shift ?? 0) + entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });

    /* ── a pod of one person and seven AI, drafted and built ─────────── */
    await page.goto(`${origin}${PREFIX}/`);
    await submitCreateRoom(page, { name: `e2e door walk ${Date.now()}`, gameType: 'draft' });
    const roomId = await roomIdFromAddress(page);
    const roomBody = (await page.evaluate(
      (id) => fetch(`${window.location.pathname.replace(/(\/room\/[^/]+)?\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()),
      roomId,
    )) as { members: { id: string; name: string }[] };
    const me = roomBody.members.find((m) => m.name === 'e2e-alice');
    if (me === undefined) throw new Error('alice: not found among the room’s own members');
    // `useWhoami()` is how the pod knows which seat is mine; this edge serves no `/session/whoami` (`w72-pod.spec.ts`'s note).
    await alice.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'guest', name: 'e2e-alice' } }));
    await page.reload();
    await resizeWindow(page, { width: 1280, height: 800 });
    await sitPodAt(page, 0);
    await readyPod(page);
    await fillWithAi(page, UI_TIMEOUT);
    await expect(page.getByTestId('pod'), 'the pod is dealt').toBeVisible({ timeout: UI_TIMEOUT });
    await draftUntilDone(page);
    await expect(page.getByTestId('deck-editor'), 'the finished draft opens the editor').toBeVisible({ timeout: UI_TIMEOUT });
    await trimMainDeck(page, 40, 'alice');
    await shiftSince(page);

    /* ── 1. Play: the room's page, my table lit — and nothing moves me ── */
    const roomAddress = `${PREFIX}/room/${roomId}`;
    const board = page.locator('[aria-label="Game board"]');
    await page.getByTestId('play-deck').click();
    await expectOnRoomPage(page, roomId, 'Play lands on the room’s page');
    await expect(page.getByTestId('pod-rounds'), 'round 1 is up').toBeVisible({ timeout: UI_TIMEOUT });
    await expectLit(page, null, 'paired for round 1');
    const tableId = await litCard(page).getAttribute('data-table-id');
    expect(tableId, 'the lit card names its table').toBeTruthy();
    const tableHash = `#/room/${roomId}/table/${tableId}`;
    say(`1. Play → ${roomAddress}: the room's page, my table ${tableId} lit; shift ${await shiftSince(page)}`);
    await page.waitForTimeout(1_500);
    await expectOnRoomPage(page, roomId, '1.5 s on, nothing carried me to my table');
    await expect(page.getByTestId('table-page'), 'no table page').toHaveCount(0);
    await expect(board, 'and no board').toHaveCount(0);
    await expectLit(page, null, 'still lit, still no game');
    await page.reload();
    await expectOnRoomPage(page, roomId, 'a reload leaves me on the room’s page');
    await expectLit(page, null, 'after a reload');
    say(`1. stayed on the room's page for 1.5 s and through a reload: nobody is moved, the card stays lit; shift ${await shiftSince(page)}`);

    /* ── 2. My press on the lit card: the face-off; Enter game, alone, and only my press opens the board ── */
    expect(await toMyTable(page, UI_TIMEOUT), 'no game yet: my card opens my table’s page').toBe('table');
    expect(new URL(page.url()).hash).toBe(tableHash);
    await expect(page.getByTestId('table-page'), 'my table’s page').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(page.getByTestId('table-seats'), 'the face-off').toBeVisible({ timeout: UI_TIMEOUT });
    say(`2. pressed my lit card → ${tableHash}: the face-off; shift ${await shiftSince(page)}`);
    await expectDoor(page, 'enter', 'after the face-off the table offers Enter game');
    await expect(board, 'nothing walked me onto the board').toHaveCount(0);
    expect(new URL(page.url()).hash, 'still on my table’s page').toBe(tableHash);
    await page.reload();
    await expectDoor(page, 'enter', 'a reload changes nothing: I have not been at the game');
    say(`2. Enter game offered, reload included; shift ${await shiftSince(page)}`);
    // The way on is the lobby's own button under the two faces, not a card of the game.
    await expect(page.locator('[data-door="enter"]'), 'Enter game is a plain button').toHaveClass('lobby__go');
    await expect(page.getByTestId('table-game-card'), 'no card of the game on my own table’s page').toHaveCount(0);
    await page.locator('[data-door="enter"]').click();
    await page.waitForURL(MATCH_URL, { timeout: UI_TIMEOUT });
    const game1 = page.url();
    await expect(board, 'my press opened game 1').toBeVisible({ timeout: UI_TIMEOUT });
    say(`2. entered ${new URL(game1).hash}; shift ${await shiftSince(page)}`);

    /* ── 3. Game 1 over: the result, and its one way on is the sideboard step, on the game's own page ── */
    const road: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame.parentFrame() === null) road.push(`${new URL(frame.url()).pathname}${new URL(frame.url()).hash}`);
    });
    /** Every address the page has been on since game 1 that is not a game's. */
    const offRoad = (): string[] => road.filter((at) => !/#\/match\/m-[0-9a-f]{12}$/.test(at));
    await page.getByTestId('live-concede').click();
    await page.getByTestId('live-concede-yes').click();
    await expect(page.getByTestId('game-result'), 'game 1 is over: its result').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(page.getByTestId('game-result-next'), 'the result’s way on').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(page.getByTestId('game-result-rematch'), 'and no other next game').toHaveCount(0);
    await page.waitForTimeout(1_500);
    expect(page.url(), 'the result stays until I press: nothing moved me').toBe(game1);
    await page.getByTestId('game-result-next').click();
    await expect(page.getByTestId('sideboard-step'), 'Next is the sideboard step').toBeVisible({ timeout: UI_TIMEOUT });
    expect(page.url(), 'on the game’s own page').toBe(game1);
    await expect(page.getByTestId('table-page'), 'no table page').toHaveCount(0);
    await expect(page.getByTestId('pod-tables'), 'no room page').toHaveCount(0);
    const step = await page.getByTestId('game-result').boundingBox();
    const viewport = page.viewportSize()!;
    expect(step!.height, 'the step has the whole height under the site’s bar, not a box in a column').toBeGreaterThan(viewport.height * 0.8);
    say(`3. game 1 conceded → result → Next → sideboard step ${Math.round(step!.width)}×${Math.round(step!.height)} of ${viewport.width}×${viewport.height}, still at ${new URL(game1).hash}; shift ${await shiftSince(page)}`);

    /* ── 4. Ready makes game 2, which waits behind exactly one Enter game; my press opens it ── */
    await page.getByTestId('sideboard-ready').click();
    const enter = page.getByTestId('game-result-enter');
    await expect(enter, 'game 2 exists and waits behind Enter game').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(page.locator('[data-door]'), 'one way on, and it is Enter game').toHaveCount(1);
    await expect(enter, 'the same plain button as on my table’s page').toHaveClass('lobby__go');
    await expect(enter).toHaveAttribute('data-door', 'enter');
    await page.waitForTimeout(1_500);
    expect(page.url(), 'nothing walked me into game 2').toBe(game1);
    await expect(page.getByTestId('table-page'), 'no table page').toHaveCount(0);
    await expect(page.getByTestId('pod-tables'), 'no room page').toHaveCount(0);
    say(`4. Ready → game 2 waits behind Enter game, on ${new URL(game1).hash}; shift ${await shiftSince(page)}`);
    await enter.click();
    await page.waitForURL((url) => MATCH_URL.test(url.toString()) && url.toString() !== game1, { timeout: UI_TIMEOUT });
    await expect(board, 'my one press opened game 2').toBeVisible({ timeout: UI_TIMEOUT });
    const game2 = new URL(page.url()).hash;
    expect(offRoad(), 'from game 1 to game 2 the page was only ever on a game’s address: no room page, no table page').toEqual([]);
    await expect(page.getByTestId('table-seats'), 'no face-off between games').toHaveCount(0);
    say(`4. one press → entered ${game2}, road ${JSON.stringify(road)}; shift ${await shiftSince(page)}`);

    /* ── 5. Been at game 2: every way back says Return to game ───────── */
    await page.evaluate((hash) => (window.location.hash = hash), tableHash);
    await expectDoor(page, 'return', 'back on my table’s page: Return to game');
    await expect(page.locator('[data-door="return"]'), 'the same plain button').toHaveClass('lobby__go');
    await expect(page.locator('[data-door="return"]')).toHaveAttribute('href', game2);
    await page.reload();
    await expectDoor(page, 'return', 'and after a reload');
    await page.evaluate((hash) => (window.location.hash = hash), `${tableHash}/sideboard`);
    await expect(page.getByTestId('table-page'), 'the sideboard’s address has no step now: it is the table’s page').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(page.getByTestId('table-sideboard')).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe(tableHash);
    await page.getByTestId('table-hub').click();
    await expectOnRoomPage(page, roomId, 'the room’s page, mid-game');
    await expectLit(page, 'return', 'my card says Return to game');
    expect(await toMyTable(page, UI_TIMEOUT), 'my lit card is my game').toBe('game');
    await expect(board, 'back in game 2').toBeVisible({ timeout: UI_TIMEOUT });
    expect(new URL(page.url()).hash).toBe(game2);
    say(`5. Return to game on the table page, after a reload, and on my lit card; shift ${await shiftSince(page)}`);

    /* ── 6. The series over, 0–2: the result stays, its lit way on is Back to room, and that is the room's page ── */
    await page.getByTestId('live-concede').click();
    await page.getByTestId('live-concede-yes').click();
    await expect(page.getByTestId('game-result'), 'game 2 is over, and the series with it').toBeVisible({ timeout: UI_TIMEOUT });
    await page.waitForTimeout(1_500);
    const landed = `${new URL(page.url()).pathname}${new URL(page.url()).hash}`;
    const offered = await page.locator('[data-testid="game-result"] button').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
    say(`6. series over: 1.5 s on I am at ${landed} (${landed === roomAddress ? 'the room’s page, by itself' : 'not moved to the room’s page'}); the result screen offers ${JSON.stringify(offered)}; shift ${await shiftSince(page)}`);
    await expect(page.getByTestId('game-result-next'), 'a decided series has no next game').toHaveCount(0);
    expect(new URL(page.url()).hash, 'the result of the match stays until I press').toBe(game2);
    await expect(page.getByTestId('game-result-room'), 'Back to room is the lit way on').toHaveAttribute('data-highlight', 'true');
    await expect(page.locator('[data-testid="game-result"] button[data-highlight]'), 'and the only one lit').toHaveCount(1);
    await page.getByTestId('game-result-room').click();
    await expectOnRoomPage(page, roomId, 'after the series, the room’s page');
    await expect(page.locator('[data-testid="pod-tables-row"][data-phase="done"][data-mine]'), 'my finished match is on the bracket').toHaveCount(1, { timeout: UI_TIMEOUT });
    await expect(page.locator('[data-testid="pod-tables-row"][data-phase="done"][data-call]'), 'a finished match has no way on, so it is not lit').toHaveCount(0);
    say(`6. the room's page after the series: ${await litCard(page).count()} card(s) lit; shift ${await shiftSince(page)}`);
  } finally {
    // `stack.stop()` closes the context and keeps its video (`play/harness.ts`).
    await stack.stop();
  }
});
