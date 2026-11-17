/**
 * Wave 121 §B, AF631 — the operator, 2026-11-16: *"summoning sickness indicator is too small"*.
 *
 * `tp-tooltips.state` (shared, `e2e/tp-tooltips.spec.ts`): alice's Hill Giant is dealt
 * summoning-sick (`|SummonSick`), so its own corner mark (`Board.tsx`'s `StateMarks`,
 * `data-mark="sick"`) is drawn on both screens — the shared mechanism every other state mark
 * (`cantBlock`, `attacking`, `blocking`) also draws through, so enlarging it enlarges all four
 * rather than special-casing one.
 *
 * `[w121b-mark]` lines are the evidence — the measured px, both before and after.
 */

import { expect, test, type Page } from '@playwright/test';

import { makeTitled, ownNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const say = (line: string): void => console.log(`[w121b-mark] ${line}`);

/** The sick mark's own rendered box, on `cardId`, on both screens — alice's own and bob's. */
function markBox(page: Page, cardId: number): Promise<{ w: number; h: number } | null> {
  return page.evaluate((cardId) => {
    const el = document.querySelector(`[data-board-card="${cardId}"] > .board-card__marks > [data-mark="sick"]`);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }, cardId);
}

test(titled('AF631: the summoning-sick mark is legible at a glance, not a 14px square'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'tp-tooltips');
    const { alice, bob } = seated;
    const [giant] = await ownNamed(alice.page, 'Hill Giant');
    expect(giant, "alice's Hill Giant is on the battlefield").not.toBeUndefined();

    const aliceBox = await markBox(alice.page, giant!);
    const bobBox = await markBox(bob.page, giant!);
    say(`alice's screen: ${JSON.stringify(aliceBox)}; bob's screen: ${JSON.stringify(bobBox)}`);
    // Before the assertions below, which throw on the base: the screenshot is before/after evidence either way.
    await alice.page.locator(`[data-board-card="${giant}"]`).screenshot({ path: test.info().outputPath('af631-sick-mark.png') });

    expect(aliceBox, 'the sick mark is drawn on alice’s own screen').not.toBeNull();
    expect(bobBox, "the sick mark is drawn on bob's screen too").not.toBeNull();
    // Legible at a glance: at least half again the 14px square this measured before the fix.
    expect(aliceBox!.w, 'the mark is wider than the old 14px box').toBeGreaterThanOrEqual(20);
    expect(aliceBox!.h, 'and taller').toBeGreaterThanOrEqual(20);
    expect(bobBox!.w).toBeCloseTo(aliceBox!.w, 0);
    expect(bobBox!.h).toBeCloseTo(aliceBox!.h, 0);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
