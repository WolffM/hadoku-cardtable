/**
 * An ability chip on the stack (`apps/ui/src/play/live/placed.ts`'s `abilityChip`), on both screens.
 *
 * Scenario `w67-trigger`: alice casts Eternal Witness; its "enters" trigger goes on the stack while
 * bob (Full Control) holds priority, so it stays there as the chip — with Forge's long description
 * ("When Eternal Witness enters, you may return target card … (Targeting: …) [Zone Changer: …]").
 * Scenario `visionary-trigger` is the same with Elvish Visionary's short "enters, draw a card".
 */
import { expect, type Locator, type Page } from '@playwright/test';

import { clickHandCard, offeredNamed, pressPaymentAuto } from './board.ts';
import { answerPrompt } from './prompts.ts';

/**
 * The placed element of the (one) ability chip on `page`. Point at THIS, never at a part of the chip
 * inside it: the chip hovers on the stack (`placed.css`), and Playwright's pointer actions wait for
 * their target to stop moving, which a part of the hovering face never does; this box stays put.
 */
export const chipOf = (page: Page): Locator => page.locator('[data-placed-spell]:has([data-ability-chip])');

/** Bob takes Full Control, alice casts `creature`, and both screens draw its trigger as the chip. */
export async function triggerOnStack(alice: Page, bob: Page, creature = 'Eternal Witness'): Promise<void> {
  await bob.getByTestId('live-full-control').click();
  await expect(bob.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
  let offered: number | undefined;
  await expect.poll(async () => (offered = await offeredNamed(alice, creature)), { timeout: 60_000, message: `alice is offered ${creature}` }).not.toBeUndefined();
  await clickHandCard(alice, offered!);
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
