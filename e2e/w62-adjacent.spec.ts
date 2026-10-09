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

/*
 * AE19 — a second regression report on top of AE15 (2026-10-08): "big regression on card
 * placement. it's much less responsive now at letting me put cards anywhere. it seems to only
 * draw locations for card slots to the left of where the card currently is." And: "why did this
 * get more complicated." Suspect named by the manager: `snapTo`'s AE15-era special case ("its own
 * single-card column is never a target; the column after it counts as where it came from")
 * plausibly swallows every slot to the right. Measured here against a real board, over FIVE of
 * the scenario's eight lone Plains (`1 2 3 4 5` by position): every gap to the right of the
 * leftmost card while it is dragged, then a release at two of them; the mirror, every gap to the
 * left of the rightmost card.
 *
 * `Board.test.ts`'s own `AE19:` unit tests prove the same claim against `snapTo` directly, with
 * exact pixel geometry — this file is the real-browser, real-drag proof beside it.
 */
test(titled('AE19: dragging the leftmost card offers every gap to its right, and the mirror leftward from the rightmost'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w43-stack-lands');
    await alice.page.setViewportSize({ width: 1280, height: 800 });
    await bob.page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(() => columnsOf(ownRow(alice.page)), { timeout: 30_000, message: 'eight lone lands drawn' }).toHaveLength(8);
    const all = (await columnsOf(ownRow(alice.page))) as string[];
    // The scenario is EIGHT lone lands, not five — the first version of this test built its
    // expected arrays with only five slots (`[c1..c5]`) and a sixth-through-eighth card the row
    // genuinely has fell off every comparison. That is a test bug, not a `snapTo` one: the FIRST
    // claw run's own diff showed the real board produced exactly the right order, with three
    // trailing cards this test's own expectation never included. Fixed here by using the whole
    // row and by treating the ACTUAL last card (8th), not the 5th, as "the end".
    const [c1, c2, c3, c4, c5, c6, c7, c8] = all as [string, string, string, string, string, string, string, string];
    const card = (id: string) => alice.page.locator(`.seat[data-viewer] li.board-card[data-card-id="${id}"]`);
    const indicator = alice.page.locator('[data-arrange-indicator]:not([hidden])');

    /** Press `from`, move to `to`'s box without releasing, assert a drop IS offered there, then release. */
    async function dragAndCheckOffered(from: string, to: { x: number; y: number }, why: string): Promise<void> {
      const box = await boxOf(card(from));
      await alice.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await alice.page.mouse.down();
      await alice.page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 8, { steps: 3 });
      await alice.page.mouse.move(to.x, to.y, { steps: 6 });
      await expect(indicator, `${why}: a drop is offered, not nowhere`).toHaveCount(1, { timeout: 3_000 });
      await alice.page.mouse.up();
    }

    // Every gap to the RIGHT of the leftmost card (1) offers a real target, sampled across the
    // whole row, and past the ACTUAL last card (8) — none comes back "nowhere" the way the
    // report described.
    const after2 = await boxOf(card(c2));
    await dragAndCheckOffered(c1, { x: after2.x + after2.width - 3, y: after2.y + after2.height / 2 }, 'after 2');
    const afterTwo = [c2, c1, c3, c4, c5, c6, c7, c8];
    await expect.poll(() => columnsOf(ownRow(alice.page)), { message: 'released after 2' }).toEqual(afterTwo);

    const after4 = await boxOf(card(c4));
    await dragAndCheckOffered(c1, { x: after4.x + after4.width + 2, y: after4.y + after4.height / 2 }, 'after 4');
    const afterFour = [c2, c3, c4, c1, c5, c6, c7, c8];
    await expect.poll(() => columnsOf(ownRow(alice.page)), { message: 'released after 4' }).toEqual(afterFour);
    await expect.poll(() => columnsOf(theirRow(bob.page)), { timeout: 10_000, message: 'bob sees the same' }).toEqual(afterFour);

    const after6 = await boxOf(card(c6));
    await dragAndCheckOffered(c1, { x: after6.x + after6.width + 2, y: after6.y + after6.height / 2 }, 'after 6');
    const afterSix = [c2, c3, c4, c5, c6, c1, c7, c8];
    await expect.poll(() => columnsOf(ownRow(alice.page)), { message: 'released after 6' }).toEqual(afterSix);

    const last = await boxOf(card(c8));
    await dragAndCheckOffered(c1, { x: last.x + last.width + 40, y: last.y + last.height / 2 }, 'past 8, the actual end');
    const atEnd = [c2, c3, c4, c5, c6, c7, c8, c1];
    await expect.poll(() => columnsOf(ownRow(alice.page)), { message: 'released past 8 (the end)' }).toEqual(atEnd);
    console.log(`[w62-adjacent] AE19 rightward: start ${all.join(' ')} → after2 ${afterTwo.join(' ')} → after4 ${afterFour.join(' ')} → after6 ${afterSix.join(' ')} → end ${atEnd.join(' ')}`);

    // The mirror: every gap to the LEFT of the rightmost card (now c1, at the row's actual end)
    // offers a real target too.
    const c1Box = await boxOf(card(c1));
    const before6 = await boxOf(card(c6));
    await dragAndCheckOffered(c1, { x: before6.x + 2, y: before6.y + before6.height / 2 }, 'before 6, one step left of the end');
    const oneLeftOfEnd = [c2, c3, c4, c5, c1, c6, c7, c8];
    await expect.poll(() => columnsOf(ownRow(alice.page)), { message: 'released before 6' }).toEqual(oneLeftOfEnd);

    const start = await boxOf(card(c2));
    await dragAndCheckOffered(c1, { x: start.x - 20, y: start.y + start.height / 2 }, 'before 2, the very start of the row');
    const atStart = [c1, c2, c3, c4, c5, c6, c7, c8];
    await expect.poll(() => columnsOf(ownRow(alice.page)), { message: 'released at the very start' }).toEqual(atStart);
    console.log(`[w62-adjacent] AE19 leftward (from ${JSON.stringify(c1Box)}): one left of the end ${oneLeftOfEnd.join(' ')} → start ${atStart.join(' ')}`);
  } finally {
    await stack.stop();
  }
});

test(titled('AE19, the operator\'s board: a LONE land dragged right moves right — column by column, gaps opening behind it — and back left; bob mirrors every step'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'bitterblossom');
    await expect.poll(() => columnsOf(ownRow(alice.page)), { timeout: 30_000, message: 'one lone land drawn' }).toHaveLength(1);
    const [id] = (await columnsOf(ownRow(alice.page))) as [string];
    const card = () => alice.page.locator(`.seat[data-viewer] li.board-card[data-card-id="${id}"]`);
    // The operator's rows (2026-10-09): `pileSizes [0,0,0,0,0,1]` — the land at column 5 with gaps before it.
    for (let step = 1; step <= 3; step += 1) {
      const box = await boxOf(card());
      await pointerDrag(alice.page, card(), { x: box.x + box.width * 1.6, y: box.y + box.height / 2 });
      const want = [...Array.from({ length: step }, () => null), id];
      await expect.poll(() => columnsOf(ownRow(alice.page)), { message: `alice: column ${step}` }).toEqual(want);
      await expect.poll(() => columnsOf(theirRow(bob.page)), { timeout: 10_000, message: `bob: column ${step}, mirrored` }).toEqual(want);
    }
    console.log(`[w62-adjacent] lone land right ×3: ${(await columnsOf(ownRow(alice.page))).map((c) => c ?? '_').join(' ')} | bob ${(await columnsOf(theirRow(bob.page))).map((c) => c ?? '_').join(' ')}`);
    // And back to the first column, over the first gap.
    const gap0 = await boxOf(ownRow(alice.page).locator(':scope > li').first());
    await pointerDrag(alice.page, card(), { x: gap0.x + gap0.width / 2, y: gap0.y + gap0.height / 2 });
    await expect.poll(() => columnsOf(ownRow(alice.page)), { message: 'alice: back at column 0' }).toEqual([id]);
    await expect.poll(() => columnsOf(theirRow(bob.page)), { timeout: 10_000, message: 'bob: mirrored' }).toEqual([id]);
    console.log(`[w62-adjacent] lone land back left: ${(await columnsOf(ownRow(alice.page))).join(' ')}`);
  } finally {
    await stack.stop();
  }
});
