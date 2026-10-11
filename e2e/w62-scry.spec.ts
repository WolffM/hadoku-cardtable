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
 * press-drag lift (`./prompts/scry-drag.ts`, shared with
 * `ManipulateCardListPrompt.tsx`), never an HTML5 `dragstart`/`dragover`/
 * `drop` sequence.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`);
 * without one the test SKIPS and its title says why.
 */

import { expect, test } from '@playwright/test';

import { castCard, makeTitled, offered, promptMethod } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(
  titled(
    'casting Preordain opens the real scry ask (Forge’s `order`); a press-drag of the first card into the answer shows the board’s own lift and commits; a placed card’s ↑ sits on its own tile',
  ),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(2 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioMatch(browser, stack, 'w62-scry');
      const page = alice.page;
      await page.setViewportSize({ width: 1280, height: 800 });

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
      const from = (await first.boundingBox())!;
      const to = (await dest.boundingBox())!;
      const fx = from.x + from.width / 2;
      const fy = from.y + from.height / 2;
      const tx = to.x + to.width / 2;
      const ty = to.y + to.height / 2;

      await page.mouse.move(fx, fy);
      await page.mouse.down();
      const steps = 8;
      let sawLift = false;
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(fx + ((tx - fx) * i) / steps, fy + ((ty - fy) * i) / steps);
        if (i === 2) sawLift = (await page.locator('[data-cast-lift="lifted"]').count()) > 0;
      }
      expect(sawLift, 'the lifted row follows the pointer, drawn with the board’s own [data-cast-lift]').toBe(true);
      await page.mouse.up();

      await expect(source.locator(':scope > li'), 'one card left on top').toHaveCount(1);
      const destRows = dest.locator(':scope > li');
      await expect(destRows, 'one card placed').toHaveCount(1);
      await expect(destRows.first(), 'the dragged card is the one placed').toHaveAttribute('data-key', firstKey!);
      await expect(page.locator('[data-cast-lift]'), 'the lift attribute is gone once the drag resolves').toHaveCount(0);

      // Drag the SECOND card onto the placed one — lands just before it, so the dest list now has two.
      const second = source.locator(':scope > li').first();
      const secondKey = await second.getAttribute('data-key');
      const from2 = (await second.boundingBox())!;
      const to2 = (await destRows.first().boundingBox())!;
      await page.mouse.move(from2.x + from2.width / 2, from2.y + from2.height / 2);
      await page.mouse.down();
      await page.mouse.move(to2.x + to2.width / 2, to2.y + to2.height / 2, { steps: 8 });
      await page.mouse.up();
      await expect(destRows, 'both cards are now placed').toHaveCount(2);
      await expect(destRows.first(), 'the second drag landed before the first').toHaveAttribute('data-key', secondKey!);

      // The second half of the brief: the ↑ for a placed row sits ON its own tile, not in a row beside it.
      const placedFirst = destRows.first();
      await expect(placedFirst.locator('.prompt__row-actions'), 'no actions row — that shape is gone').toHaveCount(0);
      const placedBox = (await placedFirst.boundingBox())!;
      const up = placedFirst.locator('.prompt__card-order button').first();
      await expect(up, 'the ↑ nudge is drawn').toHaveCount(1);
      const upBox = (await up.boundingBox())!;
      expect(upBox.x, 'the ↑ sits inside the card’s own tile — left edge').toBeGreaterThanOrEqual(placedBox.x - 1);
      expect(upBox.x + upBox.width, 'the ↑ sits inside the card’s own tile — right edge').toBeLessThanOrEqual(placedBox.x + placedBox.width + 1);
      expect(upBox.y, 'the ↑ sits inside the card’s own tile — top edge').toBeGreaterThanOrEqual(placedBox.y - 1);
      expect(upBox.y + upBox.height, 'the ↑ sits inside the card’s own tile — bottom edge').toBeLessThanOrEqual(placedBox.y + placedBox.height + 1);

      // Submit: the answer reaches Forge — the prompt closes, and the match moves on.
      await page.getByTestId('prompt-submit').click();
      await expect.poll(() => promptMethod(page), { timeout: 10_000, message: 'the scry ask closed once Forge accepted the reply' }).not.toBe('order');
    } finally {
      await stack.stop();
    }
  },
);
