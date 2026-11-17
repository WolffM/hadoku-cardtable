/**
 * A configured external-game room, end to end through the real UI and the real relay — wave 119
 * §U's 1a: on base, `RoomTableScreen` calls Magic's table route (`GET /api/tables/rooms/:roomId`)
 * for every room type, which 404s for a room of a game Magic does not play, member or not
 * (`http/routes.ts`'s `tableFor`), and the join-on-refusal dance this screen runs against THAT
 * route can never clear a refusal that is not about membership — so the screen keeps a stray
 * `room-missing` error up ("no such room") even once the room and its relay match are both
 * genuinely fine. The fix routes a non-Magic room's join through the generic `GET /api/rooms/:id`
 * instead (`magic-room-ui.tsx`'s `isKnownNonMagicRoom`); `assertNoRoomMissing` below is what a
 * revert of that fix turns red.
 *
 * This is deliberately NOT a bomberman-named test: it proves the GENERIC mechanism — the
 * `CARDTABLE_EXPERIMENTAL_GAMES`-gated `EXTERNAL_GAMES` config
 * (`apps/server/src/plugins/external-games.ts`, `@hadoku/game-ui/rooms/external-games.tsx`) and
 * the Experimental-features-gated create-room radio (`RoomList.tsx`) — using a toy stub bundle
 * (`fixtures/external-game-embed.fixture.js`), not hadoku-bomberman's own code (never copied
 * here) or its old by-name spec (`e2e/bomberman.spec.ts`, deleted this wave: "no bomberman code
 * in cardtable"). Wave 120 §F: this spec rides on `EXTERNAL_GAMES`' own `e2e-toy-relay` entry
 * (`e2eOnly: true`, `packages/game-ui/src/rooms/external-games-config.ts`), never on `bomberman`
 * by name or by position — deleting the `bomberman` entry (bomberman's own wave `bm1` is expected
 * to) deletes nothing this spec depends on.
 *
 * Covers everything `bomberman.spec.ts` did (both seats get a channel and talk, a seat drops and
 * returns inside its seat hold, the leader's `over` is the room's result, reloading after the end
 * still shows it, and leaving unmounts the bundle) plus the room-create flow through the real UI
 * (Experimental features on, the radio, submit) and the 1a regression check itself.
 *
 * `[external-game]` lines are the evidence.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { makeTitled, roomIdFromAddress, serverLog } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { openCreateRoom } from './play/rooms.ts';
import { closeSettings, openSettings } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const PREFIX = '/cardtable';

const FIXTURE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/external-game-embed.fixture.js');

/**
 * `EXTERNAL_GAMES`' own e2e-only entry (`packages/game-ui/src/rooms/external-games-config.ts`) —
 * read off that config's own shape below, not asserted as a fact this spec depends on bomberman
 * being named any particular thing or holding any particular position in the array. Its own seat
 * hold, carried to the relay.
 */
const EXTERNAL_GAME_TYPE = 'e2e-toy-relay';
const SEAT_HOLD_MS = 120_000;

/** Serve the stub bundle for every request the room's `BundleSlot` makes, same origin, any port. */
async function stubExternalGameEmbed(context: BrowserContext): Promise<void> {
  await context.route('**/e2e/toy-relay-embed.js', (route) =>
    route.fulfill({ path: FIXTURE_PATH, contentType: 'text/javascript' }),
  );
}

/**
 * The one client-side escape for this entry (`RoomList.tsx`'s own `e2eToyGamesEnabled`): without
 * it, Create room's radio never offers `e2e-toy-relay` in a real browser, Experimental features on
 * or not — a per-member preference is not a flag this spec, or anyone else, should be able to flip
 * in prod. Set before the page's own scripts run, so the module-scope read sees it from the first
 * render.
 */
async function enableE2eToyGames(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    (window as unknown as { __cardtableE2eToyGames?: boolean }).__cardtableE2eToyGames = true;
  });
}

const fixturePanel = (page: Page) => page.getByTestId('external-game-fixture');
const messages = (page: Page) => page.getByTestId('external-game-fixture-received').getByTestId('external-game-fixture-message');

/** 1a's own check: a room already known-good must never carry the stale "no such room" text. */
async function assertNoRoomMissing(page: Page): Promise<void> {
  await expect(page.getByTestId('room-missing'), 'a configured external-game room never shows "no such room"').toHaveCount(0);
}

test(titled('a configured external-game room, made through Create room with Experimental features on, plays over the relay with no stray "no such room" — both seats get a channel and talk, a seat drops and returns inside its hold, the leader\'s over is the room\'s result, and leaving unmounts it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge, { env: { CARDTABLE_EXPERIMENTAL_GAMES: '1', CARDTABLE_E2E_TOY_GAMES: '1' } });
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await stubExternalGameEmbed(alice.context);
    await stubExternalGameEmbed(bob.context);
    await enableE2eToyGames(alice.context);
    await enableE2eToyGames(bob.context);

    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    await openCreateRoom(alice.page);
    // Not offered until Experimental features is on — the real gate the old hardcoded Bomberman
    // entry skipped (survey 2026-11-16 §1: "ruling 7: open to every member, no gate").
    await expect(alice.page.getByTestId(`room-create-type-${EXTERNAL_GAME_TYPE}`), 'an external game is offered only with Experimental features on').toHaveCount(0);
    await alice.page.getByTestId('room-create-close').click();
    const experimental = (await openSettings(alice.page)).getByTestId('settings-experimental-features');
    await experimental.click();
    await expect(experimental).toBeChecked();
    await closeSettings(alice.page);

    await openCreateRoom(alice.page);
    await alice.page.getByTestId('room-create-name').fill(`e2e external game ${Date.now()}`);
    await alice.page.getByTestId(`room-create-type-${EXTERNAL_GAME_TYPE}`).click();
    await expect(alice.page.getByTestId(`room-create-type-${EXTERNAL_GAME_TYPE}`)).toBeChecked();
    // This game type has no mode of its own: the Constructed mode row is not offered for it.
    await expect(alice.page.getByTestId('room-create-constructed-mode')).toHaveCount(0);
    await alice.page.getByTestId('room-create-submit').click();
    const roomId = await roomIdFromAddress(alice.page);
    await assertNoRoomMissing(alice.page);

    // Bob follows the room's invite link cold — never a member before this `goto` — the exact
    // path 1a's bug hit in production (a fresh visitor, not the leader who just created it).
    let bobPage = bob.page;
    await bobPage.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);

    // Both seats: the leader's own context, and the one it was handed to another member.
    await expect(fixturePanel(alice.page)).toHaveAttribute('data-room-key', roomId, { timeout: 15_000 });
    await expect(fixturePanel(alice.page)).toHaveAttribute('data-is-leader', 'true');
    await expect(fixturePanel(bobPage)).toHaveAttribute('data-room-key', roomId, { timeout: 15_000 });
    await expect(fixturePanel(bobPage)).toHaveAttribute('data-is-leader', 'false');
    await assertNoRoomMissing(alice.page);
    await assertNoRoomMissing(bobPage);
    for (const page of [alice.page, bobPage]) {
      const seats = page.getByTestId('external-game-fixture-seat');
      await expect(seats).toHaveCount(2);
      await expect(seats).toContainText(['e2e-alice', 'e2e-bob']);
      // The stub reads ctx.channel: a relay room hands every seat one.
      await expect(fixturePanel(page)).toHaveAttribute('data-has-channel', 'true');
    }
    await expect(fixturePanel(alice.page)).toHaveAttribute('data-my-seat', '0');
    await expect(fixturePanel(bobPage)).toHaveAttribute('data-my-seat', '1');

    // A channel exists before its join is answered, and a message sent before a seat joined is not
    // kept for it (at most once): wait for the server to have joined both.
    const joined = () => serverLog(stack).filter((r) => r.matchId === roomId && r.evt === 'relay-joined').length;
    await expect.poll(joined, { timeout: 15_000 }).toBe(2);

    // The two seats exchange a message, each way, never hearing their own.
    await alice.page.getByTestId('external-game-fixture-send').click();
    await expect(messages(bobPage), 'bob hears alice').toHaveCount(1, { timeout: 15_000 });
    await bobPage.getByTestId('external-game-fixture-send').click();
    await expect(messages(alice.page), 'alice hears bob').toHaveCount(1, { timeout: 15_000 });
    await expect(messages(bobPage)).toContainText(['"from":0']);
    await expect(messages(alice.page)).toContainText(['"from":1']);

    // Bob drops (his page goes) and comes back inside the hold: the relay holds his seat for
    // this game type's own seat hold, and he is back on it, hearing alice again, with still no
    // stray "no such room" on the way back in.
    const relay = () => serverLog(stack).filter((r) => r.matchId === roomId && typeof r.evt === 'string' && r.evt.startsWith('relay-seat-'));
    await bobPage.close();
    await expect.poll(() => relay().filter((r) => r.evt === 'relay-seat-held'), { timeout: 15_000 }).toHaveLength(1);
    const held = relay().find((r) => r.evt === 'relay-seat-held');
    expect(held?.graceMs, "the configured entry's own seat hold reached the relay match").toBe(SEAT_HOLD_MS);
    bobPage = await bob.context.newPage();
    await bobPage.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
    await expect(fixturePanel(bobPage)).toHaveAttribute('data-has-channel', 'true', { timeout: 15_000 });
    await assertNoRoomMissing(bobPage);
    await expect.poll(() => relay().filter((r) => r.evt === 'relay-seat-back').map((r) => r.seat), { timeout: 15_000 }).toEqual([held?.seat]);
    expect(relay().filter((r) => r.evt === 'relay-seat-left'), 'nobody left the match').toEqual([]);
    await alice.page.getByTestId('external-game-fixture-send').click();
    await expect(messages(bobPage), 'bob, back, hears alice again').toHaveCount(1, { timeout: 15_000 });

    // The leader's bundle ends the match, bob (seat 1) the winner: the room shows it on both screens.
    await alice.page.evaluate(() => {
      (window as unknown as { __externalGameFixture: { overWinners: number[] } }).__externalGameFixture.overWinners = [1];
    });
    await alice.page.getByTestId('external-game-fixture-over').click();
    for (const page of [alice.page, bobPage]) {
      await expect(page.getByTestId('room-bundle-result')).toHaveText('e2e-bob won', { timeout: 15_000 });
      await expect(page.getByTestId('room-bundle-result')).toHaveAttribute('data-winners', '1');
    }
    // The result on reload: bob's page loads again after the end and still shows it, still with
    // no stray "no such room".
    await bobPage.reload();
    await expect(fixturePanel(bobPage)).toHaveAttribute('data-has-channel', 'true', { timeout: 15_000 });
    await expect(bobPage.getByTestId('room-bundle-result'), 'bob, reloaded after the end, sees the result').toHaveText('e2e-bob won', { timeout: 15_000 });
    await assertNoRoomMissing(bobPage);
    console.log(`[external-game] room=${roomId} relay=${JSON.stringify(relay())} ended=${JSON.stringify(serverLog(stack).filter((r) => r.evt === 'relay-ended' && r.matchId === roomId))}`);

    // Leaving the room the way a player does, by the header's way home (an in-page navigation,
    // never a reload), unmounts the mounted bundle — not merely "the page changed", which a full
    // navigation would prove trivially and dishonestly.
    await alice.page.getByTestId('chrome-home').click();
    await expect.poll(() => alice.page.evaluate(() => window.location.pathname)).not.toContain('/room/');
    await expect(fixturePanel(alice.page)).toHaveCount(0);
    await expect
      .poll(() => alice.page.evaluate(() => (window as unknown as { __externalGameFixture?: { unmounts: number } }).__externalGameFixture?.unmounts ?? 0))
      .toBeGreaterThan(0);
  } finally {
    await stack.stop();
  }
});
