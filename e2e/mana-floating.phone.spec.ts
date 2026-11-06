/**
 * The mana-floating ask on a phone (`mana-floating.spec.ts` has the desktop's): it opens centred across
 * the tap that opened it but never under the finger, standing just above the tap point, whole on the
 * board above the bar. Pass anyway still passes.
 *
 * Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test } from '@playwright/test';

import { makeTitled, manaPool as pool, nextPhaseLive } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { PHONE } from './play/phone.ts';
import { boxOf, expectCentredOn, expectWhole, islandMatch, manaAsk, NEAR_PX, phaseOf, placedAsk, pointIn, tapIsland } from './mana-floating.ts';

test.use(PHONE);

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('on a phone the mana-floating ask opens just above the tap that opened it, whole on the board'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { page, island } = await islandMatch(browser, stack);
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    await tapIsland(page, island);
    const button = await boxOf(nextPhaseLive(page));
    const tap = pointIn(button, 0.25, 0.5);
    await page.touchscreen.tap(tap.x, tap.y);
    const { sheet, room } = await placedAsk(page);
    expectWhole(sheet, room, viewport, 'tapped');
    expect(sheet.bottom, 'the ask stands above the finger, never under it').toBeLessThanOrEqual(tap.y);
    expect(tap.y - sheet.bottom, 'just above it').toBeLessThanOrEqual(NEAR_PX * 3);
    expectCentredOn(sheet, room, { x: tap.x, y: (sheet.top + sheet.bottom) / 2 }, 'tapped, across');
    await manaAsk(page).getByTestId('live-mana-pass').tap();
    await expect.poll(() => phaseOf(page), { timeout: 30_000, message: 'Pass anyway ended Main 2' }).not.toBe('MAIN2');
    await expect.poll(async () => (await pool(page)).total, { timeout: 10_000, message: 'the step took the pool with it' }).toBe(0);
  } finally {
    await stack.stop();
  }
});
