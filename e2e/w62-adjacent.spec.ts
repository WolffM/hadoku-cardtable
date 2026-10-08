/**
 * The operator, 2026-10-08: "some strange behavior with moving a card directly into the adjacent
 * position forward. mostly moving cards around is fine, but when moving it directly to the right
 * it just doesn't work?" — a battlefield card dragged ONE column to the right, in a real browser,
 * on both screens.
 *
 * What was wrong (`Board.tsx` `snapTo`): the card being dragged stayed a column like any other
 * under the pointer — its own middle stacked it onto itself (which `withMove` turned into "the
 * end of the row"), its own edges offered the gap it already sat in, and the one-column move was
 * a thin strip at the neighbour's far edge. Now the dragged card's own column is never a place:
 * the neighbour's right edge, and the gap after it, both put the card one column right; a drop
 * anywhere on its own column leaves it exactly where it was.
 *
 * Scenario `w43-stack-lands`: eight lone Plains on alice's battlefield, nothing in hand.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { boxOf, pointerDrag } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const ownRow = (page: Page) => page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-tier="back"]');
const theirRow = (page: Page) => page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-tier="back"]');
const columnsOf = (row: ReturnType<typeof ownRow>) =>
  row.locator(':scope > li').evaluateAll((els) => els.map((e) => (e.classList.contains('zone__gap') ? null : e.getAttribute('data-card-id'))));

test(titled('a battlefield card dragged one column to the right lands there — on both screens — and dropped on its own column it stays'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w43-stack-lands');
    await alice.page.setViewportSize({ width: 1280, height: 800 });
    await bob.page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(() => columnsOf(ownRow(alice.page)), { timeout: 30_000, message: 'eight lone lands drawn' }).toHaveLength(8);
    const before = (await columnsOf(ownRow(alice.page))) as string[];
    await expect.poll(() => columnsOf(theirRow(bob.page)), { timeout: 30_000, message: 'bob sees the same eight' }).toEqual(before);
    const card = (id: string) => alice.page.locator(`.seat[data-viewer] li.board-card[data-card-id="${id}"]`);
    const [first, second, third] = before as [string, string, string];

    // One column right: the neighbour's right edge strip (the operator's "directly to the right").
    const neighbour = await boxOf(card(second));
    await pointerDrag(alice.page, card(first), { x: neighbour.x + neighbour.width - 3, y: neighbour.y + neighbour.height / 2 });
    const oneRight = [second, first, ...before.slice(2)];
    await expect.poll(() => columnsOf(ownRow(alice.page)), { message: 'alice: one column right' }).toEqual(oneRight);
    await expect.poll(() => columnsOf(theirRow(bob.page)), { timeout: 10_000, message: 'bob: the same order, mirrored' }).toEqual(oneRight);
    console.log(`[w62-adjacent] before ${before.join(' ')} | one right ${(await columnsOf(ownRow(alice.page))).join(' ')} | bob ${(await columnsOf(theirRow(bob.page))).join(' ')}`);

    // One column right again, this time into the gap AFTER the next neighbour (between it and the one after).
    const next = await boxOf(card(third));
    await pointerDrag(alice.page, card(first), { x: next.x + next.width + 2, y: next.y + next.height / 2 });
    const twoRight = [second, third, first, ...before.slice(3)];
    await expect.poll(() => columnsOf(ownRow(alice.page)), { message: 'alice: the gap after the next neighbour' }).toEqual(twoRight);
    await expect.poll(() => columnsOf(theirRow(bob.page)), { timeout: 10_000, message: 'bob: mirrored again' }).toEqual(twoRight);

    // Dropped on its own column's middle: it stays — not stacked onto itself, not sent to the end.
    const own = await boxOf(card(first));
    await pointerDrag(alice.page, card(first), { x: own.x + own.width / 2, y: own.y + own.height / 2 });
    await alice.page.waitForTimeout(400);
    expect(await columnsOf(ownRow(alice.page)), 'alice: dropped on itself, unchanged').toEqual(twoRight);
    expect(await columnsOf(theirRow(bob.page)), 'bob: unchanged').toEqual(twoRight);
    console.log(`[w62-adjacent] two right ${twoRight.join(' ')} | after a drop on itself ${(await columnsOf(ownRow(alice.page))).join(' ')}`);
  } finally {
    await stack.stop();
  }
});
