/**
 * The T2 banner's own sentence, against a real Forge
 * match. Playtest 14, the operator: *"i play thirst for knowledge and my
 * opponent just sees the mini version, but i would have expected to display a
 * 'Waiting for Hadoku to {card effect they are selecting things to resolve
 * for}…'"*
 *
 * Alice casts Thirst for Knowledge (`w60-thirst.state`: four untapped
 * Islands, nothing to respond). Measured against the real jar before this
 * spec was written (`docs/planning/wave60-evidence/B/waiting.md`): the
 * draw-three-then-discard-two reaches the wire as a `setSelectables`
 * (`min:2, max:2`), never a blocking ask — which is exactly the shape
 * `match.ts`'s `waitingOnFor` has to read to say anything about it at all.
 * Bob's own banner is the one thing this spec watches on his page; nothing
 * here drives his side.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one the test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { castCard, enabledOk, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = (t: string) => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);

/** The hand card named `name`, Forge-offered or not — by its own `.card__name` text. */
async function handCardNamed(page: Page, name: string): Promise<number> {
  const ids = await page
    .locator('[data-zone="hand"][data-owner="you"] [data-board-card]')
    .evaluateAll(
      (els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))),
      name,
    );
  const id = ids[0];
  if (id === undefined) throw new Error(`no "${name}" in hand`);
  return id;
}

test(titled('the T2 banner names the verb and the host card — "Waiting for Alice to choose cards for Thirst for Knowledge…"'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w60-thirst');

    // Alice's own page: nothing to wait for before she acts.
    await expect(alice.page.getByTestId('live-waiting-pop')).toHaveCount(0);

    const thirst = await handCardNamed(alice.page, 'Thirst for Knowledge');
    await castCard(alice.page, thirst);

    // Bob's pop-up: the verb table (Settled) — `setSelectables` with min !== 1
    // reuses `getChoices`'s own slot, "choose cards". One component, one
    // testid, for both the pregame and the mid-game wait —
    // there is no separate pregame shape left to compete with this fact.
    const waiting = bob.page.getByTestId('live-waiting-pop');
    await expect(waiting, `bob's own line: "${await says(bob.page)}"`).toHaveText('Waiting for Alice to choose cards for Thirst for Knowledge…', {
      timeout: 30_000,
    });

    // Isolation (`e2e/play.spec.ts`'s own check, the shape this spec exists to
    // hold up against): the stack's own card is public, but nothing of
    // alice's HAND — what she is about to discard — ever appears on bob's page.
    for (const secret of ['Mountain']) await expect(bob.page.locator('body')).not.toContainText(`discard ${secret}`);

    // Alice answers: the five lands her draw left her, choose two.
    const hand = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card][data-selectable]');
    await expect(hand).toHaveCount(5, { timeout: 15_000 });
    const ids = await hand.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));
    for (const id of ids.slice(0, 2)) {
      await alice.page.locator(`[data-zone="hand"][data-owner="you"] [data-board-card="${id}"] button`).first().click();
    }
    await enabledOk(alice.page).click();

    // The fact clears the instant she answers — gone for bob, same as every
    // other open ask ("gone the instant it is the viewer's move",
    // read from the OTHER seat this time).
    await expect(waiting).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await stack.stop();
  }
});
