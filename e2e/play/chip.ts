/**
 * An ability chip on the stack (`apps/ui/src/play/live/placed.ts`'s `abilityChip`), on both screens.
 *
 * Scenario `w67-trigger`: alice casts Eternal Witness; its "enters" trigger goes on the stack while
 * bob (Full Control) holds priority, so it stays there as the chip — with Forge's long description
 * ("When Eternal Witness enters, you may return target card … (Targeting: …) [Zone Changer: …]").
 */
import { expect, type Locator, type Page } from '@playwright/test';

import { clickHandCard, offeredNamed, pressPaymentAuto } from './board.ts';
import { answerPrompt } from './prompts.ts';

/** The placed element of the (one) ability chip on `page`. */
export const chipOf = (page: Page): Locator => page.locator('[data-placed-spell]:has([data-ability-chip])');

/** Bob takes Full Control, alice casts Eternal Witness, and both screens draw its trigger as the chip. */
export async function witnessTriggerOnStack(alice: Page, bob: Page): Promise<void> {
  await bob.getByTestId('live-full-control').click();
  await expect(bob.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
  let witness: number | undefined;
  await expect.poll(async () => (witness = await offeredNamed(alice, 'Eternal Witness')), { timeout: 60_000, message: 'alice is offered Eternal Witness' }).not.toBeUndefined();
  await clickHandCard(alice, witness!);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && (await chipOf(alice).count()) === 0) {
    await pressPaymentAuto(alice);
    await answerPrompt(alice);
    const bobOk = bob.locator('[data-testid="live-decision-ok"]:enabled');
    if ((await bobOk.count()) > 0 && (await chipOf(bob).count()) === 0) await bobOk.click().catch(() => undefined);
    await alice.waitForTimeout(150);
  }
  await expect(chipOf(alice), 'alice sees the chip').toHaveCount(1, { timeout: 10_000 });
  await expect(chipOf(bob), 'bob sees the chip').toHaveCount(1, { timeout: 10_000 });
}
