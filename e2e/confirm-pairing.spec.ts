/**
 * A yes/no pop-up only ever shows its own question.
 *
 * Forge announces an input in two notifies, `updateButtons` and `showPromptMessage`, and an
 * `InputConfirm` sends its Yes/No bar FIRST (`InputConfirm.showMessage`). Drawn as each half
 * arrived, the yes/no window showed the new Yes/No under the previous input's line for a frame:
 * "Priority: Alice … Stack: Empty" before "Search your hand?", and "Select a card from your hand"
 * before "Cancel Search?". The surface recorder sees every DOM commit, so one such frame fails.
 *
 * `confirm-pairing.state`: alice's Aether Vial with two charge counters, Grizzly Bears in hand.
 * Tap it, let the ability resolve, answer "Search your hand?" if Forge asks it, leave the card
 * choice empty and answer Forge's "Cancel Search?".
 */
import { expect, test } from '@playwright/test';

import { enabledCancel, makeTitled, ownNamed, passOverStack, pressOffered, says, stackCount } from './play/board.ts';
import { confirmYes } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';
import { recordSurface } from './play/surface.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The two questions this scenario puts to alice, and nothing else the yes/no window may show. */
const QUESTIONS = /Search your hand\?|Cancel Search\?/;

/** The Vial's card choice is open: Grizzly Bears, which one Island cannot cast, is offered from the hand. */
const choiceOpen = async (seated: ScenarioMatch): Promise<boolean> =>
  (
    await seated.alice.page
      .locator('[data-zone="hand"][data-owner="you"] [data-board-card][data-selectable]')
      .evaluateAll((els) => els.map((e) => e.querySelector('.card__name')?.textContent?.trim()))
  ).includes('Grizzly Bears');

test(titled('a yes/no window never shows another input’s line under its Yes/No'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'confirm-pairing');
    const { alice, bob } = seated;
    const confirms = await recordSurface(alice.page, '[data-testid="live-confirm"]');

    const [vial] = await ownNamed(alice.page, 'Aether Vial');
    expect(vial, 'alice controls the Vial').toBeDefined();
    const card = alice.page.locator(`[data-board-card="${vial!}"]`);
    await expect.poll(() => card.evaluate((e) => e.hasAttribute('data-selectable')), { timeout: 45_000, message: 'the Vial is offered' }).toBe(true);
    expect(await pressOffered(card), 'the Vial pressed').toBe(true);
    await expect.poll(() => card.evaluate((e) => e.hasAttribute('data-tapped')), { timeout: 15_000, message: 'tapping the Vial activates it' }).toBe(true);

    // Pass priority over the ability on both screens; say yes to the search if Forge asks it.
    const deadline = Date.now() + 45_000;
    while (!(await choiceOpen(seated))) {
      if (Date.now() > deadline) throw new Error(`the Vial's card choice never opened — alice says "${await says(alice.page)}"`);
      if ((await confirmYes(alice.page).count()) > 0)
        await confirmYes(alice.page)
          .click({ timeout: 1_000 })
          .catch(() => undefined);
      for (const page of [alice.page, bob.page]) {
        await passOverStack(page);
      }
      await alice.page.waitForTimeout(100);
    }

    // Choose nothing: Forge asks "Cancel Search?" straight after the selection.
    await enabledCancel(alice.page).first().click();
    await expect.poll(() => confirmYes(alice.page).count(), { timeout: 15_000, message: 'Forge asks "Cancel Search?"' }).toBeGreaterThan(0);
    await confirmYes(alice.page).click();
    await expect.poll(() => stackCount(alice.page), { timeout: 15_000, message: 'the ability resolved' }).toBe(0);

    const shown = (await confirms.rows()).filter((r) => r.shown).map((r) => r.text);
    console.log(`[lc] the yes/no window showed ${JSON.stringify(shown)}`);
    expect(shown.some((t) => /Cancel Search\?/.test(t)), 'the "Cancel Search?" question was drawn').toBe(true);
    expect(
      shown.filter((t) => !QUESTIONS.test(t)),
      'every frame of the yes/no window shows its own question',
    ).toEqual([]);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
