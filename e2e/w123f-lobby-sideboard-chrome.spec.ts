/**
 * The room lobby's sideboard step draws in the game's own frame, nothing of the room around it.
 *
 * The operator: *"sideboarding entered from the room lobby is exactly the in-game sideboarding
 * screen; the site's top bar does not show."* `e2e/w122f-sideboard-lobby.spec.ts` proved the two
 * paths draw the SAME panel (`series/GameResultScreen.tsx`'s `SeriesSideboardPanel`) and that the
 * site header hides on a narrow phone, both paths alike — but its own desktop screenshot
 * (`docs/handoff/w122-F2/desktop-lobby-sideboard.png`, w122) still had the room's header, its
 * settings gear and the face-off drawn ABOVE the panel, pushing it below the fold: `RoomShell`
 * (`@hadoku/game-ui/rooms/screen/RoomShell.tsx`) draws its own header and, through `TablePage`,
 * the face-off, regardless of what step the table is on.
 *
 * This proves the fix: once my own table is `sideboarding`, the room screen never reaches
 * `RoomShell` at all for that table's page — the same bypass a dealt draft pod already takes
 * (`magic-room-ui.tsx`'s own early return) — so the room's header (`data-testid="room-name"`),
 * its settings gear (`data-testid="match-rules"`) and the face-off (`data-testid="table-seats"`)
 * are absent from the DOM, not merely hidden, on both a desktop viewport and a phone. The site's
 * own header (`AppHeader`, `.cardtable-chrome > .app-header`) is a different layer `RoomShell`
 * does not own; it is unchanged by this fix and reads the same on both paths at both sizes,
 * matching what the in-game screen itself already does (hidden only in portrait,
 * `TableSideboard.css`'s media rule) — `w122f-sideboard-lobby.spec.ts` already covers that half.
 *
 * `[w123f-chrome]` lines are the evidence; screenshots of both paths, both sizes, land in
 * `docs/handoff/w123-F/` (gitignored).
 */
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { makeTitled, resizeWindow, twoLegalDecks } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';
import { choosePool } from './play/pool.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const PREFIX = '/cardtable';
const MATCH_URL = /#\/match\/(m-[0-9a-f]{12})$/;
const DESKTOP = { width: 1600, height: 1000 };
const PHONE = { width: 390, height: 844 };

const say = (line: string): void => console.log(`[w123f-chrome] ${line}`);

/** The room's own chrome: the testids `RoomShell`'s header and `TablePage`'s face-off draw — absent is the claim. */
const ROOM_CHROME_TESTIDS = ['room-name', 'match-rules', 'table-seats'] as const;

async function assertNoRoomChrome(page: Page, who: string, size: string): Promise<void> {
  for (const id of ROOM_CHROME_TESTIDS) {
    await expect(page.getByTestId(id), `${who} (${size}): no ${id} — the room's own chrome, not drawn`).toHaveCount(0);
  }
}

test(
  titled('the room lobby draws my own sideboarding table with no room chrome around it, on a desktop viewport and a phone'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(5 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const alice = await openFriend(browser, 'alice');
      const bob = await openFriend(browser, 'bob');
      await resizeWindow(alice.page, DESKTOP);
      await resizeWindow(bob.page, DESKTOP);

      const choice = await twoLegalDecks(alice.context.request, stack.origin);
      await alice.page.goto(`${stack.origin}${PREFIX}/`);
      await submitCreateRoom(alice.page, { name: `e2e w123f-chrome ${Date.now()}` });
      await alice.page.waitForURL(/\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
      const roomUrl = alice.page.url();

      await bob.page.goto(roomUrl);
      await expect(alice.page.getByTestId('constructed')).toBeVisible();
      await expect(bob.page.getByTestId('constructed'), 'bob is in the room alice made').toBeVisible({ timeout: 30_000 });
      await choosePool(alice.page, choice.format);
      await expect(bob.page.getByTestId('format-fixed')).toHaveAttribute('data-format', choice.format);
      for (const [f, deck] of [
        [alice, choice.decks[0]],
        [bob, choice.decks[1]],
      ] as const) {
        await expect(f.page.getByTestId('deck-mine')).toBeEnabled();
        await f.page.getByTestId('deck-mine').locator(`[data-deck-id="${deck}"]`).click();
        await expect(f.page.getByTestId('ready-toggle'), `${f.name}: their own deck is legal`).toBeEnabled();
      }
      await alice.page.getByTestId('ready-toggle').click();
      await bob.page.getByTestId('ready-toggle').click();
      await alice.page.waitForURL(MATCH_URL, { timeout: 120_000 });
      await bob.page.waitForURL(MATCH_URL, { timeout: 120_000 });
      for (const f of [alice, bob]) await expect(f.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 60_000 });
      say('game 1 live');

      /* ── game 1 ends; alice stays on the match screen (in-game sideboard), bob leaves to the room ── */
      await bob.page.getByTestId('live-concede').click();
      await bob.page.getByTestId('live-concede-yes').click();
      for (const f of [alice, bob]) await expect(f.page.getByTestId('game-result'), `${f.name}: result`).toBeVisible({ timeout: 45_000 });
      await alice.page.getByTestId('game-result-next').click();
      await expect(alice.page.getByTestId('sideboard-step'), 'alice: in-game sideboard step').toBeVisible({ timeout: 20_000 });
      await alice.page.screenshot({ path: fileURLToPath(new URL('../docs/handoff/w123-F/desktop-ingame-sideboard.png', import.meta.url)) });

      await bob.page.goto(roomUrl);
      await expect(bob.page.getByTestId('room-table-link'), 'bob: the room draws Sideboard, not the board').toBeVisible({ timeout: 20_000 });
      await bob.page.getByTestId('room-table-link').click();
      await bob.page.waitForURL(/\/room\/r-[0-9a-f]{12}\/table\/t-[0-9a-f]{12}$/, { timeout: 20_000 });
      await expect(bob.page.getByTestId('table-sideboard'), 'bob: the table page opens the sideboard step').toBeVisible({ timeout: 20_000 });
      await expect(bob.page.getByTestId('sideboard-step'), 'bob: the lobby path reaches the same sideboard step').toBeVisible({ timeout: 20_000 });
      await bob.page.screenshot({ path: fileURLToPath(new URL('../docs/handoff/w123-F/desktop-lobby-sideboard.png', import.meta.url)) });
      say('both reached the sideboard step, at 1600x1000');

      /* ── desktop: bob's room chrome is gone — not hidden, absent ── */
      await assertNoRoomChrome(bob.page, 'bob', '1600x1000');
      // Alice's path never had room chrome to begin with (the match route draws no `RoomShell` at
      // all) — asserted too, so a future regression that routed the match THROUGH the room shell
      // would be caught here as well, not only on bob's path.
      await assertNoRoomChrome(alice.page, 'alice', '1600x1000');
      say('neither path draws the room header, its settings gear, or the face-off');

      // The panel itself sits at the same place in each page's own frame: nothing of either
      // path's chrome stands above it pushing it down by a different amount.
      const panelTop = async (page: Page): Promise<number> => {
        const box = await page.getByTestId('sideboard-step').boundingBox();
        if (box === null) throw new Error('sideboard-step has no box');
        return box.y;
      };
      const [aliceTop, bobTop] = await Promise.all([panelTop(alice.page), panelTop(bob.page)]);
      say(`panel top: alice=${aliceTop} bob=${bobTop}`);
      expect(Math.abs(aliceTop - bobTop), 'the panel sits at (near enough) the same height on both paths').toBeLessThanOrEqual(24);

      /* ── the same, on a phone ── */
      await resizeWindow(alice.page, PHONE);
      await resizeWindow(bob.page, PHONE);
      await expect(alice.page.getByTestId('sideboard-step'), 'alice: still the sideboard step, now on a phone').toBeVisible();
      await expect(bob.page.getByTestId('sideboard-step'), 'bob: still the sideboard step, now on a phone').toBeVisible();
      await assertNoRoomChrome(bob.page, 'bob', '390x844');
      await assertNoRoomChrome(alice.page, 'alice', '390x844');
      await alice.page.screenshot({ path: fileURLToPath(new URL('../docs/handoff/w123-F/phone-ingame-sideboard.png', import.meta.url)) });
      await bob.page.screenshot({ path: fileURLToPath(new URL('../docs/handoff/w123-F/phone-lobby-sideboard.png', import.meta.url)) });
      say('no room chrome on a phone either, on both paths');
    } finally {
      await stack.stop();
    }
  },
);
