/**
 * The other seat's rearranged card, mirrored (`presence.ts`'s `drawArranging`, anchored to the
 * battlefield card itself by id since 2c9d16c): bob's screen draws ONE tile, off the ONE home card
 * it belongs to, and it follows alice's drag without ever jumping.
 *
 * Why this spec exists: two of ~20 CI traces of the card baseline (`w67-trigger.spec.ts`) showed bob's
 * tile flipping every frame between two spots 174 px apart (368,219 ↔ 542,258), `rebuilds=1`. The
 * flip was the RECORDER, not the board: its loops shared one stop flag, the next recording re-armed
 * it before the old loop's next frame, and the old loop (the chip, at rest at 368,219) went on
 * recording into the card's trace (`play/trace.ts`'s header). This spec records exactly that
 * sequence — a recording stopped and the next one started with no frame between them — and the
 * mirror itself, every frame: how many tiles, how many home cards marked as dragged, whether the
 * remembered home is still in the document, and where both are drawn.
 *
 * Scenario `w67-trigger`: alice's main phase with three Forests.
 */
import { expect, test } from '@playwright/test';

import { makeTitled, offeredNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { dragPath, recordTrace, stopTrace, traceLine } from './play/trace.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const TILE = '[data-board-overlay] .presence__lift';
const HOME = '[data-zone="battlefield"][data-owner="them"] [data-arrange-dragging]';

test(titled('the other seat’s rearranged card is one tile, off its one home card, and never jumps'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-trigger');
    await expect.poll(() => offeredNamed(alice.page, 'Eternal Witness'), { timeout: 60_000, message: 'alice has priority in her main phase' }).not.toBeUndefined();
    const cards = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card[data-card-id]');
    await expect(cards).toHaveCount(3);

    for (let i = 0; i < 3; i += 1) {
      // The sequence that fooled the first recorder: a recording of something else (bob's own
      // battlefield card, at rest), stopped, and this one started straight after.
      await recordTrace(bob.page, '.seat[data-viewer] [data-zone="battlefield"] li.board-card');
      await bob.page.waitForTimeout(200);
      await stopTrace(bob.page);
      const box = (await cards.nth(i).boundingBox())!;
      await recordTrace(bob.page, TILE, HOME);
      await dragPath(alice.page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      await bob.page.waitForTimeout(300);
      const t = await stopTrace(bob.page);
      console.log(`[w69-mirror] card ${i} ${traceLine(t)}`);
      expect(t.moves, `card ${i}: bob saw her card move`).toBeGreaterThan(5);
      expect(t.maxCount, `card ${i}: never two tiles`).toBe(1);
      expect(t.maxAnchors, `card ${i}: never two home cards marked as dragged`).toBe(1);
      expect(t.anchorIds, `card ${i}: one home card throughout`).toBe(1);
      expect(t.anchorGone, `card ${i}: the home card never left the document under the tile`).toBe(0);
      expect(t.rebuilds, `card ${i}: the tile is never rebuilt while it is moved`).toBe(0);
      // Her pointer steps 6 px every ~16 ms and bob's tile glides 90 ms between messages 60 ms
      // apart: a frame's step is a few px; 20 allows a stalled frame or two.
      expect(t.maxJumpPx, `card ${i}: the tile never jumps further in a frame than a couple of pointer steps`).toBeLessThanOrEqual(20);
      await expect(bob.page.locator(TILE), `card ${i}: the tile is gone once she lets go`).toHaveCount(0);
      await expect(bob.page.locator(HOME), `card ${i}: and her card is no longer dimmed`).toHaveCount(0);
    }
  } finally {
    await stack.stop();
  }
});
