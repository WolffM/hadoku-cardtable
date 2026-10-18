/*
 * AF141. The operator, 2026-10-17: "mox opal: should be able to 'cancel' choosing a color to
 * untap it."
 *
 * Forge taps Mox Opal as the cost of its mana ability and only then asks which colour
 * ("Select Mana to Produce", `ManaEffect.java:119` → `chooseColorCommon`'s `getGui().one`, so
 * one pick and no cancel of Forge's own). The board offers Cancel on that question at priority:
 * the pick goes out as the first colour and the Mox is clicked again, which Forge undoes
 * (`InputPassPriority.onCardSelected` → `tryUndo`) while its mana floats.
 *
 * Scenario `af141-mox-opal`: alice's Main 1 with Mox Opal and two Ornithopters (metalcraft).
 */
import { expect, test } from '@playwright/test';

import { clickPermanent, clickRecords, isOffered, isTapped, makeTitled, manaPool, ownNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('Mox Opal: a colour picked, a click untaps it; Cancel on its colour question leaves it untapped and the pool empty'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'af141-mox-opal');
    const a = alice.page;
    await expect.poll(async () => (await ownNamed(a, 'Mox Opal')).length, { timeout: 45_000, message: 'Mox Opal is on alice’s battlefield' }).toBe(1);
    const [mox] = await ownNamed(a, 'Mox Opal');
    const prompt = a.getByTestId('live-prompt');
    const question = prompt.filter({ hasText: /Select Mana to Produce/i });

    // Picked, then clicked: Forge's own undo.
    expect(await clickPermanent(a, mox!), 'Mox Opal is offered').toBe(true);
    await expect(question, 'Forge asks which colour').toBeVisible({ timeout: 15_000 });
    await question.locator('.prompt__list li').first().click();
    const submit = question.getByTestId('prompt-submit');
    if (await submit.isVisible({ timeout: 300 }).catch(() => false)) await submit.click();
    await expect.poll(async () => (await manaPool(a)).total, { timeout: 10_000, message: 'its mana is in the pool' }).toBe(1);
    expect(await isTapped(a, mox!), 'the Mox is tapped').toBe(true);
    console.log(`[af141] picked: offered ${await isOffered(a, mox!)}, clicks ${clickRecords(stack, mox!)}`);
    expect(await clickPermanent(a, mox!, 10_000), 'the tapped Mox is offered for its untap').toBe(true);
    await expect.poll(() => isTapped(a, mox!), { timeout: 10_000, message: `a click untaps it — clicks ${clickRecords(stack, mox!)}` }).toBe(false);
    await expect.poll(async () => (await manaPool(a)).total, { timeout: 10_000, message: 'and takes its mana back' }).toBe(0);

    // Cancelled: the same end, with no colour picked.
    expect(await clickPermanent(a, mox!, 10_000), 'Mox Opal is offered again').toBe(true);
    await expect(question, 'Forge asks which colour again').toBeVisible({ timeout: 15_000 });
    await question.getByTestId('prompt-cancel').click();
    await expect.poll(() => isTapped(a, mox!), { timeout: 10_000, message: `Cancel leaves the Mox untapped — clicks ${clickRecords(stack, mox!)}` }).toBe(false);
    await expect.poll(() => isTapped(bob.page, mox!), { timeout: 10_000, message: 'on bob’s screen too' }).toBe(false);
    expect((await manaPool(a)).total, 'and the pool empty').toBe(0);
    await expect(prompt, 'nothing is left asking').toHaveCount(0, { timeout: 10_000 });
  } finally {
    await stack.stop();
  }
});
