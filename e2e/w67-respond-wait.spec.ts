/**
 * The operator, 2026-10-09: "if i'm waiting on my opponent to respond to 'Resolve Cranial Plating?'
 * then there should at least be some kind of waiting indicator for me. all i see is my card flashing".
 * Bob holds priority over alice's spell on the stack (Full Control): alice's screen says she is
 * waiting on his response, and stops saying it the moment he passes. A priority hold with an EMPTY
 * stack stays quiet (the operator, 2026-10-08: not "simply when waiting on them").
 */
import { expect, test } from '@playwright/test';

import { clickHandCard, makeTitled, offeredNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('while bob holds priority over her spell, alice reads that she is waiting on his response — not before, not after'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'own-spell');
    await bob.page.getByTestId('live-full-control').click();
    await expect(bob.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    const pop = alice.page.getByTestId('live-waiting-pop');

    let memnite: number | undefined;
    await expect.poll(async () => (memnite = await offeredNamed(alice.page, 'Memnite')), { timeout: 60_000, message: 'alice is offered Memnite' }).not.toBeUndefined();
    await expect(pop, 'nothing to wait on before the cast').toHaveCount(0);
    await clickHandCard(alice.page, memnite!);

    // Bob holds: Memnite is on the stack and his bar is live.
    const bobOk = bob.page.locator('[data-testid="live-decision-ok"]:enabled');
    await expect(bobOk, 'bob holds priority over Memnite').toHaveCount(1, { timeout: 30_000 });
    await expect(pop, 'alice is told she waits on his response').toBeVisible({ timeout: 5_000 });
    const sentence = (await pop.textContent()) ?? '';
    console.log(`[respond-wait] alice reads "${sentence}"`);
    expect(sentence).toMatch(/respond/i);
    expect(sentence).toContain('Memnite');

    await bobOk.click();
    await expect(pop, 'gone once he passes').toHaveCount(0, { timeout: 10_000 });
  } finally {
    await stack.stop();
  }
});
