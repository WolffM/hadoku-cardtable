/**
 * Restart turn (`docs/planning/restart-turn-plan.md`), on two real screens against real Forge.
 *
 * Turn 2, Bob's: he plays a land and asks; Alice sees the sheet and declines. The land stays,
 * and Bob's button greys for the rest of the turn. Turn 3, Alice's: she plays a land and asks;
 * Bob allows. Both screens start the turn again from its start, the land is back in her hand,
 * and she can play on.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test
 * SKIPS and its title says why. Serves the prebuilt `apps/ui/dist`: rebuild before running.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { clickHandCard, handCardNamed, makeTitled, nextPhaseLive } from './play/board.ts';
import { railAt } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const restart = (page: Page): Locator => page.getByTestId('live-restart-turn');
const lands = (page: Page, whose: 'mine' | 'theirs'): Locator =>
  page.locator(`.seat${whose === 'mine' ? '[data-viewer]' : ':not([data-viewer])'} [data-zone="battlefield"] [data-board-card]`);

/**
 * Pass both screens on until `turn` is `owner`'s own main phase, pressing by state only: the
 * active screen's End Turn, and its Next Phase where the end-step stop holds it — once per turn
 * and step.
 */
async function passTo(owner: Page, other: Page, turn: number): Promise<void> {
  const pressed = new Set<string>();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const at = await railAt(owner);
    if (at !== null && at.turn === turn && at.whose === 'yours' && at.phase === 'MAIN1') return;
    for (const page of [owner, other]) {
      const now = await railAt(page);
      if (now === null || now.whose !== 'yours' || now.turn >= turn) continue;
      const key = `${now.turn}:${now.phase}`;
      if (pressed.has(key)) continue;
      const end = page.getByTestId('live-button-end-turn');
      if (now.phase !== 'END_OF_TURN' && (await end.isEnabled())) {
        pressed.add(key);
        await end.click({ timeout: 2_000 }).catch(() => pressed.delete(key));
      } else if (now.live) {
        pressed.add(key);
        await nextPhaseLive(page).click({ timeout: 2_000 }).catch(() => pressed.delete(key));
      }
    }
    await owner.waitForTimeout(50);
  }
  throw new Error(`turn ${turn} never reached its own main phase: ${JSON.stringify(await railAt(owner))}`);
}

/** Play the hand's land of this name and wait for it on both screens. */
async function playLand(page: Page, other: Page, name: string): Promise<void> {
  const id = await handCardNamed(page, name);
  expect(id, `the hand holds a ${name}`).toBeDefined();
  await clickHandCard(page, id!);
  await expect(lands(page, 'mine'), `${name} on its owner's battlefield`).toHaveCount(1, { timeout: 15_000 });
  await expect(lands(other, 'theirs'), `${name} on the other screen`).toHaveCount(1, { timeout: 15_000 });
}

test(titled('a declined ask leaves the turn as it is; an allowed one starts it again from its start, the land back in hand'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'rt-restart-turn');
    await expect(restart(alice.page), 'turn 1 opened past its upkeep: no snapshot, no restart').toBeDisabled({ timeout: 30_000 });

    /* ── turn 2, Bob's: asked and declined ───────────────────────────── */
    await passTo(bob.page, alice.page, 2);
    await expect(restart(alice.page), "not on the other seat's turn").toBeDisabled();
    await playLand(bob.page, alice.page, 'Mountain');
    await expect(restart(bob.page)).toBeEnabled({ timeout: 15_000 });
    await restart(bob.page).click();
    await expect(restart(bob.page), 'his own ask is pressed').toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
    await expect(bob.page.getByTestId('live-restart-ask'), 'no sheet for the asker').toHaveCount(0);
    const sheet = alice.page.getByTestId('live-restart-sheet');
    await expect(sheet).toContainText('asks to restart turn 2.', { timeout: 10_000 });
    await expect(alice.page.getByTestId('live-restart-decline'), 'Decline is the default').toBeFocused();
    await alice.page.getByTestId('live-restart-decline').click();
    await expect(sheet).toHaveCount(0, { timeout: 10_000 });
    await expect(restart(bob.page), 'declined: no second ask this turn').toBeDisabled({ timeout: 10_000 });
    await expect(lands(bob.page, 'mine'), 'the land stays').toHaveCount(1);

    /* ── turn 3, Alice's: asked and allowed ──────────────────────────── */
    await passTo(alice.page, bob.page, 3);
    await expect(restart(alice.page), 'a new turn: a new ask').toBeEnabled({ timeout: 15_000 });
    const handBefore = await alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]').count();
    await playLand(alice.page, bob.page, 'Mountain');
    await restart(alice.page).click();
    await expect(bob.page.getByTestId('live-restart-sheet')).toContainText('asks to restart turn 3.', { timeout: 10_000 });
    await bob.page.getByTestId('live-restart-allow').click();

    // The match starts again from turn 3's start, on a new epoch: both screens resync onto it.
    await expect(lands(alice.page, 'mine'), 'the land played this turn is undone').toHaveCount(0, { timeout: 60_000 });
    await expect(lands(bob.page, 'theirs'), 'on the other screen too').toHaveCount(0, { timeout: 30_000 });
    await expect(alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]'), 'the hand as the turn began, the same draw in it').toHaveCount(handBefore, { timeout: 30_000 });
    await expect.poll(async () => (await railAt(alice.page))?.turn, { timeout: 30_000, message: 'still turn 3' }).toBe(3);
    await expect.poll(async () => (await handCardNamed(alice.page, 'Mountain')) !== undefined, { timeout: 30_000, message: 'the Mountain is back in hand' }).toBe(true);

    // And the turn plays on: the land again, on the restarted game.
    await passTo(alice.page, bob.page, 3);
    await playLand(alice.page, bob.page, 'Mountain');
  } finally {
    await stack.stop();
  }
});
