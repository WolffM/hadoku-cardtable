/**
 * The lobby's own path into the series' sideboard step.
 *
 * The operator: *"sideboarding entered from the room lobby is exactly the in-game sideboarding
 * screen; the site's top bar does not show."* Alice stays on the match screen for HER sideboard;
 * bob leaves to the room (closing nothing — the rejoin path) and presses "Sideboard" on the room's
 * own `TableCard`. Both land on the SAME panel: `data-testid="game-result"` wrapping
 * `data-testid="sideboard-step"` inside `.live__sideboard` — the exact markup
 * `series/GameResultScreen.tsx`'s `SeriesSideboardPanel` draws either way — and both hold the
 * chrome shell as `'match'` (`chrome/shell.ts`'s `data-shell`), so a narrow portrait viewport hides
 * the site's top bar on bob's lobby path the same as it does on alice's in-game one.
 *
 * The operator, elsewhere: *"the next game does not open by itself; players click to enter it."*
 * Once both are Ready, game 2 exists server-side, but NEITHER screen jumps to it — alice's (the
 * match route) and bob's (the room route) each draw "Enter game" (`data-testid="game-result-enter"`,
 * `series/GameResultScreen.tsx`'s `SeriesEnterNext`) and stay until pressed. Both learn the next
 * game through the SAME `roomFeed().follow` subscription (`TableSideboard.tsx` now follows it
 * directly, same as `GameResultScreen`), not a fixed poll.
 *
 * `[w122f-lobby]` lines are the evidence.
 */
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { makeTitled, pressIntoGame2, resizeWindow, serverLog, twoLegalDecks } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';
import { choosePool } from './play/pool.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const PREFIX = '/cardtable';
const MATCH_URL = /#\/match\/(m-[0-9a-f]{12})$/;

const say = (line: string): void => console.log(`[w122f-lobby] ${line}`);

/** A real press: the mouse moves to the button's centre and clicks there (a driver presses by state, not text). */
async function press(page: Page, testId: string): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} is not on the screen`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test(
  titled(
    'sideboarding from the room lobby is the same panel as the in-game step, and neither screen opens game 2 by itself',
  ),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(6 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const alice = await openFriend(browser, 'alice');
      const bob = await openFriend(browser, 'bob');

      const choice = await twoLegalDecks(alice.context.request, stack.origin);
      await alice.page.goto(`${stack.origin}${PREFIX}/`);
      await submitCreateRoom(alice.page, { name: `e2e w122f-lobby ${Date.now()}` });
      await alice.page.waitForURL(/\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
      const roomUrl = alice.page.url();
      const roomId = /\/room\/(r-[0-9a-f]{12})$/.exec(roomUrl)?.[1];
      if (roomId === undefined) throw new Error(`no room id in ${roomUrl}`);

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
      const matchUrl = MATCH_URL;
      await alice.page.waitForURL(matchUrl, { timeout: 120_000 });
      await bob.page.waitForURL(matchUrl, { timeout: 120_000 });
      const match1 = matchUrl.exec(alice.page.url())?.[1];
      if (match1 === undefined) throw new Error(`no match id in ${alice.page.url()}`);
      for (const f of [alice, bob]) await expect(f.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 60_000 });
      say(`game 1 live: ${match1}`);

      /* ── game 1 ends; both press Rematch (bob is the loser) ──────────── */
      await bob.page.getByTestId('live-concede').click();
      await bob.page.getByTestId('live-concede-yes').click();
      for (const f of [alice, bob]) await expect(f.page.getByTestId('game-result'), `${f.name}: result`).toBeVisible({ timeout: 45_000 });
      for (const f of [alice, bob]) await expect(f.page.getByTestId('game-result-rematch'), `${f.name}: Rematch offered`).toBeEnabled({ timeout: 15_000 });
      for (const f of [alice, bob]) await press(f.page, 'game-result-rematch');
      say('game 1 ended, bob conceded; both pressed Rematch');

      /* ── alice stays on the match screen: in-game sideboard ───────────── */
      await expect(alice.page.getByTestId('game-result-next'), 'alice: outcome with Next').toBeVisible({ timeout: 20_000 });
      await press(alice.page, 'game-result-next');
      await expect(alice.page.getByTestId('sideboard-step'), 'alice: in-game sideboard step').toBeVisible({ timeout: 20_000 });
      const aliceDom = await alice.page.getByTestId('game-result').evaluate((el) => ({
        tag: el.tagName,
        className: el.className,
        panel: el.querySelector('.live__sideboard')?.className ?? null,
        hasStep: el.querySelector('[data-testid="sideboard-step"]') !== null,
      }));
      say(`alice (in-game) panel: ${JSON.stringify(aliceDom)}`);
      await alice.page.screenshot({ path: fileURLToPath(new URL('../docs/handoff/w122-F2/desktop-ingame-sideboard.png', import.meta.url)) });

      /* ── bob leaves to the room, then presses "Sideboard" on the table card ── */
      await bob.page.goto(roomUrl);
      await expect(bob.page.getByTestId('room-table-link'), 'bob: the room draws Sideboard, not the board').toBeVisible({ timeout: 20_000 });
      // A real `<a href>`, same as `e2e/af33-back-to-room.spec.ts` and `e2e/w71-bo3.spec.ts` click it:
      // a plain Playwright `.click()`, not the `press()` helper above (that one is for the ActionButtons
      // `w69-rematch.spec.ts`'s own discipline covers; a synthetic mouse click at a computed bounding box
      // does not reliably carry an anchor's own navigation).
      await bob.page.getByTestId('room-table-link').click();
      await bob.page.waitForURL(new RegExp(`/room/${roomId}/table/`), { timeout: 20_000 });
      await expect(bob.page.getByTestId('table-sideboard'), 'bob: the table page opens the sideboard step').toBeVisible({ timeout: 20_000 });
      await expect(bob.page.getByTestId('sideboard-step'), 'bob: the lobby path reaches the same sideboard step').toBeVisible({ timeout: 20_000 });
      const bobDom = await bob.page.getByTestId('game-result').evaluate((el) => ({
        tag: el.tagName,
        className: el.className,
        panel: el.querySelector('.live__sideboard')?.className ?? null,
        hasStep: el.querySelector('[data-testid="sideboard-step"]') !== null,
      }));
      say(`bob (room lobby) panel: ${JSON.stringify(bobDom)}`);
      await bob.page.screenshot({ path: fileURLToPath(new URL('../docs/handoff/w122-F2/desktop-lobby-sideboard.png', import.meta.url)) });

      // The SAME panel, not a lookalike — same tag, same class on the outer section and the inner
      // `.live__sideboard`, both carrying a `sideboard-step`.
      expect(bobDom, "bob's lobby-entered panel matches alice's in-game one").toEqual(aliceDom);

      /* ── the site header: hidden on a narrow phone, on both paths alike ──
       * `chrome.css` only ever hides `.app-header` in PORTRAIT (`live.css`'s
       * `:root[data-layout='portrait'] [data-shell='match'] > .app-header`, or
       * `TableSideboard.css`'s own media-query duplicate of it for this lobby path) — on the
       * desktop viewport this spec otherwise runs at, the header shows on BOTH paths, which is
       * no evidence either way. Resize to a phone's shape to actually exercise it. */
      const header = (page: Page) => page.locator('.cardtable-chrome[data-shell="match"] > .app-header');
      const aliceViewport = alice.page.viewportSize();
      const bobViewport = bob.page.viewportSize();
      const phone = { width: 390, height: 844 };
      await resizeWindow(alice.page, phone);
      await resizeWindow(bob.page, phone);
      await expect(header(alice.page), 'alice (in-game): the header hides on a narrow phone').toBeHidden({ timeout: 10_000 });
      await expect(header(bob.page), 'bob (room lobby): the header hides the same way').toBeHidden({ timeout: 10_000 });
      await alice.page.screenshot({ path: fileURLToPath(new URL('../docs/handoff/w122-F2/phone-ingame-sideboard.png', import.meta.url)) });
      await bob.page.screenshot({ path: fileURLToPath(new URL('../docs/handoff/w122-F2/phone-lobby-sideboard.png', import.meta.url)) });
      say('both paths hide the top bar on a narrow phone');
      if (aliceViewport !== null) await resizeWindow(alice.page, aliceViewport);
      if (bobViewport !== null) await resizeWindow(bob.page, bobViewport);

      /* ── both ready: game 2 exists, but neither screen opens it by itself ── */
      for (const f of [alice, bob]) await f.page.getByTestId('sideboard-step').getByTestId('sideboard-ready').click();
      for (const f of [alice, bob]) {
        await expect(f.page.getByTestId('sideboard-step').getByTestId('sideboard-ready'), `${f.name}: Ready took`).toHaveAttribute('aria-pressed', 'true', {
          timeout: 15_000,
        });
      }
      say('both readied the sideboard step');

      // Alice draws `SeriesEnterNext` off the match screen's own table read.
      const aliceEnter = alice.page.getByTestId('game-result-enter');
      await expect(aliceEnter, 'alice: Enter game is offered').toBeVisible({ timeout: 90_000 });

      // Bob's own gate races two paths to the SAME guarantee (a press, never an
      // auto-navigate) — `TableSideboard`'s own `SeriesEnterNext` (its feed-driven table read), or
      // `TablePage`'s pre-existing `TableCard` ("Return to game", `table-match-link`) once the
      // room's OUTER, much slower table read catches up and swaps `TableSideboard` out from under
      // it. Both are presses the operator's own words are satisfied by; which one wins is not
      // asserted, only that one of them is there and nothing navigated on its own.
      const bobEnter = bob.page.getByTestId('game-result-enter');
      const bobCard = bob.page.getByTestId('table-match-link');
      await expect(bobEnter.or(bobCard), 'bob: a press-only way into game 2 is offered').toBeVisible({ timeout: 90_000 });
      // Alice is still on game 1's URL; bob is still on the room's.
      expect(alice.page.url(), 'alice: no auto-navigate from the match screen').not.toMatch(/#\/match\/(?!m-[0-9a-f]{12}$)/);
      expect(MATCH_URL.exec(alice.page.url())?.[1], 'alice: still game 1’s own URL').toBe(match1);
      expect(bob.page.url(), 'bob: no auto-navigate from the room screen').toContain(`/room/${roomId}`);
      say('game 2 exists; neither screen navigated — each offers its own way in');

      // Both at once, not alice-then-bob: pressing alice's own first can be the very room update
      // that finally reaches bob's `TablePage` (its OUTER table read, measured far slower than
      // `TableSideboard`'s own), swapping bob's screen from `SeriesEnterNext` to `TableCard` — or
      // back — AFTER a click is already travelling to one of them, detaching it mid-flight.
      // `pressIntoGame2` presses by STATE, re-reading which gate is there on every pass, rather
      // than one visibility snapshot (the wait above) followed by a blind click.
      await Promise.all([aliceEnter.click(), pressIntoGame2(bob.page, MATCH_URL, 60_000)]);
      const isNewMatch = (url: string): boolean => {
        const id = MATCH_URL.exec(url)?.[1];
        return id !== undefined && id !== match1;
      };
      await alice.page.waitForURL((u) => isNewMatch(u.href), { timeout: 60_000 });
      await bob.page.waitForURL((u) => isNewMatch(u.href), { timeout: 60_000 });
      const match2 = MATCH_URL.exec(alice.page.url())?.[1];
      expect(match2, 'a fresh match, not game 1 again').not.toBe(match1);
      expect(MATCH_URL.exec(bob.page.url())?.[1]).toBe(match2);
      say(`game 2 live: ${match2}, after both pressed their own way in`);
      expect(serverLog(stack).find((r) => r.evt === 'room-match-started' && r.matchId === match2), 'the server actually started game 2').toBeTruthy();
    } finally {
      await stack.stop();
    }
  },
);
