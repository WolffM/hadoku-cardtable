/**
 * (2026-11-16, operator, screenshot of room card "Kawakimi"): "floating avatar decoration was
 * not disposed properly. it was on one of my spectator's that had the decoration … i never saw it
 * anywhere else just on the front page." A halo drawn under the room owner's name on the front
 * page's room card.
 *
 * Measured (not reproduced visually here, but the mechanism is pinned exactly): the front page's room
 * card draws its member list for screen readers only — `games/magic/ui/src/rooms/rooms.css`'s
 * `.rooms__sr`: `position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)` — right in
 * the card's visible body, beside the room's own name (`room-card__name`). A member's `<Avatar
 * fallback="none">` still draws a `FaceDecor` whenever they have a picture or character (`Avatar.tsx`'s
 * `url !== null` branch draws it regardless of `fallback`), and `decorHost` (`packages/game-ui/src/room/
 * look.tsx`) escaped that 1×1 clip — meant to hide the list from sighted eyes entirely — the same way
 * it is meant to escape a face-sized clipping RING (a seat's round portrait), portaling the decoration
 * into the card's visible body. A spectator who is only a room MEMBER, never seated, still lands in
 * that hidden list, so their decoration (a halo) leaked onto the card next to the owner's name.
 *
 * `packages/game-ui/src/room/look.test.ts` pins the mechanism directly (jsdom, stubbed boxes); this
 * spec proves it end to end: carol joins alice's room as a spectator (the table is already full)
 * wearing a halo, and erin — reading the front page's room list, never the room itself — sees no
 * decoration anywhere outside that hidden member list.
 */
import { fileURLToPath } from 'node:url';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { FRIENDS, PREFIX } from './identities.ts';
import { makeTitled } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';
import { dress, servePictures } from './looks.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Every `[data-hc-art]` (an overlay's art, `decorHtml`) on the page that is NOT inside a `.rooms__sr`
 * screen-reader-only box — i.e. one that escaped a hiding clip onto the visible page. Runs in the page. */
function leakedDecorCount(): number {
  const hidden = [...document.querySelectorAll('.rooms__sr')];
  const decor = [...document.querySelectorAll('[data-hc-art]')];
  return decor.filter((d) => !hidden.some((h) => h.contains(d))).length;
}

test(titled('a spectator’s halo stays off the front page’s room card, beside the owner’s name'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const carol = await openFriend(browser, 'carol');
    const erin = await openFriend(browser, 'erin');
    for (const f of [alice, bob, carol, erin]) await servePictures(f.context, `${stack.origin}/watchparty/media/sprites`);

    // carol wears a halo before she ever joins: the stand-in keeps an answer a minute.
    await dress(carol.context.request, stack.origin, FRIENDS.carol.key, {
      source: 'sprite',
      sprite: 'sage',
      name: FRIENDS.carol.name,
      cosmetics: { overlay: 'overlay.halo' },
    });

    const roomName = `e2e w122g Kawakimi's Room ${Date.now()}`;
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: roomName });
    await alice.page.waitForURL(/\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
    const roomUrl = alice.page.url();

    // bob fills the second seat; carol finds the table full and lands among the spectators — a room
    // MEMBER, never seated, which is exactly the shape the operator's spectator was in.
    await bob.page.goto(roomUrl);
    await expect(bob.page.getByTestId('constructed'), 'bob is in the room').toBeVisible({ timeout: 30_000 });
    await carol.page.goto(roomUrl);
    await expect(carol.page.getByTestId('constructed'), 'carol is in the room').toBeVisible({ timeout: 30_000 });
    await expect(carol.page.locator('[data-testid="room-spectator"][data-mine]'), 'carol is a spectator, not seated').toBeVisible({ timeout: 15_000 });

    // erin never opens the room: she only ever reads the front page's room list.
    await erin.page.goto(`${stack.origin}${PREFIX}/`);
    const row = erin.page.getByTestId('room-row').filter({ hasText: roomName });
    await expect(row, 'erin sees the room on the front page').toBeVisible({ timeout: 30_000 });
    await row.scrollIntoViewIfNeeded();

    await screenshotRoomCard(erin.page, row);

    const leaked = await erin.page.evaluate(leakedDecorCount);
    expect(leaked, 'carol’s halo stays inside the hidden member list, never beside the room’s name').toBe(0);
    await expect(row.getByTestId('room-name'), 'the room’s own name is drawn plain').toHaveText(roomName);
  } finally {
    await stack.stop();
  }
});

/** Evidence for the manager's report; gitignored. Overwrites on every run — rename by hand for a
 * before/after pair, the way the lane report does. */
async function screenshotRoomCard(_page: Page, row: Locator): Promise<void> {
  const path = fileURLToPath(new URL('../docs/handoff/w122-G/room-card.png', import.meta.url));
  await row.screenshot({ path });
}
