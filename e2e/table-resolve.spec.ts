/**
 * A table's series resolved from its card without closing the room (the operator, 2026-10-23: *"it would
 * be nice if the 'Return to game' button had options for concede and abandon. that would allow us to
 * resolve games without having to close rooms"*; `docs/planning/table-card-plan.md`):
 * - Abandon, a constructed room: Bob concedes game 1, a Rematch makes it a Bo3, and between games Alice
 *   abandons it from the room's card — the series ends with no result and the table is back to seating,
 *   both still seated.
 * - Drop match, a tournament: Alice drops her live round-1 match from her hub card — Bob wins it, the
 *   one-round tournament is over with Bob first, and the game in play is stopped.
 *
 * `[resolve]` lines are the evidence: the server's own events for each.
 */
import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { makeTitled, resizeWindow, roomIdFromHash } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { enterMatch } from './play/enter.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;
const MATCH_URL = /#\/match\/(m-[0-9a-f]{12})$/;

/** The server's log rows of one event, for one room. */
function events(stack: PlayStack, evt: string, roomId: string): Record<string, unknown>[] {
  return readFileSync(stack.serverLogFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes(`"${evt}"`) && line.includes(roomId))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** `/session/whoami` answers with this member's own id (`room-hub.spec.ts`'s own fix), then a reload. */
async function routeRealIdentity(p: Friend, roomId: string): Promise<void> {
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

async function sitPickReady(page: Page, name: string, seat: number): Promise<void> {
  await page.locator(`[data-testid="pod-seat-sit"][data-seat="${seat}"]`).click();
  await expect(page.getByTestId('pod-seat-stand'), `${name}: holds a pod seat`).toBeVisible({ timeout: UI_TIMEOUT });
  await page.getByTestId('deck-mine').getByTestId('deck-option').first().click();
  await expect(page.getByTestId('ready-toggle'), `${name}: a legal deck enables Ready`).toBeEnabled({ timeout: UI_TIMEOUT });
  await page.getByTestId('ready-toggle').click();
}

test(titled('Abandon: a constructed Bo3 between games ends with no result from the room’s card, and the table is back to seating'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { roomUrl } = await enterMatch(alice, bob, stack.origin);
    const roomId = /#\/room\/(r-[0-9a-f]+)/.exec(roomUrl)![1]!;

    await bob.page.getByTestId('live-concede').click();
    await bob.page.getByTestId('live-concede-yes').click();
    for (const f of [alice, bob]) await expect(f.page.getByTestId('game-result'), `${f.name}'s result screen`).toBeVisible({ timeout: 45_000 });
    // Bob's Rematch and Alice's Ready in the room make it a Bo3, game 1 to Alice, both to sideboard.
    await bob.page.getByTestId('game-result-rematch').click();
    await alice.page.getByTestId('game-result-room').click();
    await expect(alice.page).toHaveURL(roomUrl, { timeout: 15_000 });
    await alice.page.getByTestId('ready-toggle').click();

    const card = alice.page.getByTestId('room-table-card');
    await expect(card, 'between games the room’s table is its card').toBeVisible({ timeout: UI_TIMEOUT });
    await card.getByTestId('room-table-card-abandon').click();
    await expect(card.getByTestId('room-table-card-abandon-confirm')).toContainText('1–0→No result');
    await card.getByTestId('room-table-card-abandon-yes').click();

    await expect(alice.page.getByTestId('room-table-card'), 'the series is gone: no card, the table is seating').toHaveCount(0, { timeout: UI_TIMEOUT });
    await expect(alice.page.getByTestId('ready-toggle'), 'alice is still seated, not ready').toHaveAttribute('aria-pressed', 'false', { timeout: UI_TIMEOUT });
    const abandoned = events(stack, 'table-abandoned', roomId);
    const ended = events(stack, 'table-series-ended', roomId);
    console.log(`[resolve] abandon: abandoned=${JSON.stringify(abandoned)} series-ended=${ended.length}`);
    expect(abandoned, 'the room abandoned the series once').toHaveLength(1);
    expect(ended, 'an abandoned series records no result').toHaveLength(0);
  } finally {
    await stack.stop();
  }
});

test(titled('Drop match: a tournament match dropped from the hub card is the other player’s, the round settles, and its game stops'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(6 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e drop ${Date.now()}`, gameType: 'constructed-1v1', mode: 'classic' });
    const roomId = await roomIdFromHash(alice.page);
    const roomUrl = `${stack.origin}${PREFIX}/#/room/${roomId}`;
    await bob.page.goto(roomUrl);
    await expect(bob.page.getByTestId('constructed')).toBeVisible({ timeout: UI_TIMEOUT });
    for (const p of [alice, bob]) await routeRealIdentity(p, roomId);
    await alice.page.getByTestId('room-event-tournament').click();
    await expect(alice.page.getByTestId('room-event-tournament')).toBeChecked();
    await sitPickReady(alice.page, 'alice', 0);
    await sitPickReady(bob.page, 'bob', 1);
    for (const p of [alice, bob]) await p.page.waitForURL(MATCH_URL, { timeout: UI_TIMEOUT });
    for (const p of [alice, bob]) await expect(p.page.locator('[aria-label="Game board"]'), `${p.name}: in the match`).toBeVisible({ timeout: UI_TIMEOUT });
    const matchId = MATCH_URL.exec(alice.page.url())![1]!;

    // Alice, on the hub, drops her live match from her card. The confirm shows the forfeit it leaves.
    await alice.page.evaluate((hash) => (window.location.hash = hash), `#/room/${roomId}`);
    await expect(alice.page.getByTestId('pod-rounds'), 'alice: the hub').toBeVisible({ timeout: UI_TIMEOUT });
    await alice.page.getByTestId('pod-tables-row-drop').click();
    await expect(alice.page.getByTestId('pod-tables-row-drop-confirm')).toContainText('0–0→0–2');
    await alice.page.getByTestId('pod-tables-row-drop-yes').click();

    await expect(alice.page.getByTestId('pod-final'), 'the one-round tournament is over').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(alice.page.getByTestId('pod-standings-row-1'), 'bob is first').toContainText('bob');
    const dropped = events(stack, 'table-dropped', roomId);
    console.log(`[resolve] drop: dropped=${JSON.stringify(dropped)}`);
    expect(dropped, 'the room dropped the match once').toHaveLength(1);
    expect(dropped[0]!.matchId, 'the game in play was the one let go of').toBe(matchId);
    expect(events(stack, 'table-game-recorded', roomId), 'the stopped game records nothing').toHaveLength(0);
  } finally {
    await stack.stop();
  }
});
