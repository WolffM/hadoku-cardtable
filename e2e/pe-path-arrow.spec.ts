/**
 * The operator, 2026-11-17 (m-f1e1958ca49b): "path of exile's targeting arrow presists even after the
 * creature has already been exiled. it happens because part of the spells resolution is searching for
 * a land." The AI's Path to Exile exiled their Lotus Cobra 47 ms after the cast; they then searched for
 * a basic land for 12.7 s with Path still on the stack, and its arrow pointed into their exile pile.
 *
 * Against real Forge, two seats: bob casts Path at alice's Grizzly Bears. While alice holds priority
 * over it, her screen draws its arrow to the Bears (sampled every frame). Once it resolves, the Bears are in her exile and the
 * land search is hers, with Path still on the stack: no arrow may be drawn then.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one it SKIPS.
 */
import { expect, test } from '@playwright/test';

import { castUntilOnStack, makeTitled, offeredNamed, ownNamed, passOverStack, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('pe — Path to Exile’s arrow goes with the creature it exiled, while its controller still searches for a land'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'pe-path-arrow');
    const [bears] = await ownNamed(alice.page, 'Grizzly Bears');
    expect(bears, 'the Bears are on alice’s side').toBeGreaterThan(0);
    // Every frame on alice's screen: whether Path's arrow is drawn while the Bears are still on her battlefield.
    await alice.page.evaluate((id) => {
      const w = window as unknown as { __aimedOnField: boolean };
      w.__aimedOnField = false;
      const start = performance.now();
      const sample = (): void => {
        const onField = document.querySelector(`.seat[data-viewer] [data-zone="battlefield"] [data-board-card="${id}"]`) !== null;
        if (onField && document.querySelector('[data-board-overlay] [data-testid="placed-arrow"]') !== null) w.__aimedOnField = true;
        if (performance.now() - start < 120_000) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, bears!);
    await expect.poll(() => offeredNamed(bob.page, 'Path to Exile'), { timeout: 45_000, message: 'bob is offered Path to Exile' }).not.toBeUndefined();
    const path = (await offeredNamed(bob.page, 'Path to Exile'))!;
    await castUntilOnStack(bob.page, stack, path, [bob.page.locator(`.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card="${bears}"]`)]);

    const page = alice.page;
    const placed = page.locator('[data-board-overlay] [data-testid="placed-arrow"]');
    const exiled = page.locator(`.seat[data-viewer] [data-zone="exile"] [data-board-card="${bears}"]`);
    const pathOnStack = page.locator('[data-zone="stack"][data-count="1"]');
    // Pass over Path until it has exiled the Bears; never press once they are gone, which is the search.
    for (let i = 0; i < 300 && (await exiled.count()) === 0; i++) {
      await passOverStack(page);
      await page.waitForTimeout(60);
    }
    await expect(exiled, 'the Bears are in alice’s exile').toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { __aimedOnField: boolean }).__aimedOnField), 'Path’s arrow was drawn to the Bears on alice’s battlefield').toBe(true);
    await expect(pathOnStack, `Path is still on the stack, asking alice to search (she is told "${await says(page)}")`).toHaveCount(1);
    await page.waitForTimeout(800);
    await expect(pathOnStack, 'still searching').toHaveCount(1);
    expect(await placed.count(), 'no arrow follows the Bears into exile').toBe(0);
  } finally {
    await stack.stop();
  }
});
