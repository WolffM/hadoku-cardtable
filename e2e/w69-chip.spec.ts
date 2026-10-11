/**
 * The operator, 2026-10-10: "small perf bug i notice: moving around ability chips is weirdly
 * visually laggy. i dont notice the same lag when moving other cards around. also the visual lag
 * is only see from the opponents view."
 *
 * Alice drags her trigger's ability chip, then rearranges one of her battlefield cards, with the same real
 * pointer path (`page.mouse`, a step every ~16 ms). Bob's screen records, every animation frame,
 * where it draws each one and whether the chip's own contents were rebuilt or shown as a back.
 * Both must follow smoothly: never rebuilt, never a back, never a step per message or a jump.
 *
 * Scenario `w67-trigger`: Eternal Witness's trigger goes on the stack while bob (Full Control)
 * holds priority, so it stays there to be dragged.
 */
import { expect, test } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { chipOf, triggerOnStack } from './play/chip.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { dragPath, recordTrace, stopTrace, traceLine } from './play/trace.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('the other screen follows a dragged ability chip as smoothly as a dragged card'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-trigger');
    await triggerOnStack(alice.page, bob.page);
    const chipId = await chipOf(bob.page).getAttribute('data-placed-spell');

    // The chip: from its centre, the operator's gesture.
    const c = (await chipOf(alice.page).boundingBox())!;
    await recordTrace(bob.page, `[data-placed-spell="${chipId}"]`);
    await dragPath(alice.page, { x: c.x + c.width / 2, y: c.y + c.height / 2 });
    await bob.page.waitForTimeout(300);
    const chipTrace = await stopTrace(bob.page);

    // One of her battlefield cards: the same path, rearranged. Its mirror is the baseline.
    const card = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card[data-card-id]').last();
    const f = (await card.boundingBox())!;
    await recordTrace(bob.page, '[data-board-overlay] .presence__lift', '[data-zone="battlefield"][data-owner="them"] [data-arrange-dragging]');
    await dragPath(alice.page, { x: f.x + f.width / 2, y: f.y + f.height / 2 });
    await bob.page.waitForTimeout(300);
    const cardTrace = await stopTrace(bob.page);

    console.log(`[w69-chip] chip ${traceLine(chipTrace)}`);
    console.log(`[w69-chip] card ${traceLine(cardTrace)}`);
    expect(chipTrace.moves, 'bob saw the chip move at all').toBeGreaterThan(5);
    expect(cardTrace.moves, 'bob saw the card move at all').toBeGreaterThan(5);
    // The card's own mirror is the baseline, so it must be healthy itself before the chip is compared with it.
    expect(cardTrace.rebuilds, 'the lifted card is never rebuilt while it is moved').toBe(0);
    expect(cardTrace.maxJumpPx, 'the lifted card never jumps further in a frame than a couple of pointer steps').toBeLessThanOrEqual(20);
    // The chip itself: one element, its own face throughout — never rebuilt, never turned to a back and over again.
    expect(chipTrace.rebuilds, 'the chip is never rebuilt while it is moved').toBe(0);
    expect(chipTrace.blankFrames, 'the chip is never blank or a back while it is moved').toBe(0);
    expect(chipTrace.faceFlips, 'the chip never turns from its face to a back and over again').toBe(0);
    expect(chipTrace.maxJumpPx, `the chip never jumps further in a frame than the card does (${cardTrace.maxJumpPx} px)`).toBeLessThanOrEqual(Math.max(cardTrace.maxJumpPx * 1.5, 20));
    // Gliding, not stepping: about as many frames moved as the card's, which glides between the same messages.
    expect(chipTrace.moves, `the chip glides between their messages like the card does (${cardTrace.moves} frames moved), never a step per message`).toBeGreaterThanOrEqual(Math.floor(cardTrace.moves * 0.6));
    /*
     * A hold is the chip's own only past what the page was given and what the page could paint. Bob's
     * screen draws a new target each time a message lands (`maxTargetGapMs`, from the page's own
     * `left`/`top` writes, so a slow relay is never blamed on the chip) and paints when the machine
     * lets it (`maxFrameMs`, the longest gap between this page's own frames in the same window — a
     * busy claw stalled 67–150 ms, the card baseline itself once held 267 ms). With a glide the chip
     * is moving between every two targets, so it may stand still at most the wait for the next
     * target plus one stalled frame; a hold beyond that is latency the chip's drawing added.
     */
    expect(
      chipTrace.maxHoldMs,
      `the chip stands still no longer than the wait for its next message (${chipTrace.maxTargetGapMs} ms) plus the page's own longest frame (${chipTrace.maxFrameMs} ms)`,
    ).toBeLessThanOrEqual(chipTrace.maxTargetGapMs + chipTrace.maxFrameMs);
  } finally {
    await stack.stop();
  }
});
