/**
 * The operator, 2026-10-26: *"all attack button on all attackers"*, then *"lets just do 'All' but
 * even when All is clicked we should still be able to manually change the attackers afterwards. All
 * should essentially just function as a macro for dragging the arrows in one click."*
 *
 * `box-aim-face` (already used by `box-aim.spec.ts`) gives alice three of her own untapped,
 * non-sick creatures and bob as the only legal defender, so "All" has nothing to be ambiguous about
 * — exactly the shape `attackAllTarget` (`LiveBoard.tsx`) reuses from the drag path (`combatCandidates`
 * + `attackAssignment`, filtered to `'assign'`, sent through `attackWith` — `gestures/commit.ts`'s own
 * function for a drag's release and a box's aim).
 *
 * Real two-human match (`startScenarioMatch`), so "the opponent sees N" is a real second page, not a
 * read of alice's own view of bob. Parity with a drag, not a stronger claim than one: like a drag or
 * a box, the opponent's screen is read once the declaration is COMMITTED (Done pressed) —
 * `af66-combat-priority.spec.ts` and `combat-stop.spec.ts` read their own defender's screen the same
 * way, after the attacker's own Done. Nothing here asserts what the opponent's screen shows BEFORE
 * Done.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { attackingCards, clickCard, decisionOk, passToDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Alice's own battlefield creatures, by id — `box-aim-face` gives her exactly three. */
async function ownCreatures(page: Page): Promise<number[]> {
  const ids = await page
    .locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card')
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));
  expect(ids, 'alice has her three creatures').toHaveLength(3);
  return ids;
}

/** The "All" button in the declare-attackers decision pop-up. */
const allButton = (page: Page): ReturnType<Page['getByTestId']> => page.getByTestId('live-attack-all');

test(titled('"All" declares every legal attacker, stays editable, and Done commits it the opponent sees'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'box-aim-face');
    const { alice, bob } = seated;
    const creatures = await ownCreatures(alice.page);

    await passToDeclareAttackers(alice.page);
    for (const id of creatures) {
      await expect(alice.page.locator(`[data-board-card="${id}"]`), `creature ${id} is offered to attack`).toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });
    }

    // Nothing is attacking yet, and "All" is the one thing on offer besides Done.
    expect(await attackingCards(alice.page).count(), 'nobody attacks yet').toBe(0);
    await expect(allButton(alice.page), 'the "All" button is offered').toBeVisible();

    // 1. One press. Every legal attacker's arrow, on alice's own screen.
    await allButton(alice.page).click();
    await expect.poll(() => attackingCards(alice.page).count(), { timeout: 10_000, message: 'all three declared on alice’s own screen' }).toBe(3);
    for (const id of creatures) {
      await expect(alice.page.locator(`[data-board-card="${id}"]`), `creature ${id} is attacking on alice’s screen`).toHaveAttribute('data-attacking', 'true');
    }

    // 2. Every arrow "All" drew stays editable: a click on one of them un-declares it, same as a
    // click would on an attacker a drag had declared (`gestures/commit.ts`'s own toggle).
    await clickCard(alice.page, creatures[0]!);
    await expect.poll(() => attackingCards(alice.page).count(), { timeout: 10_000, message: 'one was removed by hand' }).toBe(2);

    // 3. Done. The declaration is committed; the opponent's screen sees N−1, alice's own still does too.
    await decisionOk(alice.page).click();
    await expect.poll(() => attackingCards(bob.page).count(), { timeout: 10_000, message: 'bob sees N−1 once Done commits it' }).toBe(2);
    expect(await attackingCards(alice.page).count(), 'alice still shows N−1 too').toBe(2);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
