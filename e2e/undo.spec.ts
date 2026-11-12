/**
 * Undo (`docs/planning/undo-plan.md`), on two real screens and a watcher's against real Forge.
 *
 * Turn 1, Alice's first main (`rt-restart-turn`'s board): she plays her Mountain and presses Undo; Bob
 * sees the Undo? sheet and allows. On all three screens the Mountain is back in her hand, her
 * battlefield is empty again, and her log no longer says she played it. Bob, who did nothing, has
 * nothing to undo.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test
 * SKIPS and its title says why. Serves the prebuilt `apps/ui/dist`: rebuild before running.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { clickHandCard, handCardNamed, makeTitled } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { matchUrl, startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const undo = (page: Page): Locator => page.getByTestId('live-undo');
/** Alice's battlefield as `page` draws it: her own on her screen, the other seat's on Bob's, the first seat's on a watcher's. */
const aliceLands = (page: Page, as: 'alice' | 'bob' | 'watcher'): Locator =>
  page.locator(
    as === 'alice'
      ? '.seat[data-viewer] [data-zone="battlefield"] [data-board-card]'
      : as === 'bob'
        ? '.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card]'
        : '[data-zone="battlefield"] [data-board-card]',
  );

test(titled('Undo on one screen, Allow on the other: every screen, a watcher\'s too, is back where it was before the land'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob, matchId } = await startScenarioMatch(browser, stack, 'rt-restart-turn');
    const carol = await openFriend(browser, 'carol');
    await carol.page.goto(matchUrl(stack.origin, matchId));
    await expect(carol.page.locator('[data-zone="battlefield"]').first(), 'the watcher sees the table').toBeVisible({ timeout: 30_000 });

    await expect(undo(alice.page), 'nothing to take back yet').toBeDisabled({ timeout: 30_000 });
    await expect(undo(bob.page)).toBeDisabled();
    const hand = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]');
    const handBefore = await hand.count();
    const mountain = await handCardNamed(alice.page, 'Mountain');
    expect(mountain, 'the hand holds a Mountain').toBeDefined();
    await clickHandCard(alice.page, mountain!);
    await expect(aliceLands(alice.page, 'alice')).toHaveCount(1, { timeout: 15_000 });
    await expect(aliceLands(bob.page, 'bob')).toHaveCount(1, { timeout: 15_000 });
    await expect(aliceLands(carol.page, 'watcher')).toHaveCount(1, { timeout: 15_000 });
    await expect(alice.page.getByTestId('live-log')).toContainText('Mountain', { timeout: 15_000 });

    await expect(undo(alice.page), 'the land drop can be taken back').toBeEnabled({ timeout: 15_000 });
    await expect(undo(bob.page), 'Bob did nothing').toBeDisabled();
    await undo(alice.page).click();
    await expect(undo(alice.page), 'her own ask is pressed').toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
    await expect(alice.page.getByTestId('live-restart-ask'), 'no sheet for the asker').toHaveCount(0);
    const sheet = bob.page.getByTestId('live-restart-sheet');
    await expect(sheet).toContainText('Undo?', { timeout: 10_000 });
    await expect(bob.page.getByTestId('live-restart-decline'), 'Decline is the default').toBeFocused();
    await bob.page.getByTestId('live-restart-allow').click();
    await expect(sheet).toHaveCount(0, { timeout: 10_000 });

    await expect(aliceLands(alice.page, 'alice'), 'the land is taken back').toHaveCount(0, { timeout: 30_000 });
    await expect(aliceLands(bob.page, 'bob'), 'on the other screen too').toHaveCount(0, { timeout: 30_000 });
    await expect(aliceLands(carol.page, 'watcher'), 'and on the watcher\'s').toHaveCount(0, { timeout: 30_000 });
    await expect(hand, 'the hand as it was').toHaveCount(handBefore, { timeout: 30_000 });
    await expect.poll(async () => (await handCardNamed(alice.page, 'Mountain')) !== undefined, { timeout: 30_000, message: 'the Mountain is back in hand' }).toBe(true);
    await expect(alice.page.getByTestId('live-log'), 'the log no longer says she played it').not.toContainText('Mountain', { timeout: 15_000 });
    await expect(undo(alice.page), 'nothing older to take back').toBeDisabled({ timeout: 15_000 });

    // And the game plays on from there: the land again.
    await clickHandCard(alice.page, (await handCardNamed(alice.page, 'Mountain'))!);
    await expect(aliceLands(bob.page, 'bob')).toHaveCount(1, { timeout: 15_000 });
  } finally {
    await stack.stop();
  }
});
