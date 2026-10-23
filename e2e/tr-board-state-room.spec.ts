/**
 * Lane testing-states — the operator, 2026-10-23: "construct some more
 * complex board states … that i can jump into." This is the UI-level proof
 * for one of them: an admin opens "Testing: Board — Midgame" from the front
 * page's Testing section, loads any legal deck, presses Play vs AI, and lands
 * in a REAL Forge match whose battlefield already carries the scenario's
 * permanents — never a fresh dealt game — and, played again (back to the room and
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
    await admin.page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 15_000 });

    // ANY legal deck: the picker already narrows to the room's own (randomly
    // assigned at boot, `Lobby.create`'s `#newRoomFormat`) era — unlike a room
    // this spec created itself, there is no fixed `E2E_ERA` to rely on, and the
    // scripted board below replaces whatever hand/battlefield this deck would
    // have dealt regardless.
    await expect(admin.page.getByTestId('deck-mine')).toBeEnabled({ timeout: 15_000 });
    await admin.page.getByTestId('deck-mine').getByTestId('deck-option').first().click();
    await expect(admin.page.getByTestId('play-vs-bot'), 'a legal deck enables Play vs AI').toBeEnabled({ timeout: 15_000 });
    await admin.page.getByTestId('play-vs-bot').click();
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

    /** The match the page moves to (never `previous`, the one it was on), once it is through the coin toss and mulligan onto the whole scripted board. */
    async function onScriptedBoard(previous: string | null = null): Promise<string> {
      await admin.page.waitForURL((url) => {
        const id = /#\/match\/(m-[0-9a-f]{12})$/.exec(url.href)?.[1];
        return id !== undefined && id !== previous;
      }, { timeout: 60_000 });
      await expect(admin.page.locator('[aria-label="Game board"]'), 'the match board is up').toBeVisible({ timeout: 30_000 });
      // Forge still runs the coin toss and the admin's own mulligan on the
      // ordinary random opening before the scenario's hand/battlefield replace
      // it (`scenario-harness.jvm.test.ts`'s own proof) — a solo vs-AI game
      // still asks the human half of that. Keep clicking through whichever of
      // the two is open while polling for the scripted board.
      const playOrDraw = admin.page.getByTestId('live-play-or-draw-play');
      const keep = confirmYes(admin.page);
      const settle = async (): Promise<number[]> => {
        await playOrDraw.click({ timeout: 500 }).catch(() => undefined);
        await keep.click({ timeout: 500 }).catch(() => undefined);
        return ownNamed(admin.page, "Elspeth, Sun's Champion");
      };
      await expect.poll(settle, 'the admin is through the coin toss and mulligan onto the scripted board').not.toHaveLength(0);

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
