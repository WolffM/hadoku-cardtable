/**
 * Lane testing-states — the operator, 2026-10-23: "construct some more
 * complex board states … that i can jump into." This is the UI-level proof
 * for one of them: an admin presses Enter on "Testing: Board — Midgame" in the
 * front page's Testing section and lands straight in a REAL Forge match against
 * the AI whose battlefield already carries the scenario's permanents — no deck to
 * pick, no coin toss, no mulligan (the operator, 2026-10-23: "i would have
 * expected to see an active game here") — and, played again (back to the room and
 * the AI again, or a Rematch), lands on the scripted board afresh each time: the
 * operator, 2026-10-23, "just make sure that it resets properly when i try it
 * again". `scenario-tr-board-states.jvm.test.ts`
 * is the exhaustive per-scenario proof against Forge directly; this is the
 * one end-to-end path through the room and the UI that gets there.
 */
import { expect, test } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { ownNamed } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { confirmYes } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const ROOM_NAME = 'Testing: Board — Midgame';

test(forge.ok ? 'an admin starts a board-state testing room vs the AI and lands on the scripted board' : `SKIPPED: ${forge.reason}`, async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);

  const stack = await startPlayStack(forge);
  try {
    const admin = await openFriend(browser, 'admin');

    await admin.page.goto(`${stack.origin}${PREFIX}/`);
    const row = admin.page.getByTestId('room-row').filter({ has: admin.page.getByTestId('room-name').getByText(ROOM_NAME, { exact: true }) });
    await expect(row, 'the Testing section lists the board-state room for an admin').toBeVisible({ timeout: 15_000 });
    await row.getByTestId('room-enter').click();
    const first = await onScriptedBoard();

    // Played again from the room: conceded, back to the room, the AI again — a new match on the scripted board, not the old one.
    await concede();
    await admin.page.getByTestId('game-result-room').click();
    await admin.page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 15_000 });
    await expect(admin.page.getByTestId('play-vs-bot'), 'the board can be played again').toBeEnabled({ timeout: 15_000 });
    await admin.page.getByTestId('play-vs-bot').click();
    const second = await onScriptedBoard(first);
    expect(second, 'a new match, not the conceded one').not.toBe(first);

    // And by Rematch, from the result screen.
    await concede();
    await admin.page.getByTestId('game-result-rematch').click();
    const third = await onScriptedBoard(second);
    expect(new Set([first, second, third]).size, 'every start is its own match').toBe(3);

    /** The match the page moves to (never `previous`, the one it was on), on the whole scripted board with nothing answered on the way. */
    async function onScriptedBoard(previous: string | null = null): Promise<string> {
      await admin.page.waitForURL((url) => {
        const id = /#\/match\/(m-[0-9a-f]{12})$/.exec(url.href)?.[1];
        return id !== undefined && id !== previous;
      }, { timeout: 60_000 });
      await expect(admin.page.locator('[aria-label="Game board"]'), 'the match board is up').toBeVisible({ timeout: 30_000 });
      // No coin toss and no mulligan: the board room's match opens on the board.
      await expect.poll(() => ownNamed(admin.page, "Elspeth, Sun's Champion"), 'the scripted board, unasked').not.toHaveLength(0);
      await expect(admin.page.getByTestId('live-play-or-draw-play'), 'no coin toss').toHaveCount(0);
      await expect(confirmYes(admin.page), 'no mulligan').toHaveCount(0);

      // tr-midgame.state: the rest of the scripted board, not a fresh deal —
      // the admin's own hand would otherwise be whatever their loaded deck's
      // first seven were, and a fresh game never has an equipped creature or a
      // +1/+1 counter on turn 1.
      for (const name of ['Llanowar Elves', 'Bonesplitter', 'Hill Giant', 'Rancor']) {
        await expect.poll(() => ownNamed(admin.page, name), `the scripted ${name} is on the board`).not.toHaveLength(0);
      }
      return /#\/match\/(m-[0-9a-f]{12})$/.exec(admin.page.url())![1]!;
    }

    async function concede(): Promise<void> {
      await admin.page.getByTestId('live-concede').click({ timeout: 30_000 });
      await admin.page.getByTestId('live-concede-yes').click();
      await expect(admin.page.getByTestId('game-result-room'), 'the game is over').toBeVisible({ timeout: 30_000 });
    }
  } finally {
    await stack.stop();
  }
});
