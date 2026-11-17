/**
 * The leader's remove-from-seat route (wave 119 §S): A leads a pod, B joins and is auto-seated;
 * A removes B from their seat over the leader's own route (`POST /api/rooms/:id/seats/remove`).
 * Nobody is ever roleless (the operator, 2026-11-02): B stays a member of the room and is shown
 * in the spectator row, on BOTH screens, with no reload.
 *
 * Wave 120 §S2 adds two things this header used to say were out of reach:
 * - the leader's own Remove button on the pod's seat strip (`SeatList`'s `onRemoveMember`,
 *   `games/magic/ui/src/screens/pod/PodLobby.tsx`) — the first test below presses IT, not the
 *   route directly, so the UI wiring is what is proved, not just the server underneath it;
 * - a plain constructed-1v1 room: its ONE table (`TableSeats`, a different mechanism from a pod's
 *   game seats) is now a fallback target for this same route (`hooks.extraSeatTarget`,
 *   `games/magic/server/src/room/lobby.ts`), so `#seatOpRoom` no longer answers `not-draft` for
 *   it — the second test proves that case, over the route directly (no UI control for a 1v1's own
 *   remove exists yet; that is a further wave's, same as the original pod case before this one).
 */
import { expect, test } from '@playwright/test';

import { FRIENDS, PREFIX } from './identities.ts';
import { openFriend } from './play/browser.ts';
import { submitCreateRoom } from './play/rooms.ts';

const UI_TIMEOUT = 20_000;

test('A leads a pod, B is auto-seated; A removes B from the seat; B shows as a spectator on both screens, still a member', async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await openFriend(browser, 'alice');
  const bob = await openFriend(browser, 'bob');
  try {
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e seat-remove ${Date.now()}`, gameType: 'draft' });
    await alice.page.waitForURL(/\/room\/[a-z0-9-]+$/, { timeout: UI_TIMEOUT });
    const roomUrl = alice.page.url();

    // Alice (the pod's creator) is auto-seated at seat 0; Bob joining the pod's lobby is
    // auto-seated too (the pod's draft has not started, so joining always takes the next open
    // seat) — a pod opens with eight, so this never fills it.
    await expect(alice.page.getByTestId('pod-seat-0')).toContainText(FRIENDS.alice!.name, { timeout: UI_TIMEOUT });
    await bob.page.goto(roomUrl);
    await expect(bob.page.locator('.room-shell'), 'bob is a member').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(alice.page.getByTestId('pod-seat-1'), 'bob is auto-seated next to alice').toContainText(FRIENDS.bob!.name, { timeout: UI_TIMEOUT });
    await expect(alice.page.getByTestId('room-spectator'), 'nobody watches yet: alice and bob both hold a seat').toHaveCount(0);

    // Alice (the leader) presses her own Remove button on Bob's seat (wave 120 §S2's UI wiring) —
    // the control, not the route directly.
    await alice.page.getByTestId('pod-seat-1').getByTestId('pod-seat-remove').click();

    // Bob is a spectator on BOTH screens now, with no reload — the room's own live feed carries it.
    for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      const spectator = page.locator('[data-testid="room-spectator"]').filter({ hasText: FRIENDS.bob!.name });
      await expect(spectator, `${who} sees bob in the spectator row`).toBeVisible({ timeout: UI_TIMEOUT });
    }
    // And his own seat is offered again, open, nobody else's.
    await expect(alice.page.getByTestId('pod-seat-1').getByTestId('pod-seat-sit'), 'bob’s own seat is open again').toBeVisible({ timeout: UI_TIMEOUT });

    // A room has no third state: bob is still a member of this room (the spectator row itself is
    // drawn from `members`, not from a separate roster) — he never dropped out of membership.
    await expect(bob.page.locator('.room-shell'), 'bob is still in the room, watching, not kicked out of it').toBeVisible();
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});

test('A leads a plain constructed-1v1 table, B joins and is auto-seated; A removes B over the route; B shows as a spectator on both screens, still a member', async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await openFriend(browser, 'alice');
  const bob = await openFriend(browser, 'bob');
  try {
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e seat-remove-1v1 ${Date.now()}`, gameType: 'constructed-1v1' });
    await alice.page.waitForURL(/\/room\/[a-z0-9-]+$/, { timeout: UI_TIMEOUT });
    const roomUrl = alice.page.url();
    const roomId = new URL(roomUrl).pathname.split('/').pop()!;

    // Alice (the table's creator) is auto-seated at seat 0; Bob joining takes the other.
    await expect(alice.page.getByTestId('room-seat-0')).toContainText(FRIENDS.alice!.name, { timeout: UI_TIMEOUT });
    await bob.page.goto(roomUrl);
    await expect(bob.page.locator('.room-shell'), 'bob is a member').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(alice.page.getByTestId('room-seat-1'), 'bob is auto-seated opposite alice').toContainText(FRIENDS.bob!.name, { timeout: UI_TIMEOUT });
    await expect(alice.page.getByTestId('room-spectator'), 'nobody watches yet: alice and bob both hold a seat').toHaveCount(0);

    // Alice (the leader) removes Bob from his seat over the route — no UI control for a 1v1's own remove yet.
    const apiBase = `${new URL(roomUrl).origin}${PREFIX}/api/rooms`;
    const bobMemberId = await alice.page.evaluate(
      async ({ apiBase, roomId, bobName }) => {
        const room = (await (await fetch(`${apiBase}/${roomId}`, { credentials: 'same-origin' })).json()) as { members: { id: string; name: string }[] };
        return room.members.find((m) => m.name === bobName)!.id;
      },
      { apiBase, roomId, bobName: FRIENDS.bob!.name },
    );
    const res = await alice.page.evaluate(
      async ({ apiBase, roomId, bobMemberId }) => {
        const r = await fetch(`${apiBase}/${roomId}/seats/remove`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ memberId: bobMemberId }),
        });
        return { status: r.status, body: await r.json() };
      },
      { apiBase, roomId, bobMemberId },
    );
    // Before wave 120 §S2 this was a 409 ('this room does not seat through game seats' — `not-draft`).
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Bob is a spectator on BOTH screens now, with no reload — the room's own live feed carries it,
    // the same `players.filter`-derived spectator row a pod's draws from (`magic-room-ui.tsx`).
    for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      const spectator = page.locator('[data-testid="room-spectator"]').filter({ hasText: FRIENDS.bob!.name });
      await expect(spectator, `${who} sees bob in the spectator row`).toBeVisible({ timeout: UI_TIMEOUT });
    }

    // A room has no third state: bob is still a member of this room.
    await expect(bob.page.locator('.room-shell'), 'bob is still in the room, watching, not kicked out of it').toBeVisible();
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});
