/**
 * The operator, on Abzan Devotee: "should not pop up the mana ability when i'm trying to drag it.
 * only on mouse up should it appear and only if it wasn't dragged." Ruling the same day: "not just
 * on release, but also only if on release and no drag happened. and yes, everything. this feature
 * is annoying because otherwise theres no way to drag cards." Retires the old press-drag-release
 * for every mana source, lands included.
 *
 * `mana-ring`, at alice's own priority, Tundra (a dual land, arrangeable like any battlefield
 * permanent): a press that moves 40 px before letting go opens no ring at ANY point — the ring is
 * never claimed off the press, so `Board.tsx`'s own reorder-drag runs instead (`data-arrange-dragging`
 * on the card) — and sends nothing; a plain release with no drag still opens the ring and picks it.
 *
 * Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test } from '@playwright/test';

import { manaPool as pool, makeTitled, ownNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { pathTo, pressPoint, ring, ringOption } from './mana-ring.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Watches `[data-testid="mana-ring"]` every frame from now until the stop; true if it was EVER seen. */
async function watchForRing(page: import('@playwright/test').Page): Promise<() => Promise<boolean>> {
  await page.evaluate(() => {
    const w = window as unknown as { __ringSeen: boolean; __ringWatch: boolean };
    w.__ringSeen = false;
    w.__ringWatch = true;
    const tick = (): void => {
      if (!w.__ringWatch) return;
      if (document.querySelector('[data-testid="mana-ring"]') !== null) w.__ringSeen = true;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return () =>
    page.evaluate(() => {
      const w = window as unknown as { __ringSeen: boolean; __ringWatch: boolean };
      w.__ringWatch = false;
      return w.__ringSeen;
    });
}

test(titled('a press on a mana source that drags away opens no ring at any point; Board’s own reorder-drag runs instead'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'mana-ring');
    const page = alice.page;
    const [tundra] = await ownNamed(page, 'Tundra');
    if (tundra === undefined) throw new Error('the scenario board is not drawn');

    // A press that crosses the drag slop: no ring opens at any frame, and Board's own reorder-drag
    // takes the press instead (never claimed off it by AF582's old press-time open).
    const from = await pressPoint(page, tundra);
    const stopWatch = await watchForRing(page);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // `Board.tsx`'s own reorder-drag only marks `data-arrange-dragging` once the press crosses ITS
    // OWN slop (`onMove`'s `begin()`) — never on the bare press — so the moves come first.
    for (const p of pathTo(from, { x: from.x + 40, y: from.y }, 8)) await page.mouse.move(p.x, p.y);
    await expect(page.locator(`[data-board-card="${tundra}"][data-arrange-dragging]`), 'Board’s own reorder-drag claimed the press').toBeVisible({ timeout: 2_000 });
    await page.mouse.up();
    expect(await stopWatch(), 'no ring opened at any point during the drag').toBe(false);
    await expect(ring(page), 'none is open after the release either').toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await ring(page).count(), 'and nothing opened late').toBe(0);

    // A plain release with no drag still opens the ring, and a pick on it still works.
    const again = await pressPoint(page, tundra);
    await page.mouse.click(again.x, again.y);
    await expect(ring(page).getByTestId('mana-ring-hub'), 'a tap still opens the ring').toBeVisible({ timeout: 10_000 });
    await ringOption(page, 'W').click();
    await expect.poll(async () => (await pool(page)).W, { timeout: 10_000, message: 'Tundra added {W}' }).toBe(1);
  } finally {
    await stack.stop();
  }
});
