/**
 * The operator, 2026-11-05, after a seat tapped an Island in its draw step and passed into Main 1 with
 * nothing left: *"if they tapped a land to make mana and try to go next phase, let's warn them with a
 * prompt and give them a chance to untap if they want to"*.
 *
 * `w52-e-island`: alice's own Main 2, one Island, nothing castable. She taps the Island and presses
 * Next Phase: the pass is held and the warning asks. Untap takes the tap back (Forge's own Undo) and
 * leaves her in Main 2 with an empty pool. She taps again, presses Next Phase, and Pass anyway passes:
 * the step ends and the pool with it. A pass with an empty pool never asks.
 *
 * The same day, of where it is drawn: *"the position should be centered on where the players cursor
 * is"*. The ask opens centred on the pointer of the press that opened it; a press from a key opens it
 * on the pointer's last spot over the board, and a spot by the board's edge keeps it whole on screen.
 * The phone's own case is `mana-floating.phone.spec.ts`.
 *
 * Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test } from '@playwright/test';

import { isTapped, makeTitled, manaPool as pool, nextPhaseLive } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { boxOf, expectCentredOn, expectWhole, islandMatch, manaAsk, phaseOf, placedAsk, pointIn, tapIsland } from './mana-floating.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('a pass with mana floating asks first, centred on the press: Untap takes the tap back, Pass anyway lets the pool empty'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { page, island } = await islandMatch(browser, stack);
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };

    // A press near the button's left end, so the button's own centre is not the answer.
    await tapIsland(page, island);
    const button = await boxOf(nextPhaseLive(page));
    const press = pointIn(button, 0.1, 0.5);
    await page.mouse.click(press.x, press.y);
    const first = await placedAsk(page);
    expectWhole(first.sheet, first.room, viewport, 'pressed with the pointer');
    expectCentredOn(first.sheet, first.room, press, 'pressed with the pointer');
    const ask = manaAsk(page);
    await expect(ask.getByTestId('live-mana-untap'), 'Untap is offered while Forge can take the tap back').toBeVisible();
    await ask.getByTestId('live-mana-untap').click();
    await expect(ask).toHaveCount(0);
    await expect.poll(() => isTapped(page, island), { timeout: 10_000, message: 'Untap untapped the Island' }).toBe(false);
    await expect.poll(async () => (await pool(page)).total, { timeout: 10_000, message: 'Untap emptied the pool' }).toBe(0);
    expect(await phaseOf(page), 'Untap did not pass: still Main 2').toBe('MAIN2');

    // The pointer rests by the board's bottom-left corner, and the pass comes from a key.
    await tapIsland(page, island);
    const board = await boxOf(page.locator('.live').first());
    const corner = { x: board.left + 6, y: board.bottom - 6 };
    await page.mouse.move(corner.x, corner.y);
    await nextPhaseLive(page).press('Enter');
    const second = await placedAsk(page);
    expectWhole(second.sheet, second.room, viewport, 'pressed from a key by the corner');
    expectCentredOn(second.sheet, second.room, corner, 'pressed from a key by the corner');
    await ask.getByTestId('live-mana-pass').click();
    await expect.poll(() => phaseOf(page), { timeout: 30_000, message: 'Pass anyway ended Main 2' }).not.toBe('MAIN2');
    await expect.poll(async () => (await pool(page)).total, { timeout: 10_000, message: 'the step took the pool with it' }).toBe(0);
    expect(await isTapped(page, island), 'the Island stays tapped after the pass').toBe(true);
  } finally {
    await stack.stop();
  }
});
