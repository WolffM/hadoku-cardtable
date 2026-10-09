/**
 * AE28 + AE29 (playtest 15, 2026-10-09): a triggered ability on the stack is drawn as an ability
 * chip — never a second copy of its card — on both screens, and its owner can drag it like a spell
 * they placed; the other screen follows the move.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, makeTitled, offeredNamed, pressPaymentAuto } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const chip = (page: Page) => page.locator('[data-placed-spell]:has([data-ability-chip])');
const centre = async (page: Page): Promise<{ x: number; y: number }> => {
  const box = (await chip(page).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test(titled('a trigger on the stack is the ability chip on both screens, and its owner drags it — the other screen follows'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-trigger');
    // Bob holds every priority window, so the trigger stays on the stack while it is looked at.
    await bob.page.getByTestId('live-full-control').click();
    await expect(bob.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');

    let witness: number | undefined;
    await expect.poll(async () => (witness = await offeredNamed(alice.page, 'Eternal Witness')), { timeout: 60_000, message: 'alice is offered Eternal Witness' }).not.toBeUndefined();
    await clickHandCard(alice.page, witness!);

    // Drive the cast and the creature's resolution until the trigger is on the stack: alice pays and
    // names the trigger's target; bob passes while the creature itself is on the stack.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && (await chip(alice.page).count()) === 0) {
      await pressPaymentAuto(alice.page);
      await answerPrompt(alice.page);
      const bobOk = bob.page.locator('[data-testid="live-decision-ok"]:enabled');
      if ((await bobOk.count()) > 0 && (await chip(bob.page).count()) === 0) await bobOk.click().catch(() => undefined);
      await alice.page.waitForTimeout(150);
    }
    await expect(chip(alice.page), 'alice sees the trigger as the ability chip').toHaveCount(1, { timeout: 10_000 });
    await expect(chip(bob.page), 'bob sees the same chip').toHaveCount(1, { timeout: 10_000 });
    await expect(alice.page.locator('[data-placed-spell]:has([data-ability-chip]) .card'), 'no card face inside the chip').toHaveCount(0);
    await expect(chip(alice.page).locator('.placed__chip-name')).toHaveText('Eternal Witness');
    await expect(chip(alice.page), 'it is hers to move').toHaveAttribute('data-mine', '');

    const bobBefore = await centre(bob.page);
    const from = await centre(alice.page);
    await alice.page.mouse.move(from.x, from.y);
    await alice.page.mouse.down();
    await alice.page.mouse.move(from.x - 260, from.y + 40, { steps: 12 });
    await alice.page.mouse.up();
    const aliceAfter = await centre(alice.page);
    console.log(`[w67-trigger] alice chip ${Math.round(from.x)},${Math.round(from.y)} → ${Math.round(aliceAfter.x)},${Math.round(aliceAfter.y)}`);
    expect(Math.abs(aliceAfter.x - (from.x - 260)), 'the chip went where she let it go').toBeLessThan(30);
    await expect
      .poll(async () => Math.abs((await centre(bob.page)).x - bobBefore.x), { timeout: 10_000, message: 'bob sees the chip move' })
      .toBeGreaterThan(150);
    console.log(`[w67-trigger] bob chip ${Math.round(bobBefore.x)} → ${Math.round((await centre(bob.page)).x)}`);
  } finally {
    await stack.stop();
  }
});
