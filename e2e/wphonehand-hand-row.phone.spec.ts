/**
 * The phone hand under a finger (the operator, 2026-11-06: "when dragging cards back and forth in the
 * hand it causes a weird 'jerk' effect … it seems like it wants to allow scrolling left/right but the
 * hand is being displayed in two rows which is unexpected").
 *
 * The hand is one row that scrolls sideways when it overflows. A sideways swipe scrolls it and lifts
 * nothing. A card lifted by the finger follows it while it reorders, with no frame where it jumps
 * against the finger and nothing in the hand re-laid out under it, and the hand scrolls on its own
 * while the card is held at an edge. A card dragged up off the hand is still played.
 *
 * Real Forge, nine cards in hand (`phone-hand`), every press a real CDP touch. Each gesture is judged
 * from the page's own frames (`play/hand-frames.ts`), logged in full for a red.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test SKIPS and its
 * title says why. Serves the prebuilt `apps/ui/dist`: rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { dragHandCard, makeTitled, ownNamed, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { describeFrames, handIds, reorderByFinger, rowsOf, startHandFrames, stopHandFrames, swipeHand, worstJump, worstShift } from './play/hand-frames.ts';
import { noSideways, PHONE, raiseHand } from './play/phone.ts';
import { startScenarioMatch } from './play/scenario.ts';

test.use(PHONE);

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** A card that follows the finger moves with it to within this, frame to frame. */
const MAX_JUMP_PX = 6;

const hand = (page: Page) => page.getByTestId('lane-my-hand');

/** The raised hand's shape: how many rows its cards sit in, and whether it overflows its lane. */
async function shape(page: Page): Promise<{ rows: number; overflow: number }> {
  return hand(page).evaluate((lane) => {
    const tops = new Set([...lane.querySelectorAll(':scope > li.board-card')].map((li) => Math.round(li.getBoundingClientRect().top)));
    return { rows: tops.size, overflow: lane.scrollWidth - lane.clientWidth };
  });
}

test(titled('the phone hand is one row that a finger scrolls sideways, reorders smoothly, and still plays from'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'phone-hand');
    const page = alice.page;
    await expect(hand(page).locator(':scope > li.board-card')).toHaveCount(9, { timeout: 30_000 });
    await raiseHand(page);

    // One row, at both phone widths, and it overflows its lane: the rest is a scroll away.
    for (const size of [{ width: 390, height: 844 }, { width: 360, height: 800 }]) {
      await resizeWindow(page, size);
      const s = await shape(page);
      console.log(`[hand] ${size.width}×${size.height}: ${s.rows} row(s), overflow ${s.overflow}px`);
      expect.soft(s.rows, `${size.width}×${size.height}: nine cards draw in one row`).toBe(1);
      expect.soft(s.overflow, `${size.width}×${size.height}: and the row runs past the lane`).toBeGreaterThan(0);
      await noSideways(page);
    }
    await resizeWindow(page, PHONE.viewport);

    // A sideways swipe scrolls the hand: no card lifts, and no card moves within it.
    await startHandFrames(page, null);
    await swipeHand(page);
    await page.waitForTimeout(400);
    const swiped = await stopHandFrames(page);
    const shift = worstShift(swiped);
    const scrolled = Math.max(...swiped.map((f) => f.scrollLeft));
    console.log(`[hand] swipe: scrolled to ${scrolled}, worst re-layout ${shift.px}px (card ${shift.id}, frame ${shift.at}), rows ${Math.max(...swiped.map(rowsOf))}\n${describeFrames(swiped, null)}`);
    expect.soft(scrolled, 'a sideways swipe scrolls the hand').toBeGreaterThan(40);
    expect.soft(swiped.filter((f) => f.lifted !== null).length, 'and lifts no card').toBe(0);
    expect.soft(shift.px, 'and nothing in the hand is re-laid out while it scrolls').toBeLessThanOrEqual(1);
    expect.soft(Math.max(...swiped.map(rowsOf)), 'and the hand stays one row').toBe(1);
    await hand(page).evaluate((el) => {
      el.scrollLeft = 0;
    });
    await page.waitForTimeout(300);

    // A reorder: the second card, lifted and carried two cards right. It follows the finger, nothing
    // else in the hand moves under it, and it lands where it was let go.
    const before = await handIds(page);
    const moving = before[1]!;
    const width = (await hand(page).locator(':scope > li.board-card').first().boundingBox())!.width;
    await startHandFrames(page, moving);
    await reorderByFinger(page, moving, width * 2.2);
    await page.waitForTimeout(600);
    const carried = await stopHandFrames(page);
    const jump = worstJump(carried);
    const held = worstShift(carried.filter((f) => f.lifted === 'lifted'));
    console.log(`[hand] reorder: worst jump ${jump.px}px (frame ${jump.at}), worst re-layout ${held.px}px (card ${held.id}, frame ${held.at})\n${describeFrames(carried, moving)}`);
    expect.soft(carried.some((f) => f.lifted === 'lifted'), 'the finger lifted the card').toBe(true);
    expect.soft(jump.px, `the lifted card never jumps more than ${MAX_JUMP_PX}px against the finger`).toBeLessThanOrEqual(MAX_JUMP_PX);
    expect.soft(held.px, 'nothing in the hand is re-laid out while the card is carried').toBeLessThanOrEqual(1);
    expect.soft(Math.max(...carried.map((f) => f.scrollLeft)), 'and the hand does not scroll under a card carried mid-hand').toBeLessThanOrEqual(1);
    expect.soft(Math.max(...carried.map(rowsOf)), 'and the hand stays one row').toBe(1);
    const after = await handIds(page);
    expect.soft(after.indexOf(moving), `let go two cards on, it is there (${before.join(',')} → ${after.join(',')})`).toBe(3);

    // Held at the hand's right edge, the lifted card scrolls the hand toward the cards past it.
    const lane = (await hand(page).boundingBox())!;
    const first = (await handIds(page))[0]!;
    const firstBox = (await page.locator(`[data-board-card="${first}"]`).boundingBox())!;
    await startHandFrames(page, first);
    await reorderByFinger(page, first, lane.x + lane.width - 8 - (firstBox.x + firstBox.width / 2), { n: 16, holdMs: 1_200 });
    await page.waitForTimeout(600);
    const edge = await stopHandFrames(page);
    const edgeJump = worstJump(edge);
    console.log(`[hand] edge: scrolled to ${Math.max(...edge.map((f) => f.scrollLeft))}, worst jump ${edgeJump.px}px (frame ${edgeJump.at})\n${describeFrames(edge, first)}`);
    expect.soft(Math.max(...edge.map((f) => f.scrollLeft)), 'a card held at the right edge scrolls the hand').toBeGreaterThan(40);
    expect.soft(edgeJump.px, 'and stays under the finger while it does').toBeLessThanOrEqual(MAX_JUMP_PX);
    const landed = await handIds(page);
    expect.soft(landed.indexOf(first), `let go past the cards it scrolled to, it is among them (${landed.join(',')})`).toBeGreaterThan(3);

    // Dragged up off the hand onto the table, a card is played.
    const lands = (await ownNamed(page, 'Mountain')).length;
    const mountain = await page
      .getByTestId('lane-my-hand')
      .locator(':scope > li.board-card')
      .evaluateAll((els) => Number(els.find((e) => e.querySelector('.card__name')?.textContent?.trim() === 'Mountain')?.getAttribute('data-board-card')));
    const field = (await page.getByTestId('lane-my-permanents').boundingBox())!;
    await hand(page).evaluate((el, id) => el.querySelector(`[data-board-card="${id}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest' }), mountain);
    await page.waitForTimeout(300);
    expect(await dragHandCard(page, mountain, { x: field.x + field.width / 2, y: field.y + field.height / 2 }), 'the finger lifted the Mountain').toBe(true);
    await expect.poll(async () => (await ownNamed(page, 'Mountain')).length, { timeout: 20_000, message: 'dragged up, the Mountain is played' }).toBe(lands + 1);
  } finally {
    await stack.stop();
  }
});
