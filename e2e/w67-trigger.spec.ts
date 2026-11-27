/**
 * AE28 + AE29 (playtest 15, 2026-10-09): a triggered ability on the stack is drawn as an ability
 * chip — never a second copy of its card — on both screens, and its owner can drag it like a spell
 * they placed; the other screen follows the move.
 *
 * And it follows as smoothly as a card — the operator, 2026-10-10: "small perf bug i notice: moving
 * around ability chips is weirdly visually laggy. i dont notice the same lag when moving other cards
 * around. also the visual lag is only see from the opponents view." Alice drags the chip, then
 * rearranges one of her battlefield cards, with the same real pointer path (`page.mouse`, a step every
 * ~16 ms). Bob's screen records, every animation frame, where it draws each one and whether the
 * chip's own contents were rebuilt or shown as a back: never rebuilt, never a back. The card's glide
 * is read from its plan (each new point starts its `FOLLOW_MS` transition), never from how far it
 * moved between two frames: under load (45238039067, load 24.7) bob's frames came 183 ms apart and
 * her messages 233 ms, and a healthy glide stepped 21 px. The chip eases in script on the wall clock
 * (`placed.ts`'s `handAt`), with no plan to read, so how smoothly it follows is pinned on fake timers
 * by `placed.test.ts` (a watcher tracks the dragging seat's path), not here. How far each moved
 * between frames and how long it stood still are printed only: those are the runner's as much as the
 * chip's.
 *
 * Scenario `w67-trigger`: Eternal Witness's trigger goes on the stack while bob (Full Control)
 * holds priority, so it stays there to be dragged.
 */
import { expect, test, type Page } from '@playwright/test';

import { FOLLOW_MS } from '../games/magic/ui/src/play/motion.ts';
import { makeTitled } from './play/board.ts';
import { chipOf, triggerOnStack } from './play/chip.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { dragPath, recordTrace, stopTrace, traceLine } from './play/trace.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const centre = async (page: Page): Promise<{ x: number; y: number }> => {
  const box = (await chipOf(page).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test(titled('a trigger on the stack is the ability chip on both screens, and its owner drags it — the other screen follows as smoothly as a dragged card'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-trigger');
    await triggerOnStack(alice.page, bob.page);
    await expect(alice.page.locator('[data-placed-spell]:has([data-ability-chip]) .card'), 'no card face inside the chip').toHaveCount(0);
    await expect(chipOf(alice.page).locator('.placed__chip-name')).toHaveText('Eternal Witness');
    await expect(chipOf(alice.page), 'it is hers to move').toHaveAttribute('data-mine', '');
    const chipId = await chipOf(bob.page).getAttribute('data-placed-spell');

    // The chip: from its centre, the operator's gesture (`dragPath`: 240 px left, 40 down).
    const bobBefore = await centre(bob.page);
    const from = await centre(alice.page);
    await recordTrace(bob.page, `[data-placed-spell="${chipId}"]`);
    await dragPath(alice.page, from);
    await bob.page.waitForTimeout(300);
    const chipTrace = await stopTrace(bob.page);
    const aliceAfter = await centre(alice.page);
    console.log(`[w67-trigger] alice chip ${Math.round(from.x)},${Math.round(from.y)} → ${Math.round(aliceAfter.x)},${Math.round(aliceAfter.y)}`);
    expect(Math.abs(aliceAfter.x - (from.x - 240)), 'the chip went where she let it go').toBeLessThan(30);
    await expect
      .poll(async () => Math.abs((await centre(bob.page)).x - bobBefore.x), { timeout: 10_000, message: 'bob sees the chip move' })
      .toBeGreaterThan(150);
    console.log(`[w67-trigger] bob chip ${Math.round(bobBefore.x)} → ${Math.round((await centre(bob.page)).x)}`);

    // One of her battlefield cards: the same path, rearranged. Its mirror is the baseline.
    const card = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card[data-card-id]').last();
    const f = (await card.boundingBox())!;
    await recordTrace(bob.page, '[data-board-overlay] .presence__lift', '[data-zone="battlefield"][data-owner="them"] [data-arrange-dragging]');
    await dragPath(alice.page, { x: f.x + f.width / 2, y: f.y + f.height / 2 });
    await bob.page.waitForTimeout(300);
    const cardTrace = await stopTrace(bob.page);

    console.log(`[w67-trigger] chip ${traceLine(chipTrace)}`);
    console.log(`[w67-trigger] card ${traceLine(cardTrace)}`);
    console.log(
      `[w67-trigger] measure: chip stood still at most ${chipTrace.maxHoldMs} ms (next message ${chipTrace.maxTargetGapMs} ms + longest frame ${chipTrace.maxFrameMs} ms), the card ${cardTrace.maxHoldMs} ms (${cardTrace.maxTargetGapMs} + ${cardTrace.maxFrameMs})`,
    );
    expect(chipTrace.moves, 'bob saw the chip move at all').toBeGreaterThan(5);
    expect(cardTrace.moves, 'bob saw the card move at all').toBeGreaterThan(5);
    // The card's own mirror: one element, gliding to each point.
    expect(cardTrace.rebuilds, 'the lifted card is never rebuilt while it is moved').toBe(0);
    // It glides to every point her messages bring, never steps: each one starts the tile's own
    // `left`/`top` transition, planned at FOLLOW_MS. How far it gets between two frames is the host's.
    expect(cardTrace.glides.length, 'bob’s tile was sent new points while she moved it').toBeGreaterThan(5);
    expect(cardTrace.glides.filter((ms) => ms !== FOLLOW_MS), `the lifted card glides to every new point over FOLLOW_MS (${FOLLOW_MS} ms), never steps`).toEqual([]);
    // The chip itself: one element, its own face throughout — never rebuilt, never turned to a back and over again.
    expect(chipTrace.rebuilds, 'the chip is never rebuilt while it is moved').toBe(0);
    expect(chipTrace.blankFrames, 'the chip is never blank or a back while it is moved').toBe(0);
    expect(chipTrace.faceFlips, 'the chip never turns from its face to a back and over again').toBe(0);
  } finally {
    await stack.stop();
  }
});
