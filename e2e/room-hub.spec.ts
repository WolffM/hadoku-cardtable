/**
 * A tournament's rounds are a hub, and each match a table page inside the room
 * (ruling 8, `docs/planning/tournament-mode-plan.md`; the operator, 2026-10-23:
 * *"in the top level lobby room i would prefer to just show standings and links
 * to the open rooms. then players can enter their game rooms and perform the
 * game room actions there"*).
 *
 * Alice and Bob play a locked-deck Classic tournament; Carol is in the room and
 * never sits. Round 1 pairs Alice and Bob: each stays on the hub, their own
 * table's card lit, and nothing carries them anywhere (the operator, 2026-11-19:
 * *"the main room page should be the default landing zone … when your next match
 * is ready it should light up"*). Alice's press on her card opens
 * `#/room/<id>/table/<t>`, which starts the game and offers Enter game; Bob's
 * card is by then the game itself, or the same table page. Carol opens the hub
 * and watches theirs through its card. Alice goes back to the hub and stays
 * there. Bob concedes twice; the sideboard step between the games is its own
 * screen; the round settles and the hub's standings show Alice first.
 *
 * Every page records each address it is on, so "nobody was moved" is read off
 * the page's own history and not off where it happens to be when asked.
 */
import { expect, test, type Page } from '@playwright/test';
import { sitPodAt } from './podSeats.ts';

import { PREFIX } from './identities.ts';
import { door, enterFromTablePage, litCard, makeTitled, pressIntoGame2, ROOM_PAGE, toMyTable, resizeWindow, roomIdFromAddress } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';
import { pickRadio } from './click-trail.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;
const matchUrl = /#\/match\/(m-[0-9a-f]{12})$/;
const tableHash = /#\/room\/r-[0-9a-f]+\/table\/(t-[0-9a-f]+)$/;

/** Every hash this page has been on since the recorder went in. */
async function hashes(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __hashes?: string[] }).__hashes ?? []);
}

async function recordHashes(p: Player): Promise<void> {
  await p.context.addInitScript(() => {
    const w = window as unknown as { __hashes: string[] };
    // Every address the page is on: a room's own page is a path, the rest are hashes, and the app
    // moves with history.pushState, which fires no event.
    const seen = (): void => void w.__hashes.push(`${location.pathname}${location.hash}`);
    w.__hashes = [];
    seen();
    for (const method of ['pushState', 'replaceState'] as const) {
      const real = history[method].bind(history);
      history[method] = (...args: Parameters<History['pushState']>) => {
        real(...args);
        seen();
      };
    }
    addEventListener('hashchange', seen);
    addEventListener('popstate', seen);
  });
}

/** `/session/whoami` answers with this member's own id (`tournament.spec.ts`'s own fix), then a reload. */
async function routeRealIdentity(p: Player, roomId: string): Promise<void> {
  const roomBody = (await p.page.evaluate(
    (id) => fetch(`${window.location.pathname.replace(/(\/room\/[^/]+)?\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()),
    roomId,
  )) as { members: { id: string; name: string }[] };
  const me = roomBody.members.find((m) => m.name === `e2e-${p.name}`);
  if (me === undefined) throw new Error(`${p.name}: not found among the room’s own members`);
  await p.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'guest', name: `e2e-${p.name}` } }));
  await p.page.reload();
  await resizeWindow(p.page, { width: 1280, height: 800 });
}

async function sitPickReady(p: Player, seat: number): Promise<void> {
  await sitPodAt(p.page, seat);
  await expect(p.page.getByTestId('seat-stand'), `${p.name}: holds a pod seat`).toBeVisible({ timeout: UI_TIMEOUT });
  await p.page.getByTestId('deck-mine').getByTestId('deck-option').first().click();
  await expect(p.page.getByTestId('ready-toggle'), `${p.name}: a legal deck enables Ready`).toBeEnabled({ timeout: UI_TIMEOUT });
  await p.page.getByTestId('ready-toggle').click();
}

async function concedeToResult(loser: Player, winner: Player): Promise<void> {
  await loser.page.getByTestId('live-concede').click();
  await loser.page.getByTestId('live-concede-yes').click();
  await expect(winner.page.getByTestId('game-result')).toBeVisible({ timeout: UI_TIMEOUT });
}

test(
  titled('a tournament’s rounds are a hub of match links; each match is a table page that starts the game and offers the one way into it, and the hub keeps whoever goes back to it'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);

    const stack = await startPlayStack(forge);
    try {
      const alice = await openFriend(browser, 'alice');
      const bob = await openFriend(browser, 'bob');
      const carol = await openFriend(browser, 'carol');
      for (const p of [alice, bob, carol]) await recordHashes(p);
      await alice.page.goto(`${stack.origin}${PREFIX}/`);
      await submitCreateRoom(alice.page, { name: `e2e room hub ${Date.now()}`, gameType: 'constructed-1v1', mode: 'classic' });
      const roomId = await roomIdFromAddress(alice.page);
      const roomUrl = `${stack.origin}${PREFIX}/#/room/${roomId}`;
      for (const p of [bob, carol]) {
        await p.page.goto(roomUrl);
        await expect(p.page.getByTestId('constructed'), `${p.name}: joined the room`).toBeVisible({ timeout: UI_TIMEOUT });
      }
      for (const p of [alice, bob, carol]) await routeRealIdentity(p, roomId);

      // A controlled radio: click, then wait for the room to say so.
      await pickRadio(alice.page, 'room-event-tournament', 'the app took the choice');
      for (const p of [alice, bob]) await expect(p.page.getByTestId('tournament-lobby'), `${p.name}: the pod lobby`).toBeVisible({ timeout: UI_TIMEOUT });
      await sitPickReady(alice, 0);
      await sitPickReady(bob, 1);

      /* ── paired: each player stays on the hub, their own table lit; the table page and Enter game are their own presses ── */
      const tablesOf = () => Promise.all([alice, bob].map(async (p) => (await hashes(p.page)).map((h) => tableHash.exec(h)?.[1]).filter((t) => t !== undefined)));
      for (const p of [alice, bob]) await expect(litCard(p.page), `${p.name}: their own table is lit on the hub`).toHaveCount(1, { timeout: UI_TIMEOUT });
      await alice.page.waitForTimeout(1_500);
      expect(await tablesOf(), 'paired, and neither page has been on a table page: nobody is carried').toEqual([[], []]);
      for (const p of [alice, bob]) await expect(p.page, `${p.name}: still on the hub`).toHaveURL(ROOM_PAGE);
      const tableId = (await litCard(alice.page).getAttribute('data-table-id'))!;
      expect(await litCard(bob.page).getAttribute('data-table-id'), 'bob’s lit card is the same table').toBe(tableId);
      // No game exists until both players are at the table (the second to arrive starts it): alice's card
      // opens its page, and there she waits on bob, who is still on the hub with his own card lit.
      expect(await toMyTable(alice.page, UI_TIMEOUT), 'alice: her card opens her table’s page').toBe('table');
      await expect(alice.page.getByTestId('table-status-waiting'), 'alice: first at the table, she is told who it waits on').toContainText('e2e-bob', { timeout: UI_TIMEOUT });
      await expect(door(alice.page), 'alice: no game yet, so no way in').toHaveCount(0);
      await expect(litCard(bob.page), 'bob: still on the hub, his card still lit').toHaveCount(1);
      await expect(bob.page, 'bob: alice’s press moved nobody but her').toHaveURL(ROOM_PAGE);
      // Bob's press brings him to the same page, which starts the game; Enter game is each one's own press.
      expect(await toMyTable(bob.page, UI_TIMEOUT), 'bob: his card opens the same table’s page').toBe('table');
      for (const p of [alice, bob]) await enterFromTablePage(p.page, matchUrl, UI_TIMEOUT);
      const passed = await tablesOf();
      console.log(`[room-hub] table pages passed through: alice=${JSON.stringify(passed[0])} bob=${JSON.stringify(passed[1])}`);
      // One visit can be two addresses (the link's hash on the room's path, then the table's own address).
      expect([...new Set(passed[0])], 'alice: on her own table page, by her press, and no other').toEqual([tableId]);
      expect(passed[1]!.every((t) => t === tableId), 'bob: on no table page but that one').toBe(true);
      for (const p of [alice, bob]) await expect(p.page.locator('[aria-label="Game board"]'), `${p.name}: in the match`).toBeVisible({ timeout: UI_TIMEOUT });
      const matchId = matchUrl.exec(alice.page.url())![1]!;

      /* ── Carol, never seated: the hub, then straight to the match from its card ── */
      await carol.page.goto(roomUrl);
      await expect(carol.page.getByTestId('pod-rounds'), 'carol: the hub').toBeVisible({ timeout: UI_TIMEOUT });
      await expect(carol.page.getByTestId('pod-tables-play'), 'carol plays at no table').toHaveCount(0);
      await expect(carol.page.getByTestId('pod-tables-watch')).toHaveText('Watch');
      await expect(carol.page.getByTestId('pod-tables-watch'), 'a game is up: Watch is the game itself').toHaveAttribute('href', `#/match/${matchId}`);
      // The whole card is the way in (the operator: "any spectator can click on any active game and enter it
      // that way"): a press on the card's body, away from its Watch, still opens the game.
      const card = carol.page.locator(`[data-testid="pod-tables-row"][data-table-id="${tableId}"]`);
      // The card's own link covers it edge to edge, so a press anywhere on it is that link's. Mid-height,
      // not a fixed y: the compact strip's own height is content-driven (wave 90 lane B, item 6's fix), so a
      // magic pixel count is one layout tweak from landing outside the card instead of away from Watch.
      const cardBox = (await card.boundingBox())!;
      await card.click({ position: { x: 20, y: Math.round(cardBox.height / 2) } });
      await carol.page.waitForURL(new RegExp(`#/match/${matchId}$`), { timeout: UI_TIMEOUT });
      expect((await hashes(carol.page)).some((h) => h.endsWith(`/table/${tableId}`)), 'carol: straight to the game, not through the table page').toBe(false);
      await expect(carol.page.locator('[aria-label="Game board"]'), 'carol is watching').toBeVisible({ timeout: UI_TIMEOUT });
      await expect(carol.page.locator('.live[data-role="watcher"]'), 'carol is in as a watcher').toBeVisible({ timeout: UI_TIMEOUT });
      for (const id of ['live-concede', 'live-button-end-turn']) {
        await expect(carol.page.getByTestId(id), `${id} is not drawn for a watcher`).toHaveCount(0);
      }

      /* ── Alice back to the hub by choice: it keeps her ── */
      await alice.page.evaluate((hash) => (window.location.hash = hash), `#/room/${roomId}`);
      await expect(alice.page.getByTestId('pod-rounds'), 'alice: the hub').toBeVisible({ timeout: UI_TIMEOUT });
      await alice.page.waitForTimeout(3_000);
      expect(new URL(alice.page.url()).pathname, 'alice stays on the hub').toBe(`${PREFIX}/room/${roomId}`);
      // Her card is the way back into her running game, in one press on the card (the operator: "make sure we
      // dont lose the functionality of being able to click on the standings boxes to let people return to
      // their games that way").
      await expect(alice.page.getByTestId('pod-tables-play')).toHaveText('Return to game');
      await expect(alice.page.getByTestId('pod-tables-play')).toHaveAttribute('href', `#/match/${matchId}`);
      await alice.page.locator(`[data-testid="pod-tables-row"][data-table-id="${tableId}"]`).click({ position: { x: 20, y: 20 } });
      await alice.page.waitForURL(new RegExp(`#/match/${matchId}$`), { timeout: UI_TIMEOUT });
      await expect(alice.page.locator('.live[data-role="watcher"]'), 'alice is back in her seat, not watching').toHaveCount(0);
      await expect(alice.page.locator('[aria-label="Game board"]'), 'alice: back in her game').toBeVisible({ timeout: UI_TIMEOUT });

      /* ── game 1 to Alice, conceded from Bob's card on the hub; the sideboard step is its own screen ── */
      // The operator: "it would be nice if the 'Return to game' button had options for concede … that would
      // allow us to resolve games without having to close rooms". The confirm shows the score it leaves.
      await bob.page.evaluate((hash) => (window.location.hash = hash), `#/room/${roomId}`);
      await expect(bob.page.getByTestId('pod-rounds'), 'bob: the hub').toBeVisible({ timeout: UI_TIMEOUT });
      // My hub card's ways to resolve sit behind its ⋯ button.
      await bob.page.locator('[data-testid="pod-tables-row"][data-mine]').getByTestId('pod-tables-row-more').click();
      await bob.page.getByTestId('pod-tables-row-concede').click();
      await expect(bob.page.getByTestId('pod-tables-row-concede-confirm')).toContainText('0–0→1–0');
      await bob.page.getByTestId('pod-tables-row-concede-yes').click();
      await expect(alice.page.getByTestId('game-result'), 'alice wins game 1 by bob’s concede').toBeVisible({ timeout: UI_TIMEOUT });
      // His card is now the way to the table's sideboard step, a screen of its own.
      await expect(bob.page.getByTestId('pod-tables-play')).toHaveAttribute('href', `#/room/${roomId}/table/${tableId}/sideboard`, { timeout: UI_TIMEOUT });
      await expect(bob.page.getByTestId('pod-tables-play')).toHaveText('Sideboard');
      await bob.page.getByTestId('pod-tables-play').click();
      await bob.page.waitForURL(new RegExp(`#/room/${roomId}/table/${tableId}/sideboard$`), { timeout: UI_TIMEOUT });
      await expect(bob.page.getByTestId('table-sideboard-page').getByTestId('table-sideboard'), 'bob: the sideboard step, on its own screen').toBeVisible({ timeout: UI_TIMEOUT });
      await expect(bob.page.getByTestId('table-page'), 'bob: nothing of the table page around it').toHaveCount(0);
      await alice.page.getByTestId('game-result-next').click({ timeout: UI_TIMEOUT });
      await expect(alice.page.getByTestId('sideboard-step')).toBeVisible({ timeout: UI_TIMEOUT });
      for (const p of [alice, bob]) await p.page.getByTestId('sideboard-ready').click();
      // The next game exists once both are ready, but neither screen opens it by itself —
      // alice's own result screen, bob's sideboard screen: each draws Enter game.
      await expect(alice.page.getByTestId('game-result-enter'), 'alice: Enter game is offered').toBeVisible({ timeout: UI_TIMEOUT });
      await Promise.all([alice.page.getByTestId('game-result-enter').click(), pressIntoGame2(bob.page, matchUrl, UI_TIMEOUT)]);
      await bob.page.waitForURL(matchUrl, { timeout: UI_TIMEOUT });
      await expect(bob.page.locator('[aria-label="Game board"]'), 'game 2').toBeVisible({ timeout: UI_TIMEOUT });

      /* ── game 2 to Alice: the round settles; the hub's standings ── */
      await concedeToResult(bob, alice);
      await alice.page.getByTestId('game-result-room').click();
      await alice.page.waitForURL(new RegExp(`/room/${roomId}$`), { timeout: UI_TIMEOUT });
      await expect(alice.page.getByTestId('pod-standings'), 'standings after round 1').toBeVisible({ timeout: UI_TIMEOUT });
      const rows = alice.page.getByTestId(/^pod-standings-row-\d+$/);
      await expect(rows).toHaveCount(2);
      await expect(rows.first(), 'alice leads').toContainText('alice');
    } finally {
      await stack.stop();
    }
  },
);
