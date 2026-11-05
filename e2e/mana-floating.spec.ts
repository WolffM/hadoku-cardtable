/**
 * The operator, 2026-11-05, after a seat tapped an Island in its draw step and passed into Main 1 with
 * nothing left: *"if they tapped a land to make mana and try to go next phase, let's warn them with a
 * prompt and give them a chance to untap if they want to"*.
 *
 * `w52-e-island`: alice's own Main 2, one Island, nothing castable. She taps the Island and presses
 * Next Phase: the pass is held and the warning asks. Untap takes the tap back (Forge's own Undo) and
 * leaves her in Main 2 with an empty pool. She taps again, presses Next Phase, and Pass anyway passes:
 * the step ends and the pool with it. A pass with an empty pool never asks.
 *
 * Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickPermanent, isTapped, makeTitled, manaPool as pool, nextPhaseLive, ownNamed } from './play/board.ts';
import { railAt } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { PASS_WITH_MANA_GLOBAL } from './prefsLocal.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const phaseOf = async (page: Page): Promise<string> => (await railAt(page))?.phase ?? '';

async function tapIsland(page: Page, island: number): Promise<void> {
  expect(await clickPermanent(page, island, 10_000), 'the Island is offered in a live window').toBe(true);
  await expect.poll(() => isTapped(page, island), { timeout: 10_000, message: 'the Island tapped' }).toBe(true);
  await expect.poll(async () => (await pool(page)).U, { timeout: 10_000, message: 'the Island added {U}' }).toBe(1);
}

test(titled('a pass with mana floating asks first: Untap takes the tap back, Pass anyway lets the pool empty'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w52-e-island');
    const page = alice.page;
    const island = (await ownNamed(page, 'Island'))[0];
    if (island === undefined) throw new Error('no Island on the viewer battlefield');
    await expect.poll(() => phaseOf(page), { timeout: 30_000 }).toBe('MAIN2');
    // Every e2e seat passes unasked (`passWithManaUnasked`); this one is a player's.
    await page.evaluate((key) => delete (globalThis as Record<string, unknown>)[key], PASS_WITH_MANA_GLOBAL);

    await tapIsland(page, island);
    await nextPhaseLive(page).click();
    const ask = page.getByTestId('live-mana-ask');
    await expect(ask, 'the pass is held for a word').toBeVisible({ timeout: 10_000 });
    await expect(ask.getByTestId('live-mana-untap'), 'Untap is offered while Forge can take the tap back').toBeVisible();
    await ask.getByTestId('live-mana-untap').click();
    await expect(ask).toHaveCount(0);
    await expect.poll(() => isTapped(page, island), { timeout: 10_000, message: 'Untap untapped the Island' }).toBe(false);
    await expect.poll(async () => (await pool(page)).total, { timeout: 10_000, message: 'Untap emptied the pool' }).toBe(0);
    expect(await phaseOf(page), 'Untap did not pass: still Main 2').toBe('MAIN2');

    await tapIsland(page, island);
    await nextPhaseLive(page).click();
    await expect(ask, 'asked again').toBeVisible({ timeout: 10_000 });
    await ask.getByTestId('live-mana-pass').click();
    await expect.poll(() => phaseOf(page), { timeout: 30_000, message: 'Pass anyway ended Main 2' }).not.toBe('MAIN2');
    await expect.poll(async () => (await pool(page)).total, { timeout: 10_000, message: 'the step took the pool with it' }).toBe(0);
    expect(await isTapped(page, island), 'the Island stays tapped after the pass').toBe(true);
  } finally {
    await stack.stop();
  }
});
