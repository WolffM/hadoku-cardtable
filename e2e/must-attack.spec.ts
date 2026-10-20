/**
 * An attack Forge would refuse cannot be declared, against a real Forge match.
 *
 * The same class of rule as a menace block: Forge's `InputAttack` enables its OK whatever is
 * declared, and `PhaseHandler` checks the declaration only after the press
 * (`CombatUtil.validateAttackers`, `PhaseHandler.java:545-550`), asking again on a failure. The
 * bridge sends that validator's verdict on every bar (`refusal1`, `PlayBridge.java`'s
 * `buttonOneRefusal`); Done Attacking is off while it is set, and its hover says why.
 *
 * Scenario `must-attack`: alice (seat 0) holds Juggernaut ("attacks each combat if able") and
 * Grizzly Bears; bob has no creature.
 *
 * - Nothing declared, then the Bears alone: Done Attacking is disabled, its tooltip in Forge's words.
 * - Juggernaut joins: enabled; Done; both attack, and bob takes 7.
 *
 * Every step prints one `[must-attack]` line.
 */

import { expect, test, type Page } from '@playwright/test';

import { clickOnce, enabledOk, makeTitled, says } from './play/board.ts';
import { clickCard, decisionOk, decisionOkTip, ownBattlefieldCards, passToDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[must-attack] ${JSON.stringify({ step, data })}`);

/** The id of the viewer's own battlefield card of this name. */
async function ownNamed(page: Page, name: string): Promise<number> {
  const ids = await ownBattlefieldCards(page).evaluateAll(
    (els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))),
    name,
  );
  if (ids.length !== 1) throw new Error(`expected one ${name} on alice's battlefield, found ${ids.length}`);
  return ids[0]!;
}

/** The viewer's own life total, as their screen draws it. */
const ownLife = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const seat = Array.from(document.querySelectorAll('[data-testid="player"]')).find((s) => s.hasAttribute('data-viewer'));
    return seat?.querySelector('[data-testid="life"]')?.textContent?.trim() ?? null;
  });

/** Done Attacking off, saying why on hover. */
async function refused(page: Page, step: string): Promise<void> {
  try {
    await expect(decisionOk(page), `${step}: Done Attacking is off`).toBeDisabled({ timeout: 5_000 });
  } finally {
    log(step, { label: await decisionOk(page).textContent(), disabled: await decisionOk(page).isDisabled(), says: await says(page) });
  }
  const tip = await decisionOkTip(page);
  log(`${step} tip`, tip);
  expect(tip, 'the hover says why, in Forge’s words').toBe('Attack declaration invalid');
}

test(titled('Juggernaut must attack: Done Attacking is off and says why until Juggernaut is declared, then Forge takes the attack'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'must-attack');
    const alice = seated.alice.page;
    const bob = seated.bob.page;
    await expect(ownBattlefieldCards(alice), 'alice holds Juggernaut and the Bears').toHaveCount(2);
    const juggernaut = await ownNamed(alice, 'Juggernaut');
    const bears = await ownNamed(alice, 'Grizzly Bears');
    await passToDeclareAttackers(alice);
    await expect(decisionOk(alice)).toHaveText('Done Attacking');

    await refused(alice, 'nothing declared');

    await clickCard(alice, bears);
    await expect(alice.locator(`[data-board-card="${bears}"]`), 'the Bears are declared').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
    await refused(alice, 'bears only');

    await clickCard(alice, juggernaut);
    await expect(alice.locator(`[data-board-card="${juggernaut}"]`), 'Juggernaut is declared').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
    await expect(decisionOk(alice), 'Juggernaut attacking: Done Attacking is on').toBeEnabled({ timeout: 5_000 });
    const tip = await decisionOkTip(alice);
    log('juggernaut declared', { disabled: await decisionOk(alice).isDisabled(), tip });
    expect(tip, 'nothing to explain').toBeNull();

    await decisionOk(alice).click();
    await expect
      .poll(
        async () => {
          const line = await says(alice);
          if (/^Priority:/.test(line) && (await enabledOk(alice).count()) > 0) await clickOnce(alice, line, 'ok');
          return ownLife(bob);
        },
        { timeout: 30_000, message: 'Juggernaut and the Bears deal bob 7' },
      )
      .toBe('13');
    log('declared', { bobLife: await ownLife(bob) });
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
