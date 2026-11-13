/**
 * Item 1's scenario, shared by the desktop and phone specs (`w90a-chat-before-join.spec.ts`,
 * `.phone.spec.ts`) — the one difference between them is the viewport `test.use` sets, so the
 * flow itself lives here once rather than twice.
 *
 * The operator, on a password room showing its chat beside the password form: *"this one exposed
 * a bug in the site, the chat shouldn't load if the room hasn't been joined yet."* Fixed in
 * `App.tsx` (gates a `room` route's chat on `rooms/joined.ts`) and `ConstructedScreen.tsx` (marks
 * the store on proof of membership).
 *
 * ## Proving "no chat" without a live watchparty backend
 *
 * This harness runs no watchparty service (`e2e/w71-boards.spec.ts`'s own finding, which this
 * reuses rather than re-discovering): `RoomChrome`'s socket never reaches `connect` whether or not
 * it mounted, because there is nothing at `/watchparty` for it to connect to — so "no websocket
 * opened" would pass whether this bug was fixed or not, and is not asserted here. What IS a direct
 * read of whether `RoomChrome` mounted at all is the same thing wave 71 used: its effect logs
 * `Joining room` with its `roomKey`, synchronously, the moment it runs, gated on
 * `localStorage['wp:debug']` — armed here before the first navigation so the very first render
 * sees it. Absence of that line, together with `.wp-room-chrome` never appearing in the DOM, is
 * the proof that the chrome never mounted; neither is something a test that merely waited for a
 * network response could fake its way past.
 */
import { expect, type Page } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { roomIdFromAddress } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { submitCreateRoom } from './play/rooms.ts';

export const UI_TIMEOUT = 20_000;

/** Arms `wp:debug` for every navigation `page` makes from here on, and starts collecting every
 *  `Joining room` line `RoomChrome`'s own effect logs. Must be called BEFORE the first navigation
 *  so the react app's very first render sees the flag. */
export async function armRoomChromeJoins(page: Page): Promise<string[]> {
  await page.context().addInitScript(() => {
    try {
      window.localStorage.setItem('wp:debug', 'true');
    } catch {
      // No localStorage (a locked-down profile): the capture stays empty, a skip-worthy
      // result, never a crash.
    }
  });
  const lines: string[] = [];
  page.on('console', (msg) => {
    if (msg.text().includes('Joining room')) lines.push(msg.text());
  });
  return lines;
}

/**
 * A console message takes a moment to cross the CDP wire to this process even after the DOM
 * mutation it corresponds to is already visible — a race that only matters for THIS assertion,
 * because here absence is the thing being proved: checking the instant a visibility wait resolves
 * would risk calling a mount "never happened" merely because its own log had not landed YET. The
 * settle below is cheap insurance against exactly that false green, not a wait for anything to
 * finish succeeding.
 */
async function noChatYet(page: Page, joins: readonly string[]): Promise<void> {
  await page.waitForTimeout(600);
  await expect(page.locator('.wp-room-chrome'), 'no chat chrome before this tab has joined').toHaveCount(0);
  expect(joins, 'watchparty’s RoomChrome never mounted — no "Joining room" line logged').toEqual([]);
}

/**
 * The full scenario: alice makes a locked room; bob — a non-member — opens it directly (an invite
 * link, never the room list's own Join button); a wrong password changes nothing; the right one
 * reveals the chat. Then the same room id, as a path nobody has ever created, answers the same way
 * (the server's own "refused" is one answer for "locked" and "not there" — `ConstructedScreen.tsx`'s
 * own comment on `routes.ts`'s `tableFor` says why, and this keeps it: no "room not found" message).
 * Finally alice — already a member — reloads her own room and gets the chat back with no visible gap.
 */
export async function chatBeforeJoinScenario(browser: import('@playwright/test').Browser): Promise<void> {
  const alice = await openFriend(browser, 'alice');
  const bob = await openFriend(browser, 'bob');
  try {
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e w90a locked ${Date.now()}`, password: 'hunter2' });
    await alice.page.waitForURL(/\/room\/[a-z0-9-]+$/, { timeout: UI_TIMEOUT });
    const roomId = await roomIdFromAddress(alice.page);

    /* ── bob, a non-member, opens the room directly — no chat, no join log ── */
    // ONE join attempt only, below: the server's own password-guess limiter (`JOIN_RATE_LIMIT`,
    // `games/magic/server/src/http/rooms.ts`) spends a token per non-member attempt regardless of whether
    // it is right or wrong, and this scenario runs several times over in one server boot under
    // `--repeat-each` — a wrong-then-right pair here cost bob's bucket two tokens a run and tripped
    // "Too many attempts" by the third repeat (observed live). The wrong-password UI itself is
    // `play.spec.ts`'s to prove; this only needs that the right one works.
    const bobJoins = await armRoomChromeJoins(bob.page);
    await bob.page.goto(`${PREFIX}/#/room/${roomId}`);
    await expect(bob.page.getByTestId('room-locked'), 'bob is asked for the password').toBeVisible({ timeout: UI_TIMEOUT });
    await noChatYet(bob.page, bobJoins);

    /* ── the right password: the chat appears ── */
    await bob.page.getByTestId('room-password').fill('hunter2');
    await bob.page.getByTestId('room-password-submit').click();
    await expect(bob.page.getByTestId('room-locked'), 'the join went through').toHaveCount(0, { timeout: UI_TIMEOUT });
    await expect(bob.page.locator('.wp-room-chrome'), 'the chat mounts once bob has actually joined').toBeVisible({ timeout: UI_TIMEOUT });
    // `expect.poll`, not a bare read: the console line can land a beat after the DOM it explains.
    await expect.poll(() => bobJoins.length, { message: 'RoomChrome’s own effect ran once bob joined', timeout: UI_TIMEOUT }).toBeGreaterThan(0);

    /* ── a room id nobody ever created answers the same way: no enumeration, no chat either ── */
    const carol = await openFriend(browser, 'carol');
    try {
      const carolJoins = await armRoomChromeJoins(carol.page);
      await carol.page.goto(`${PREFIX}/#/room/r-e2e-w90a-missing-000000`);
      await expect(carol.page.getByTestId('room-locked'), 'the same refusal a locked room gives — never "not found"').toBeVisible({ timeout: UI_TIMEOUT });
      await expect(carol.page.getByTestId('room-locked')).toContainText('This room needs a password');
      await noChatYet(carol.page, carolJoins);
    } finally {
      await carol.context.close();
    }

    /* ── alice, already a member, reloads her own room: the chat is back with no visible gap ── */
    // "On first paint" is proved by making the fresh round trip that would otherwise RE-confirm
    // membership artificially slow, and checking the chat shows up well before it could possibly
    // have answered: `isJoined` already read `true` out of sessionStorage, synchronously, at the
    // very first render after the reload, so the mount cannot be waiting on this read landing.
    // (A bare timestamp race between the join log and the first network response was tried first
    // and is flaky by design — RoomChrome's mount ALSO waits on `useWhoami()`'s own, UNRELATED
    // fetch, so the two round trips have no guaranteed order; delaying one of them sidesteps that
    // entirely rather than fighting it.)
    const DELAY_MS = 8_000;
    let delayed = false;
    await alice.page.route(/\/api\/(tables\/)?rooms\//, async (route) => {
      if (!delayed) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      }
      await route.continue();
    });
    const aliceJoins = await armRoomChromeJoins(alice.page);
    await alice.page.reload();
    await expect(alice.page.locator('.wp-room-chrome'), `a member’s reload still gets the chat, well under the ${DELAY_MS}ms a fresh read is held up for`).toBeVisible({
      timeout: DELAY_MS - 3_000,
    });
    await expect.poll(() => aliceJoins.length, { message: 'RoomChrome mounted on reload', timeout: UI_TIMEOUT }).toBeGreaterThan(0);
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
}

export type { Friend };
