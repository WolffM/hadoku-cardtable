/**
 * w90 C rework, the grid — the operator's look-gate feedback on the first cut (2026-11-02):
 *
 *   3. *"the draft: pack as a grid - it would be better to display two columns of cards instead of
 *      one."* The reviewed shot showed one column of cards hugging the box's left edge, the right
 *      half of the box empty.
 *
 * Cause: the grid drew a fixed, small card width (`--phone-grid-w`, 150px) in an `auto-fill` grid —
 * at the pack's real (narrow, chrome-shared) box width that fits only one comfortable column before
 * the `auto-fill` track either wraps a second, cramped one or leaves the row short, which is what the
 * reviewed shot caught. Fixed: the grid is now always exactly TWO columns, `1fr` each, so they split
 * the box's own width evenly, whatever it is — no fixed card width, no `auto-fill`, and (now that two
 * columns already fill the box) no horizontal drag surface left to keep: deleted along with it.
 *
 * Needs no Forge: a draft never touches it (`play/w32.ts`'s `startPlayStack` header says the same for
 * the heavier match stacks; this uses the plain draft server `playwright.config.ts` already starts).
 */
import { expect, test, type Page } from '@playwright/test';

import { PHONE } from './play/phone.ts';
import { noPageSideways, soloDraftPack, swipe, withAlice } from './w90c-touch.ts';

test.use(PHONE);

async function toGrid(page: Page): Promise<void> {
  await page.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: 'grid' }).tap();
  await page.getByTestId('pack').waitFor({ state: 'attached' });
  await expect(page.getByTestId('pack')).toHaveClass(/pack--grid/);
  // The fan's own carousel scroll (`w90c-pack-fan.phone.spec.ts`'s swipe tests) can leave the PAGE
  // scrolled past where the grid lands: a box measured from there is off-screen (a negative `y`), and
  // a touch dispatched at it lands nowhere. A stray hover from the toggle tap itself (the look-gate
  // bug's own mechanism — see the fan spec's header) is also cleared by moving the mouse away.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(0, 0);
}

test('the grid: exactly two columns, even gutters, filling the pack’s box', async ({ browser }) => {
  await withAlice(browser, async (page) => {
    await soloDraftPack(page);
    await toGrid(page);
    const pack = page.getByTestId('pack');

    const packBox = await pack.boundingBox();
    const rects = await pack.locator('.pack__slot').evaluateAll((els) => els.slice(0, 2).map((e) => e.getBoundingClientRect().toJSON()));
    if (packBox === null || rects.length < 2) throw new Error('missing a box');
    const [left, right] = rects as [DOMRect, DOMRect];

    // Two DISTINCT column positions — not the one-column-hugging-left bug the look shot caught.
    expect(left.x, 'the two cards sit at different x positions').not.toBeCloseTo(right.x, 0);
    expect(right.x, 'the second column is to the right of the first').toBeGreaterThan(left.x);
    // Both columns the same width: the box split evenly, not one column cramped against a wide one.
    expect(right.width, 'both columns are the same width').toBeCloseTo(left.width, 0);

    // Both cards live inside the pack's own box.
    expect(left.x, 'the first column is inside the box').toBeGreaterThanOrEqual(packBox.x - 1);
    expect(right.x + right.width, 'the second column’s right edge is inside the box').toBeLessThanOrEqual(packBox.x + packBox.width + 1);
    // The right edge sits within a gutter of the box's own right edge — the box's width is USED, not
    // left half-empty (the operator: "it would be better to display two columns ... instead of one").
    const rightGutter = packBox.x + packBox.width - (right.x + right.width);
    expect(rightGutter, 'the right column reaches near the box’s right edge').toBeGreaterThanOrEqual(0);
    expect(rightGutter, 'the right gutter is a gutter, not half the box').toBeLessThan(packBox.width * 0.25);

    // Gutters even: the gap between the columns is close to the gutter on each side.
    const midGutter = right.x - (left.x + left.width);
    const leftGutter = left.x - packBox.x;
    expect(midGutter, 'the gutter between columns is close to the left one').toBeCloseTo(leftGutter, 0);
    expect(rightGutter, 'the gutter between columns is close to the right one').toBeCloseTo(midGutter, 0);

    await noPageSideways(page);
  });
});

test('the grid: no fixed small card width — the two columns are as large as the box allows', async ({ browser }) => {
  await withAlice(browser, async (page) => {
    await soloDraftPack(page);
    const packBox = await page.getByTestId('pack').boundingBox();
    if (packBox === null) throw new Error('no pack box');
    await toGrid(page);
    const card = page.getByTestId('pack').locator('.pack__slot').first();
    const box = await card.boundingBox();
    if (box === null) throw new Error('no card box');
    // Two equal columns, gaps aside: each is roughly half the box, never the old fixed 150px floor's
    // worth of empty space (the operator's "bigger", AF499/501's precedent for "fit, don't shrink").
    expect(box.width, 'each column is close to half the box width').toBeGreaterThan(packBox.width * 0.35);
  });
});

test('the grid: scrolls vertically for the rest of the pack, never sideways, and a drag never picks a card', async ({ browser }) => {
  await withAlice(browser, async (page) => {
    await soloDraftPack(page);
    await toGrid(page);
    const pack = page.getByTestId('pack');

    const overflowAxes = await pack.evaluate((el) => {
      const s = getComputedStyle(el);
      return { x: s.overflowX, y: s.overflowY, scrollH: el.scrollHeight, clientH: el.clientHeight, scrollW: el.scrollWidth, clientW: el.clientWidth };
    });
    expect(['auto', 'scroll'], 'the grid scrolls down for the rest of the pack').toContain(overflowAxes.y);
    expect(overflowAxes.scrollH, 'a 15-card pack in two columns overflows the box, so there is somewhere to scroll to').toBeGreaterThan(overflowAxes.clientH);
    // The horizontal drag surface C drew (an `auto-fill` of small fixed cards) is gone: two columns
    // already fill the box, so there is nothing left to drag sideways to.
    expect(overflowAxes.x, 'no horizontal drag surface is left — two columns already fill the box').toBe('hidden');
    expect(overflowAxes.scrollW, 'nothing overflows the box sideways').toBeLessThanOrEqual(overflowAxes.clientW);

    // The toggle and the room header never move: only the pack's own box scrolls.
    const toggleBefore = await page.locator('.draft__aside .segmented button').first().boundingBox();
    const countBefore = await pack.getAttribute('data-card-count');
    const box = await pack.boundingBox();
    if (box === null || toggleBefore === null) throw new Error('missing a box');
    const scrollBefore = await pack.evaluate((el) => el.scrollTop);
    await swipe(page, { x: box.x + box.width / 2, y: box.y + box.height * 0.8 }, { x: box.x + box.width / 2, y: box.y + box.height * 0.2 });
    const scrollAfter = await pack.evaluate((el) => el.scrollTop);
    expect(scrollAfter, 'the drag actually scrolled the grid').toBeGreaterThan(scrollBefore);

    const toggleAfter = await page.locator('.draft__aside .segmented button').first().boundingBox();
    expect(toggleAfter?.y, 'the toggle did not move with the drag').toBeCloseTo(toggleBefore.y, 0);
    expect(await pack.getAttribute('data-card-count'), 'the drag never picked a card').toBe(countBefore);

    await noPageSideways(page);
  });
});

test('the grid: a tap on a card still picks it directly, one step — no open-then-pick', async ({ browser }) => {
  await withAlice(browser, async (page) => {
    await soloDraftPack(page);
    await toGrid(page);
    const pack = page.getByTestId('pack');
    const countBefore = Number(await pack.getAttribute('data-card-count'));

    const card = pack.locator('.pack__slot button[data-testid="card"]:not([disabled])').first();
    await card.tap();
    await expect(pack, 'one tap picked the card').toHaveAttribute('data-card-count', String(countBefore - 1), { timeout: 10_000 });
  });
});
