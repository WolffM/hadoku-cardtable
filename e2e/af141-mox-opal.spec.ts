/*
 * The operator, 2026-10-17: "mox opal: should be able to 'cancel' choosing a color to untap it."
 *
 * Forge taps Mox Opal as the cost of its mana ability and only then asks which colour ("Select Mana
 * to Produce", `ManaEffect.java`'s `chooseColor`: one pick, no cancel of Forge's own), drawn as the
 * mana ring. At priority the ring can be given up (Escape, or a press away): the first colour goes
 * out and the Mox is clicked again, which Forge undoes (`InputPassPriority.onCardSelected` →
 * `tryUndo`) while its mana floats. A picked colour still floats.
 *
 * Scenario `af141-mox-opal`: alice's Main 1 with Mox Opal and two Ornithopters (metalcraft).
 */
import { expect, test } from '@playwright/test';

import { ring, ringOption } from './mana-ring.ts';
import { clickPermanent, clickRecords, isTapped, makeTitled, manaPool, ownNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled("Mox Opal: giving up its colour question untaps it on both screens and floats nothing; a picked colour floats"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'af141-mox-opal');
    const a = alice.page;
    await expect.poll(async () => (await ownNamed(a, 'Mox Opal')).length, { timeout: 45_000, message: 'Mox Opal is on alice’s battlefield' }).toBe(1);
    const [mox] = await ownNamed(a, 'Mox Opal');
    const question = a.locator('[data-testid="mana-ring"][data-method="getChoices"]');

    // Given up: Forge's undo leaves it as it was.
    expect(await clickPermanent(a, mox!), 'Mox Opal is offered').toBe(true);
    await expect(question, 'Forge asks which colour').toBeVisible({ timeout: 15_000 });
    await a.keyboard.press('Escape');
    await expect.poll(() => isTapped(a, mox!), { timeout: 10_000, message: `giving it up leaves the Mox untapped — clicks ${clickRecords(stack, mox!)}` }).toBe(false);
    await expect.poll(() => isTapped(bob.page, mox!), { timeout: 10_000, message: 'on bob’s screen too' }).toBe(false);
    await expect.poll(async () => (await manaPool(a)).total, { timeout: 10_000, message: 'and the pool empty' }).toBe(0);
    await expect(ring(a), 'nothing is left asking').toHaveCount(0, { timeout: 10_000 });

    // Picked: the colour floats and the Mox stays tapped.
    expect(await clickPermanent(a, mox!, 15_000), 'Mox Opal is offered again').toBe(true);
    await expect(question, 'Forge asks which colour again').toBeVisible({ timeout: 15_000 });
    await ringOption(a, 'U').click();
    await expect.poll(async () => (await manaPool(a)).U, { timeout: 10_000, message: 'its blue is in the pool' }).toBe(1);
    expect(await isTapped(a, mox!), 'the Mox is tapped').toBe(true);
  } finally {
    await stack.stop();
  }
});
