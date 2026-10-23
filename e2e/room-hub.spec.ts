/**
 * A tournament's rounds are a hub, and each match a table page inside the room
 * (ruling 8, `docs/planning/tournament-mode-plan.md`; the operator, 2026-10-23:
 * *"in the top level lobby room i would prefer to just show standings and links
 * to the open rooms. then players can enter their game rooms and perform the
 * game room actions there"*).
 *
 * Alice and Bob play a locked-deck Classic tournament; Carol is in the room and
 * never sits. Round 1 pairs Alice and Bob: each is carried, with no press, to
 * `#/room/<id>/table/<t>` and from there into the match. Carol opens the hub and
 * watches theirs through its card. Alice goes back to the hub and stays there.
 * Bob concedes twice; the sideboard step between the games is on the table
 * page; the round settles and the hub's standings show Alice first.
 *
 * Every page records its hash changes, because the table page is passed
 * through in a moment on the way to the match.
 */
import { expect, test, type Page } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { makeTitled, resizeWindow, roomIdFromHash } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;
const matchUrl = /#\/match\/(m-[0-9a-f]{12})$/;
const tableHash = /^#\/room\/r-[0-9a-f]+\/table\/(t-[0-9a-f]+)$/;

/** Every hash this page has been on since the recorder went in. */
async function hashes(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __hashes?: string[] }).__hashes ?? []);
}

async function recordHashes(p: Player): Promise<void> {
  await p.context.addInitScript(() => {
    const w = window as unknown as { __hashes: string[] };
    w.__hashes = [location.hash];
    addEventListener('hashchange', () => w.__hashes.push(location.hash));
  });
}

/** `/session/whoami` answers with this member's own id (`tournament.spec.ts`'s own fix), then a reload. */
async function routeRealIdentity(p: Player, roomId: string): Promise<void> {
  const roomBody = (await p.page.evaluate(
    (id) => fetch(`${window.location.pathname.replace(/\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()),
    roomId,
  )) as { members: { id: string; name: string }[] };
  const me = roomBody.members.find((m) => m.name === `e2e-${p.name}`);
  if (me === undefined) throw new Error(`${p.name}: not found among the room’s own members`);
  await p.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'friend', name: `e2e-${p.name}` } }));
  await p.page.reload();
  await resizeWindow(p.page, { width: 1280, height: 800 });
}

async function sitPickReady(p: Player, seat: number): Promise<void> {
  await p.page.locator(`[data-testid="pod-seat-sit"][data-seat="${seat}"]`).click();
  await expect(p.page.getByTestId('pod-seat-stand'), `${p.name}: holds a pod seat`).toBeVisible({ timeout: UI_TIMEOUT });
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
  titled('a tournament’s rounds are a hub of match links; each match is a table page that starts the game, and the hub keeps whoever goes back to it'),
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
      const roomId = await roomIdFromHash(alice.page);
      const roomUrl = `${stack.origin}${PREFIX}/#/room/${roomId}`;
      for (const p of [bob, carol]) {
        await p.page.goto(roomUrl);
        await expect(p.page.getByTestId('constructed'), `${p.name}: joined the room`).toBeVisible({ timeout: UI_TIMEOUT });
      }
      for (const p of [alice, bob, carol]) await routeRealIdentity(p, roomId);

      // A controlled radio: click, then wait for the room to say so.
      await alice.page.getByTestId('room-event-tournament').click();
      await expect(alice.page.getByTestId('room-event-tournament')).toBeChecked();
      for (const p of [alice, bob]) await expect(p.page.getByTestId('tournament-lobby'), `${p.name}: the pod lobby`).toBeVisible({ timeout: UI_TIMEOUT });
      await sitPickReady(alice, 0);
      await sitPickReady(bob, 1);

      /* ── paired: each player passes through their own table page into the match, with no press ── */
      for (const p of [alice, bob]) await p.page.waitForURL(matchUrl, { timeout: UI_TIMEOUT });
      const tablesOf = await Promise.all([alice, bob].map(async (p) => (await hashes(p.page)).map((h) => tableHash.exec(h)?.[1]).filter((t) => t !== undefined)));
      console.log(`[room-hub] table pages passed through: alice=${JSON.stringify(tablesOf[0])} bob=${JSON.stringify(tablesOf[1])}`);
      expect(tablesOf[0], 'alice: carried to her table page once').toHaveLength(1);
      expect(tablesOf[1], 'bob: carried to the same table page once').toEqual(tablesOf[0]);
      const tableId = tablesOf[0]![0]!;
      for (const p of [alice, bob]) await expect(p.page.locator('[aria-label="Game board"]'), `${p.name}: in the match`).toBeVisible({ timeout: UI_TIMEOUT });
      const matchId = matchUrl.exec(alice.page.url())![1]!;

      /* ── Carol, never seated: the hub, then the match through its card ── */
      await carol.page.goto(roomUrl);
      await expect(carol.page.getByTestId('pod-rounds'), 'carol: the hub').toBeVisible({ timeout: UI_TIMEOUT });
      await expect(carol.page.getByTestId('pod-tables-play'), 'carol plays at no table').toHaveCount(0);
      await expect(carol.page.getByTestId('pod-tables-watch')).toHaveText('Watch');
      // The whole card is the way in (the operator: "any spectator can click on any active game and enter it
      // that way"): a press on the card's body, away from its Watch, still opens the table.
      const card = carol.page.locator(`[data-testid="pod-tables-row"][data-table-id="${tableId}"]`);
      // The card's own link covers it edge to edge, so a press anywhere on it is that link's.
      await card.click({ position: { x: 20, y: 60 } });
      await carol.page.waitForURL(new RegExp(`#/match/${matchId}$`), { timeout: UI_TIMEOUT });
      expect((await hashes(carol.page)).some((h) => h.endsWith(`/table/${tableId}`)), 'carol: through the table page').toBe(true);
      await expect(carol.page.locator('[aria-label="Game board"]'), 'carol is watching').toBeVisible({ timeout: UI_TIMEOUT });
      await expect(carol.page.locator('.live[data-role="watcher"]'), 'carol is in as a watcher').toBeVisible({ timeout: UI_TIMEOUT });
      for (const id of ['live-concede', 'live-button-end-turn']) {
        await expect(carol.page.getByTestId(id), `${id} is not drawn for a watcher`).toHaveCount(0);
      }

      /* ── Alice back to the hub by choice: it keeps her ── */
      await alice.page.evaluate((hash) => (window.location.hash = hash), `#/room/${roomId}`);
      await expect(alice.page.getByTestId('pod-rounds'), 'alice: the hub').toBeVisible({ timeout: UI_TIMEOUT });
      await alice.page.waitForTimeout(3_000);
      expect(new URL(alice.page.url()).hash, 'alice stays on the hub').toBe(`#/room/${roomId}`);
      // Her card is the way back into her running game, in one press on the card (the operator: "make sure we
      // dont lose the functionality of being able to click on the standings boxes to let people return to
      // their games that way").
      await expect(alice.page.getByTestId('pod-tables-play')).toHaveText('Return to game');
      await expect(alice.page.getByTestId('pod-tables-play')).toHaveAttribute('href', `#/match/${matchId}`);
      await alice.page.locator(`[data-testid="pod-tables-row"][data-table-id="${tableId}"]`).click({ position: { x: 20, y: 60 } });
      await alice.page.waitForURL(new RegExp(`#/match/${matchId}$`), { timeout: UI_TIMEOUT });
      await expect(alice.page.locator('.live[data-role="watcher"]'), 'alice is back in her seat, not watching').toHaveCount(0);
      await expect(alice.page.locator('[aria-label="Game board"]'), 'alice: back in her game').toBeVisible({ timeout: UI_TIMEOUT });

      /* ── game 1 to Alice, conceded from Bob's card on the hub; the sideboard step is on the table page ── */
      // The operator: "it would be nice if the 'Return to game' button had options for concede … that would
      // allow us to resolve games without having to close rooms". The confirm shows the score it leaves.
      await bob.page.evaluate((hash) => (window.location.hash = hash), `#/room/${roomId}`);
      await expect(bob.page.getByTestId('pod-rounds'), 'bob: the hub').toBeVisible({ timeout: UI_TIMEOUT });
      await bob.page.getByTestId('pod-tables-row-concede').click();
      await expect(bob.page.getByTestId('pod-tables-row-concede-confirm')).toContainText('0–0→1–0');
      await bob.page.getByTestId('pod-tables-row-concede-yes').click();
      await expect(alice.page.getByTestId('game-result'), 'alice wins game 1 by bob’s concede').toBeVisible({ timeout: UI_TIMEOUT });
      // His card is now the way to the table's sideboard.
      await expect(bob.page.getByTestId('pod-tables-play')).toHaveText('Play', { timeout: UI_TIMEOUT });
      await bob.page.getByTestId('pod-tables-play').click();
      await bob.page.waitForURL(new RegExp(`#/room/${roomId}/table/${tableId}$`), { timeout: UI_TIMEOUT });
      await expect(bob.page.getByTestId('table-sideboard'), 'bob: the sideboard step, on the table page').toBeVisible({ timeout: UI_TIMEOUT });
      await alice.page.getByTestId('game-result-next').click({ timeout: UI_TIMEOUT });
      await expect(alice.page.getByTestId('sideboard-step')).toBeVisible({ timeout: UI_TIMEOUT });
      for (const p of [alice, bob]) await p.page.getByTestId('sideboard-ready').click();
      await bob.page.waitForURL(matchUrl, { timeout: UI_TIMEOUT });
      await expect(bob.page.locator('[aria-label="Game board"]'), 'game 2').toBeVisible({ timeout: UI_TIMEOUT });

      /* ── game 2 to Alice: the round settles; the hub's standings ── */
      await concedeToResult(bob, alice);
      await alice.page.getByTestId('game-result-room').click();
      await alice.page.waitForURL(new RegExp(`#/room/${roomId}$`), { timeout: UI_TIMEOUT });
      await expect(alice.page.getByTestId('pod-standings'), 'standings after round 1').toBeVisible({ timeout: UI_TIMEOUT });
      const rows = alice.page.getByTestId(/^pod-standings-row-\d+$/);
      await expect(rows).toHaveCount(2);
      await expect(rows.first(), 'alice leads').toContainText('alice');
    } finally {
      await stack.stop();
    }
  },
);
