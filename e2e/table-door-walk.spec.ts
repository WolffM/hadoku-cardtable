/**
 * The whole walk between a drafted deck and a series' second game, alone in a pod of AI — the
 * operator's own playtest, 2026-11-19 (room `r-866a09a00c52`), and what they asked to be shown end to
 * end: *"ending game, sideboarding (leave room and come back), enter game again to do sideboarding
 * and start next game"*.
 *
 * What each step pins is two rules. The room's page is where everything lands, and nothing carries a
 * player off it (the operator, 2026-11-19: *"the main room page should be the default landing zone for
 * whenever things are done. after building and after finishing a match it would be nice to go back
 * there. then when your next match is ready it should light up"*). And a table has ONE way on, read off
 * the room's record (`games/magic/ui/src/screens/tableDoor.ts`), so it is the same on my lit card, on the
 * table's page, after a reload and by any road:
 *
 *   1. Play on the built deck goes to the room's page, and I stay there: my own table's card is lit,
 *      no game exists, and nothing moves me, a reload included.
 *   2. My press on the lit card opens my table's page — the face-off — which starts the game and
 *      offers Enter game, alone; my press is what opens the board.
 *   3. Game 1 over: Next opens the sideboard step. Leaving it for the room, my card is lit and says
 *      Sideboard, and so does my table's page, which holds no sideboard of its own.
 *   4. My lit card opens the sideboard: its own full screen, with nothing of the room around it.
 *      Ready there makes game 2, which waits behind Enter game — still after a reload, on the table's
 *      page, and on my lit card, whose press is the game itself.
 *   5. Once I have been at game 2, every way back says Return to game, and the sideboard's address
 *      goes back to the table.
 *   6. The series over: where the result screen leaves me is logged, and Back to room is the room's page.
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

test(titled('a drafted deck to a series’ end: Play lands on the room’s page with my table lit and nothing moves me; one way on at every step, by every road, after a reload'), async ({ browser }) => {
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
    await page.locator('[data-door="enter"]').click();
    await page.waitForURL(MATCH_URL, { timeout: UI_TIMEOUT });
    const game1 = page.url();
    await expect(board, 'my press opened game 1').toBeVisible({ timeout: UI_TIMEOUT });
    say(`2. entered ${new URL(game1).hash}; shift ${await shiftSince(page)}`);

    /* ── 3. Game 1 over: Next, the sideboard; leave it for the room, and my lit card and my table's page both say Sideboard ── */
    await page.getByTestId('live-concede').click();
    await page.getByTestId('live-concede-yes').click();
    await expect(page.getByTestId('game-result'), 'game 1 is over').toBeVisible({ timeout: UI_TIMEOUT });
    await page.getByTestId('game-result-next').click({ timeout: UI_TIMEOUT });
    await expect(page.getByTestId('sideboard-step'), 'Next opens the sideboard step').toBeVisible({ timeout: UI_TIMEOUT });
    say(`3. game 1 conceded, sideboard open on the result screen; shift ${await shiftSince(page)}`);
    await page.getByTestId('game-result-room').click();
    await expectOnRoomPage(page, roomId, 'Back to room is the room’s page');
    await expectLit(page, 'sideboard', 'between games my card says Sideboard');
    say(`3. left to the room's page: my card is lit and says Sideboard; shift ${await shiftSince(page)}`);
    await page.evaluate((hash) => (window.location.hash = hash), tableHash);
    await expect(page.getByTestId('table-page'), 'my table’s page').toBeVisible({ timeout: UI_TIMEOUT });
    await expectDoor(page, 'sideboard', 'between games my table’s page offers Sideboard');
    await expect(page.getByTestId('table-sideboard'), 'the table’s page holds no sideboard of its own').toHaveCount(0);
    await expect(page.getByTestId('game-result'), 'nor any panel over it').toHaveCount(0);
    say(`3. table page: one door, Sideboard; shift ${await shiftSince(page)}`);
    await page.getByTestId('table-hub').click();
    await expectOnRoomPage(page, roomId, 'the table’s back arrow is the room’s page');
    await expectLit(page, 'sideboard', 'back on the room’s page');

    /* ── 4. My lit card: the sideboard, its own full screen; Ready makes game 2, which waits for my press ── */
    expect(await toMyTable(page, UI_TIMEOUT), 'my lit card is the sideboard step itself').toBe('sideboard');
    await expect(page.getByTestId('table-sideboard-page'), 'the sideboard is its own screen').toBeVisible({ timeout: UI_TIMEOUT });
    expect(new URL(page.url()).hash).toBe(`${tableHash}/sideboard`);
    await expect(page.getByTestId('sideboard-step')).toBeVisible({ timeout: UI_TIMEOUT });
    await expect(page.getByTestId('table-page'), 'nothing of the table’s page is around it').toHaveCount(0);
    const step = await page.getByTestId('table-sideboard').boundingBox();
    const viewport = page.viewportSize()!;
    expect(step!.height, 'the step has the whole height under the site’s bar, not a box in a column').toBeGreaterThan(viewport.height * 0.8);
    say(`4. pressed my lit card → sideboard screen ${Math.round(step!.width)}×${Math.round(step!.height)} of ${viewport.width}×${viewport.height}; shift ${await shiftSince(page)}`);
    await page.getByTestId('sideboard-ready').click();
    await expect(page.getByTestId('game-result-enter'), 'game 2 exists and waits behind Enter game').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(board, 'nothing walked me into game 2').toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('game-result-enter'), 'a reload keeps the step: the room’s record says I have not been at game 2').toBeVisible({ timeout: UI_TIMEOUT });
    expect(new URL(page.url()).hash).toBe(`${tableHash}/sideboard`);
    await page.evaluate((hash) => (window.location.hash = hash), tableHash);
    await expectDoor(page, 'enter', 'from my table’s page the same game is the same press');
    await expect(page.getByTestId('game-result-enter'), 'one way on, not a card and a panel').toHaveCount(0);
    await page.getByTestId('table-hub').click();
    await expectOnRoomPage(page, roomId, 'the room’s page, game 2 waiting');
    await expectLit(page, 'enter', 'game 2 is up and I have not been at it: my card says Enter game');
    await page.waitForTimeout(1_500);
    await expectOnRoomPage(page, roomId, 'a waiting game moves nobody either');
    await expect(board, 'nothing walked me into game 2 from the room’s page').toHaveCount(0);
    say(`4. game 2 waits: Enter game on the step, after a reload, on the table page, and on my lit card, which moved me nowhere in 1.5 s; shift ${await shiftSince(page)}`);
    expect(await toMyTable(page, UI_TIMEOUT), 'a game is up: my lit card is the game itself').toBe('game');
    await page.waitForURL((url) => MATCH_URL.test(url.toString()) && url.toString() !== game1, { timeout: UI_TIMEOUT });
    await expect(board, 'my press opened game 2').toBeVisible({ timeout: UI_TIMEOUT });
    const game2 = new URL(page.url()).hash;
    say(`4. pressed my lit card → entered ${game2}; shift ${await shiftSince(page)}`);

    /* ── 5. Been at game 2: every way back says Return to game ───────── */
    await page.evaluate((hash) => (window.location.hash = hash), tableHash);
    await expectDoor(page, 'return', 'back on my table’s page: Return to game');
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

    /* ── 6. The series over, 0–2: where the result screen leaves me, and Back to room ── */
    await page.getByTestId('live-concede').click();
    await page.getByTestId('live-concede-yes').click();
    await expect(page.getByTestId('game-result'), 'game 2 is over, and the series with it').toBeVisible({ timeout: UI_TIMEOUT });
    await page.waitForTimeout(1_500);
    const landed = `${new URL(page.url()).pathname}${new URL(page.url()).hash}`;
    const offered = await page.locator('[data-testid="game-result"] button').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
    say(`6. series over: 1.5 s on I am at ${landed} (${landed === roomAddress ? 'the room’s page, by itself' : 'not moved to the room’s page'}); the result screen offers ${JSON.stringify(offered)}; shift ${await shiftSince(page)}`);
    await expect(page.getByTestId('game-result-next'), 'a decided series has no next game').toHaveCount(0);
    if (landed !== roomAddress) await page.getByTestId('game-result-room').click();
    await expectOnRoomPage(page, roomId, 'after the series, the room’s page');
    await expect(page.locator('[data-testid="pod-tables-row"][data-phase="done"][data-mine]'), 'my finished match is on the bracket').toHaveCount(1, { timeout: UI_TIMEOUT });
    await expect(page.locator('[data-testid="pod-tables-row"][data-phase="done"][data-call]'), 'a finished match has no way on, so it is not lit').toHaveCount(0);
    say(`6. the room's page after the series: ${await litCard(page).count()} card(s) lit; shift ${await shiftSince(page)}`);
  } finally {
    // `stack.stop()` closes the context and keeps its video (`play/harness.ts`).
    await stack.stop();
  }
});
