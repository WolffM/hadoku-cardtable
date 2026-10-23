/**
 * Lane testing-states — the operator, 2026-10-23: "construct some more
 * complex board states … that i can jump into." This is the UI-level proof
 * for one of them: an admin opens "Testing: Board — Midgame" from the front
 * page's Testing section, loads any legal deck, presses Play vs AI, and lands
 * in a REAL Forge match whose battlefield already carries the scenario's
 * permanents — never a fresh dealt game. `scenario-tr-board-states.jvm.test.ts`
 * is the exhaustive per-scenario proof against Forge directly; this is the
 * one end-to-end path through the room and the UI that gets there.
 */
import { expect, test } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { ownNamed } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { twoLegalDecks } from './play/enter.ts';
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
    const choice = await twoLegalDecks(admin.context.request, stack.origin);

    await admin.page.goto(`${stack.origin}${PREFIX}/`);
    const row = admin.page.getByTestId('room-row').filter({ has: admin.page.getByTestId('room-name').getByText(ROOM_NAME, { exact: true }) });
    await expect(row, 'the Testing section lists the board-state room for an admin').toBeVisible({ timeout: 15_000 });
    await row.getByTestId('room-enter').click();
    await admin.page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 15_000 });

    await expect(admin.page.getByTestId('deck-mine')).toBeEnabled({ timeout: 15_000 });
    await admin.page.getByTestId('deck-mine').locator(`[data-deck-id="${choice.decks[0]}"]`).click();
    await expect(admin.page.getByTestId('play-vs-bot'), 'a legal deck enables Play vs AI').toBeEnabled({ timeout: 15_000 });
    await admin.page.getByTestId('play-vs-bot').click();

    await admin.page.waitForURL(/#\/match\/m-[0-9a-f]{12}$/, { timeout: 60_000 });
    await expect(admin.page.locator('[aria-label="Game board"]'), 'the match board is up').toBeVisible({ timeout: 30_000 });

    // tr-midgame.state: the scripted board, not a fresh deal — the admin's
    // own hand would otherwise be whatever their loaded deck's first seven
    // were, and a fresh game never has a planeswalker or an equipped creature
    // on turn 1.
    for (const name of ["Elspeth, Sun's Champion", 'Llanowar Elves', 'Bonesplitter', 'Hill Giant', 'Rancor']) {
      await expect.poll(() => ownNamed(admin.page, name), `the scripted ${name} is on the board`).not.toHaveLength(0);
    }
  } finally {
    await stack.stop();
  }
});
