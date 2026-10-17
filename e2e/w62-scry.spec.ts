/**
 * Against real Forge. The operator, 2026-10-08: *"dragging
 * cards for scrying is a bit inconsistent. can we us the same phantom card
 * and placement logic we use for putting cards on the board? also, when
 * cards have been selected to be put on bottom and we show the up/down
 * arrow for reordering let's display those up/down arrows on top of the
 * card rather than in their own row. that makes it look a bit more
 * compact."*
 *
 * `w62-scry.state`: alice holds Preordain ("Scry 2. Draw a card.") and one
 * untapped Island, an uncontested turn-1 Main Phase 1. Measured against
 * this exact jar (`docs/planning/wave62-evidence/S/scry.md`): casting it
 * opens Forge's `order` ask (`OrderPrompt.tsx`'s dual list), never
 * `manipulateCardList` — so this spec drives THAT component's own
 * press-drag (`apps/ui/src/play/prompts/row-drag.ts`, the board's phantom,
 * shared with `ManipulateCardListPrompt.tsx`), never an HTML5
 * `dragstart`/`dragover`/`drop` sequence.
 *
 * The on-card ↑/↓ were the second half of that note. Since 2026-10-15 an
 * order over cards is a pile (`e2e/od-order-pile.spec.ts`): a card behind
 * shows only its name strip, which has no room for them, so a focused card
 * moves with the arrow keys, up the pile or down it as drawn.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`);
 * without one the test SKIPS and its title says why.
 */

import { expect, test } from '@playwright/test';

import { castCard, makeTitled, offered, promptMethod, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { dragRowOnto, stripPoint } from './play/order.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(
  titled(
    'casting Preordain opens the real scry ask (Forge’s `order`); a press-drag of the first card into the answer shows the board’s own lift and commits; a placed card moves with the arrow keys',
  ),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(2 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioMatch(browser, stack, 'w62-scry');
      const page = alice.page;
      await resizeWindow(page, { width: 1280, height: 800 });

      await expect.poll(() => offered(page), { timeout: 30_000, message: 'alice is offered Preordain' }).not.toEqual([]);
      const [preordain] = await offered(page);
      await castCard(page, preordain!);

      // Nothing on either seat to respond with: the spell resolves straight into its own Scry 2.
      await expect.poll(() => promptMethod(page), { timeout: 15_000, message: 'the scry ask (`order`) opened' }).toBe('order');

      const source = page.getByTestId('order-source');
      const dest = page.getByTestId('order-dest');
      const sourceRows = source.locator(':scope > li');
      await expect(sourceRows, 'Scry 2: both looked-at cards start on top').toHaveCount(2);
      await expect(dest.locator(':scope > li'), 'nothing placed yet').toHaveCount(0);

      // A real press-drag of the first card into the answer's own empty space.
      const first = sourceRows.nth(0);
      const firstKey = await first.getAttribute('data-key');
      // Pressed on the part of the card that shows: in a pile the cards in front cover the rest of it.
      const { x: fx, y: fy } = await stripPoint(first);
      const to = (await dest.boundingBox())!;
      const tx = to.x + to.width / 2;
      const ty = to.y + to.height / 2;

      await page.mouse.move(fx, fy);
      await page.mouse.down();
      const steps = 8;
      let sawLift = false;
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(fx + ((tx - fx) * i) / steps, fy + ((ty - fy) * i) / steps);
        if (i === 2) sawLift = (await page.locator('[data-arrange-ghost]').count()) > 0;
      }
      expect(sawLift, 'the row’s phantom follows the pointer, the board’s own [data-arrange-ghost]').toBe(true);
      await page.mouse.up();

      await expect(source.locator(':scope > li'), 'one card left on top').toHaveCount(1);
      const destRows = dest.locator(':scope > li');
      await expect(destRows, 'one card placed').toHaveCount(1);
      await expect(destRows.first(), 'the dragged card is the one placed').toHaveAttribute('data-key', firstKey!);
      await expect(page.locator('[data-arrange-ghost]'), 'the phantom is gone once the drag resolves').toHaveCount(0);

      // Drag the SECOND card just before the placed one, so the dest list now has two.
      const second = source.locator(':scope > li').first();
      const secondKey = await second.getAttribute('data-key');
      await dragRowOnto(page, second, destRows.first(), 'before');
      await expect(destRows, 'both cards are now placed').toHaveCount(2);
      await expect(destRows.first(), 'the second drag landed before the first').toHaveAttribute('data-key', secondKey!);

      // The second half of the brief, as a pile has it: a placed card moves with the arrow keys, the way they
      // point as the pile is drawn — up a pile drawn from its foot (`data-pile`), down one drawn from its top.
      await expect(dest.locator('.prompt__row-actions, .prompt__card-order'), 'no button row on a card — that shape is gone').toHaveCount(0);
      const fromFoot = (await dest.getAttribute('data-pile')) !== null;
      const [later, earlier] = fromFoot ? ['ArrowUp', 'ArrowDown'] : ['ArrowDown', 'ArrowUp'];
      await destRows.first().focus();
      await page.keyboard.press(later);
      await expect(destRows.nth(1), `${later} sent the first card one along the pile`).toHaveAttribute('data-key', secondKey!);
      await destRows.nth(1).focus();
      await page.keyboard.press(earlier);
      await expect(destRows.first(), `${earlier} brought it back`).toHaveAttribute('data-key', secondKey!);

      // Submit: the answer reaches Forge — the prompt closes, and the match moves on.
      await page.getByTestId('prompt-submit').click();
      await expect.poll(() => promptMethod(page), { timeout: 10_000, message: 'the scry ask closed once Forge accepted the reply' }).not.toBe('order');
    } finally {
      await stack.stop();
    }
  },
);
