/**
 * A player who closes the tab mid-game is gone for the one still at the table
 * — and back when they return.
 *
 * The rejoin audit, 2026-10-19: with one player's tab closed for 40 s the other
 * still read "is choosing to play or draw…", with no sign the other player had
 * left. The server now marks a seat away once its grace runs out (`forge:seats`'
 * `away`), and the board says "Waiting for <name> to reconnect…" until they do.
 */

import { expect, test } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { confirmYes } from './play/confirm.ts';
import { enterMatch } from './play/enter.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('a player who closes the tab is shown as gone to the other, and back once they reopen the match'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await enterMatch(alice, bob, stack.origin);

    // The coin winner chooses; then one of them is asked Keep/Mulligan first.
    await expect
      .poll(async () => (await alice.page.getByTestId('live-play-or-draw-play').count()) + (await bob.page.getByTestId('live-play-or-draw-play').count()), {
        timeout: 45_000,
        message: 'the coin winner is asked to play or draw',
      })
      .toBe(1);
    const winner = (await alice.page.getByTestId('live-play-or-draw-play').count()) > 0 ? alice : bob;
    await winner.page.getByTestId('live-play-or-draw-play').click();
    await expect
      .poll(async () => (await confirmYes(alice.page).count()) + (await confirmYes(bob.page).count()), { timeout: 30_000, message: 'a Keep/Mulligan is open' })
      .toBeGreaterThan(0);
    const asked = (await confirmYes(alice.page).count()) > 0 ? alice : bob;
    const other = asked === alice ? bob : alice;
    const matchUrl = asked.page.url();
    // Should both be asked at once, the other keeps: only a player with nothing of their own open waits.
    if ((await confirmYes(other.page).count()) > 0) await confirmYes(other.page).click();

    // The asked player closes the tab, with their question open.
    await asked.page.close();
    const pop = other.page.getByTestId('live-waiting-pop');
    // The server's grace is 30 s: a reload is not a departure, a closed tab past it is.
    await expect(pop, 'the other player is told they left').toContainText('to reconnect', { timeout: 60_000 });

    // Back by the same link: the question is theirs again, and the other stops waiting on a reconnect.
    const back = await asked.context.newPage();
    await back.goto(matchUrl);
    await expect(confirmYes(back), 'the Keep/Mulligan is open again').toBeVisible({ timeout: 30_000 });
    await expect(pop, 'back at the table').not.toContainText('to reconnect', { timeout: 15_000 });
  } finally {
    await stack.stop();
  }
});
