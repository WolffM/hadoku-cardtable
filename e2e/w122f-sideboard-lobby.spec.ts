/**
 * Wave 122 §F — AF628 and AF639, the lobby's own path into the series' sideboard step.
 *
 * AF628 (the operator, 2026-11-16): *"sideboarding entered from the room lobby is exactly the
 * in-game sideboarding screen; the site's top bar does not show."* Alice stays on the match screen
 * for HER sideboard; bob leaves to the room (closing nothing — the rejoin path) and presses
 * "Sideboard" on the room's own `TableCard`. Both land on the SAME panel: `data-testid="game-result"`
 * wrapping `data-testid="sideboard-step"` inside `.live__sideboard` — the exact markup
 * `series/GameResultScreen.tsx`'s `SeriesSideboardPanel` draws either way.
 *
 * AF639 (the operator, 2026-11-16): *"the next game does not open by itself; players click to
 * enter it."* Once both are Ready, game 2 exists server-side, but NEITHER screen jumps to it —
 * alice's (the match route) and bob's (the room route) each draw "Enter game"
 * (`data-testid="game-result-enter"`, `series/GameResultScreen.tsx`'s `SeriesEnterNext`) and stay
 * until pressed. Bob's own gate is `TableSideboard.tsx`'s OWN table read, not `TablePage.tsx`'s
 * outer one (`TableCard`'s pre-existing "Return to game"): measured against real Forge, the outer
 * read took over two minutes to learn the match existed where `TableSideboard`'s own read (with
 * its fallback poll) took single-digit seconds — see that file's header comment.
 *
 * `[w122f-lobby]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, serverLog, twoLegalDecks } from './play/board.ts';
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

      // AF628: the SAME panel, not a lookalike — same tag, same class on the outer section and the
      // inner `.live__sideboard`, both carrying a `sideboard-step`.
      expect(bobDom, "bob's lobby-entered panel matches alice's in-game one").toEqual(aliceDom);

      /* ── both ready: game 2 exists, but neither screen opens it by itself ── */
      for (const f of [alice, bob]) await f.page.getByTestId('sideboard-step').getByTestId('sideboard-ready').click();
      for (const f of [alice, bob]) {
        await expect(f.page.getByTestId('sideboard-step').getByTestId('sideboard-ready'), `${f.name}: Ready took`).toHaveAttribute('aria-pressed', 'true', {
          timeout: 15_000,
        });
      }
      say('both readied the sideboard step');

      // Both screens draw the SAME gate (`SeriesEnterNext`), each off its own table read —
      // generous timeout, matching how patient `e2e/aa-polling.spec.ts` is with cross-player room
      // propagation (`TableSideboard.tsx`'s own fallback poll, not `TablePage.tsx`'s much slower
      // outer one — see that file's header comment on the real-Forge measurement).
      const aliceEnter = alice.page.getByTestId('game-result-enter');
      const bobEnter = bob.page.getByTestId('game-result-enter');
      await expect(aliceEnter, 'alice: Enter game is offered').toBeVisible({ timeout: 90_000 });
      await expect(bobEnter, 'bob: Enter game is offered').toBeVisible({ timeout: 90_000 });
      // Alice is still on game 1's URL; bob is still on the room's.
      expect(alice.page.url(), 'alice: no auto-navigate from the match screen').not.toMatch(/#\/match\/(?!m-[0-9a-f]{12}$)/);
      expect(MATCH_URL.exec(alice.page.url())?.[1], 'alice: still game 1’s own URL').toBe(match1);
      expect(bob.page.url(), 'bob: no auto-navigate from the room screen').toContain(`/room/${roomId}`);
      say('game 2 exists; neither screen navigated — each offers its own way in');

      // Both at once, not alice-then-bob: pressing alice's own first can be the very room update
      // that finally reaches bob's `TablePage` (its OUTER table read, measured far slower than
      // `TableSideboard`'s own — see that file's header), swapping bob's screen to `TableCard`
      // and pulling `game-result-enter` out from under a click still queued for it.
      await Promise.all([aliceEnter.click(), bobEnter.click()]);
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
