/**
 * Seats and watchers at a two-seat table with more than two people in the room
 * (`docs/requests/WATCHPARTY_SEATS_AND_SPECTATORS.md`, 2026-10-12).
 *
 * 1. The lobby: sitting is its own action, a seat can be given back before the
 *    match, and a third person with the table full is told they are watching.
 * 2. The match: the third person sees the game live from either side, has no
 *    game controls, and — the done-when's payload clause — receives no card face
 *    from a hand or a library on the wire. Their input is dropped by the server.
 */
import { expect, test, type Page } from '@playwright/test';

import { openFriend, type Friend } from './play/browser.ts';
import { enterMatch, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { openCreateRoom } from './play/rooms.ts';
import { connectSio } from './play/sio.ts';

test.describe.configure({ mode: 'serial' });

const PREFIX = '/cardtable';
const forge = forgeAvailability();

const seatSit = (page: Page) => page.getByTestId('seat-sit');
const seatStand = (page: Page) => page.getByTestId('seat-stand');
const viewerName = (page: Page) => page.locator('[data-testid="player"][data-viewer] .face__name');

async function createConstructedRoom(alice: Friend, origin: string): Promise<string> {
  await alice.page.goto(`${origin}${PREFIX}/`);
  await openCreateRoom(alice.page);
  await alice.page.getByTestId('room-create-name').fill(`e2e seats ${Date.now()}`);
  await alice.page.getByTestId('room-create-type').selectOption('constructed-1v1');
  await alice.page.getByTestId('room-create-submit').click();
  await alice.page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
  return alice.page.url();
}

/* ── 1. the lobby ───────────────────────────────────────────────────── */

test('a seat is taken and given back on purpose; the third person with the table full is watching', async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const carol = await openFriend(browser, 'carol');
    const roomUrl = await createConstructedRoom(alice, stack.origin);
    for (const f of [bob, carol]) {
      await f.page.goto(roomUrl);
      await expect(f.page.getByTestId('constructed'), `${f.name} is in the room`).toBeVisible({ timeout: 30_000 });
    }
    // Two empty seats, each with its own Sit here, for everyone.
    await expect(seatSit(carol.page), 'two empty seats offer Sit here').toHaveCount(2);
    await expect(seatStand(carol.page), 'nobody unseated has Stand up').toHaveCount(0);

    // Carol sits: her row holds the seat, she may stand, nobody may sit in it.
    await seatSit(carol.page).first().click();
    await expect(seatStand(carol.page), 'carol holds a seat').toBeVisible({ timeout: 15_000 });
    await expect(seatSit(carol.page), 'a seated player is not offered another seat').toHaveCount(0);
    await expect(seatSit(alice.page), 'one seat left for alice').toHaveCount(1, { timeout: 15_000 });
    await expect(carol.page.getByTestId('deck-mine'), 'the deck picker appears once seated').toBeVisible();

    // Carol stands: the seat is free again.
    await seatStand(carol.page).click();
    await expect(seatSit(alice.page), 'both seats free again').toHaveCount(2, { timeout: 15_000 });
    await expect(seatSit(carol.page)).toHaveCount(2);

    // Alice and bob sit; carol is the third person and is told so.
    await seatSit(alice.page).first().click();
    await expect(seatStand(alice.page)).toBeVisible({ timeout: 15_000 });
    await seatSit(bob.page).first().click();
    await expect(seatStand(bob.page)).toBeVisible({ timeout: 15_000 });
    await expect(seatSit(carol.page), 'no seat left').toHaveCount(0, { timeout: 15_000 });
    await expect(carol.page.getByTestId('room-spectator')).toBeVisible();
    await expect(carol.page.getByTestId('deck-mine'), 'no deck picker for the unseated').toHaveCount(0);

    // The server, not the button, is the refusal: a third sit with the table full is a 409.
    const res = await carol.context.request.post(`${stack.origin}${PREFIX}/api/tables/rooms/${roomUrl.split('/room/')[1]}/sit`, { data: {} });
    expect(res.status(), 'a third sit is refused by the server').toBe(409);
  } finally {
    await stack.stop();
  }
});

/* ── 2. the match ───────────────────────────────────────────────────── */

test('a third person watches the match from either side with no controls, and no hidden card reaches them on the wire', async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { matchId, roomUrl } = await enterMatch(alice, bob, stack.origin);
    await expect(alice.page.getByTestId('live-says')).toContainText(/play or draw/i, { timeout: 30_000 });

    // The seats are locked once the match is live.
    const roomId = roomUrl.split('/room/')[1];
    const stand = await alice.context.request.post(`${stack.origin}${PREFIX}/api/tables/rooms/${roomId}/stand`, { data: {} });
    expect(stand.status(), 'a player cannot stand up mid-match').toBe(409);

    // Carol arrives at the room and is carried to the match, as a watcher.
    const carol = await openFriend(browser, 'carol');
    await carol.page.goto(roomUrl);
    await carol.page.waitForURL(new RegExp(`#/match/${matchId}$`), { timeout: 60_000 });
    await expect(carol.page.locator('[aria-label="Game board"]'), 'a board, not a refusal').toBeVisible({ timeout: 30_000 });
    await expect(carol.page.locator('[data-role="watcher"]')).toHaveCount(1, { timeout: 30_000 });
    await expect(carol.page.getByTestId('watcher-status')).toBeVisible();
    for (const id of ['live-concede', 'live-button-end-turn', 'live-play-or-draw-play']) {
      await expect(carol.page.getByTestId(id), `${id} is not drawn for a watcher`).toHaveCount(0);
    }
    await expect(carol.page.locator('[data-zone="hand"] [data-board-card]'), 'both hands are counts').toHaveCount(0);
    await expect(carol.page.getByTestId('player'), 'both seats are drawn').toHaveCount(2);

    // Perspective: alice (seat 0) at the bottom by default; the flip puts bob there.
    await expect(viewerName(carol.page)).toHaveText('e2e-alice');
    await carol.page.getByTestId('perspective-flip').click();
    await expect(viewerName(carol.page)).toHaveText('e2e-bob');
    await carol.page.getByTestId('perspective-flip').click();
    await expect(viewerName(carol.page)).toHaveText('e2e-alice');

    // The payload: what a watcher's socket is actually sent.
    const raw = await connectSio(stack.origin, 'carol');
    try {
      const roles: unknown[] = [];
      const frames: unknown[] = [];
      raw.on('forge:role', (p) => roles.push(p));
      raw.on('forge:s2c', (p) => frames.push(p));
      const ack = (await raw.request('forge:join', { matchId })) as Record<string, unknown>;
      expect(ack, 'the join is a snapshot, not a refusal').not.toHaveProperty('error');
      expect(ack.seat, 'oriented by seat 0').toBe(0);
      await expect.poll(() => roles, { timeout: 10_000 }).toContainEqual({ matchId, role: 'watcher' });
      await carol.page.waitForTimeout(3000);
      const everything = JSON.stringify([ack, ...frames]);
      // Every card face on the wire carries `Name`; at the toss nothing is on the
      // table, so a watcher may be sent none of them.
      const names = [...everything.matchAll(/"Name":"([^"]+)"/g)].map((m) => m[1]);
      expect(names, `no card face reaches a watcher before a card is played: ${names.slice(0, 5).join(', ')}`).toEqual([]);
      expect(everything, 'no prompt frame reaches a watcher').not.toMatch(/"kind":"(prompt|window|ask)"/);
      // And its input is dropped by the server.
      raw.emit('forge:c2s', { matchId, frame: { kind: 'act', method: 'selectButtonOk' } });
      await expect
        .poll(() => serverLog(stack).filter((l) => l.evt === 'c2s-watcher' && l.matchId === matchId).length, { timeout: 10_000, message: 'the drop is logged' })
        .toBeGreaterThan(0);
    } finally {
      await raw.close();
    }
    await alice.page.waitForTimeout(1000);
    await expect(alice.page.getByTestId('live-says'), 'the watcher changed nothing for the players').toContainText(/play or draw/i);
    await expect(alice.page.getByTestId('live-play-or-draw-play')).toBeEnabled();
  } finally {
    await stack.stop();
  }
});
