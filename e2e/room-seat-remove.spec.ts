/**
 * The leader's remove-from-seat route (wave 119 §S): A leads a pod, B joins and is auto-seated;
 * A removes B from their seat over the leader's own route (`POST /api/rooms/:id/seats/remove`,
 * no UI control yet — that is lane U's, to land after this route). Nobody is ever roleless (the
 * operator, 2026-11-02): B stays a member of the room and is shown in the spectator row, on BOTH
 * screens, with no reload.
 *
 * A DRAFT room, not a plain constructed-1v1 one: only a room whose type seats through game seats
 * (`hooks.usesSeats`) can reach these routes at all — a 1v1 table seats through its own per-table
 * `TableSeats`, a different mechanism entirely (`#seatRoom` answers `not-draft` for it). Today
 * that is a pod (`usesPod`, `pods.ts`); a plain 1v1 table's seats are not this wave's to cover —
 * that gap is the next wave's L2 work. No UI control exists for this route yet, so the leader's
 * call is made from her own page's own origin, carrying her identity the same way
 * `w98-served-room.spec.ts`'s two-tab test drives `/pod/sit` and `/ready` directly.
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
    const roomId = new URL(roomUrl).pathname.split('/').pop()!;

    // Alice (the pod's creator) is auto-seated at seat 0; Bob joining the pod's lobby is
    // auto-seated too (the pod's draft has not started, so joining always takes the next open
    // seat) — a pod opens with eight, so this never fills it.
    await expect(alice.page.getByTestId('pod-seat-0')).toContainText(FRIENDS.alice!.name, { timeout: UI_TIMEOUT });
    await bob.page.goto(roomUrl);
    await expect(bob.page.locator('.room-shell'), 'bob is a member').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(alice.page.getByTestId('pod-seat-1'), 'bob is auto-seated next to alice').toContainText(FRIENDS.bob!.name, { timeout: UI_TIMEOUT });
    await expect(alice.page.getByTestId('room-spectator'), 'nobody watches yet: alice and bob both hold a seat').toHaveCount(0);

    // Alice (the leader) removes Bob from his seat over the new route — no UI control for it yet.
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
    expect(res.status, JSON.stringify(res.body)).toBe(200);

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
