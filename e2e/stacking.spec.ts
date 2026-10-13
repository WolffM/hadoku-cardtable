/**
 * Stacking cards, against real Forge:
 *
 *   - dropping a card onto another to stack it is the easy case — the "on
 *     top"/"underneath" zone is most of the target card's box, and
 *     before/after (reordering) is a thin strip at each edge — proven here
 *     with a REAL pointer drag (`play/w32.ts`'s `pointerDrag`), not a call
 *     into `snapTo` (that pure-function proof is `Board.test.ts`'s);
 *   - every card in a pile — the base and every card fanned on it — is the
 *     same size, from 2 cards to 8, measured as real rendered boxes
 *     (`getBoundingClientRect`, not an inline style read).
 *
 * `w43-stack-lands.state` (lane A's own scenario): seat 0 (human) has EIGHT
 * separate Plains on the battlefield, nothing in hand — nothing to cast, so
 * the only thing to do is drag.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one each test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist`: rebuild before running.
 */

import { expect, test } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { messages } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { boxOf, centre as centreOf, onTopPoint, pointerDrag, type Box } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The viewer's lands — every BASE pile currently in the `back` tier, left to right, by card id. */
async function basePileIds(page: import('@playwright/test').Page): Promise<string[]> {
  const piles = page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-tier="back"] > li.board-card');
  const ids = await piles.evaluateAll((els) => els.map((e) => e.getAttribute('data-card-id')));
  return ids.filter((id): id is string => id !== null);
}

/** The scenario's eight separate Plains, confirmed still eight separate piles (the starting state). */
async function eightLoneLands(page: import('@playwright/test').Page): Promise<string[]> {
  await expect(
    page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-tier="back"] > li.board-card'),
    'the scenario’s eight Plains, each its own pile',
  ).toHaveCount(8);
  return basePileIds(page);
}

test(titled('W7 — dropping near a card’s dead centre stacks it; only a thin strip at the edge reorders'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w43-stack-lands');
    const page = alice.page;
    await page.setViewportSize({ width: 1280, height: 800 });

    const [a, b, c] = await eightLoneLands(page);
    const baseEl = (id: string) => page.locator(`[data-card-id="${id}"]`);

    // Near the centre of `a`'s own box, horizontally dead centre — the old
    // rule read this as the MIDDLE third (reorder); it is squarely inside
    // the new rule's big "on top" zone.
    const boxA = await boxOf(baseEl(a!));
    await pointerDrag(page, baseEl(b!), onTopPoint(boxA));
    await expect(baseEl(a!), 'W7: a drop near the centre stacks, not reorders').toHaveAttribute('data-pile-size', '2');
    await expect(page.locator(`[data-card-id="${a}"] > .board-card__pile > [data-card-id="${b}"]`)).toHaveCount(1);

    // Now the thin strip at the LEFT edge of the (now two-card) pile: reorders.
    // 5% in is comfortably inside the edge strip (12% of the card's width)
    // whatever size the card actually rendered at.
    const boxA2 = await boxOf(baseEl(a!));
    await pointerDrag(page, baseEl(c!), { x: boxA2.x + boxA2.width * 0.05, y: boxA2.y + boxA2.height / 2 });
    await expect(baseEl(a!), 'W7: the thin edge strip still reorders, not stacks').toHaveAttribute('data-pile-size', '2');
    // `c` joined the row as its OWN pile (reordered beside `a`, not stacked on
    // it): still seven piles — eight lands, one pile of two.
    await expect(page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-tier="back"] > li.board-card')).toHaveCount(7);

    // And the thin strip at the RIGHT edge of `a` reorders too (the other side).
    // `c` is already off the row (stacked nowhere — it reordered, not joined
    // `a`'s pile), so any land that is neither `a` nor `b` is still a lone card.
    const another = (await basePileIds(page)).find((id) => id !== a && id !== b)!;
    const boxA3 = await boxOf(baseEl(a!));
    await pointerDrag(page, baseEl(another), { x: boxA3.x + boxA3.width * 0.95, y: boxA3.y + boxA3.height / 2 });
    await expect(baseEl(a!), 'W7: the right edge strip reorders too').toHaveAttribute('data-pile-size', '2');
  } finally {
    await stack.stop();
  }
});

test(titled('W12 — every card in a pile is the same size, 2 cards to 8, base and fanned alike'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w43-stack-lands');
    const page = alice.page;
    await page.setViewportSize({ width: 1280, height: 800 });

    const ids = await eightLoneLands(page);
    const base = ids[0]!;
    const baseEl = () => page.locator(`[data-card-id="${base}"]`);

    /** Every card's own `.board-card__face` box — base and every fanned member — equal within 0.5px. */
    const checkEqualSizes = async (expectSize: number) => {
      await expect(baseEl(), `pile of ${expectSize}: data-pile-size`).toHaveAttribute('data-pile-size', String(expectSize));
      const faces = page.locator(
        `[data-card-id="${base}"] > .board-card__face, [data-card-id="${base}"] > .board-card__pile > li.board-card > .board-card__face`,
      );
      await expect(faces).toHaveCount(expectSize);
      const boxes = (await faces.all()).map(async (f) => boxOf(f));
      const all: Box[] = await Promise.all(boxes);
      const widths = all.map((b) => b.width);
      const heights = all.map((b) => b.height);
      expect(
        Math.max(...widths) - Math.min(...widths),
        `pile of ${expectSize}: every card's face is the same WIDTH within 0.5px — ${JSON.stringify(widths)}`,
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.max(...heights) - Math.min(...heights),
        `pile of ${expectSize}: every card's face is the same HEIGHT within 0.5px — ${JSON.stringify(heights)}`,
      ).toBeLessThanOrEqual(0.5);
    };

    // Stack every remaining land onto the base, one at a time, checking 2, 3, 4 on the way.
    for (let n = 2; n <= 4; n++) {
      const target = ids[n - 1]!;
      const box = await boxOf(baseEl());
      await pointerDrag(page, page.locator(`[data-card-id="${target}"]`), onTopPoint(box));
      await checkEqualSizes(n);
    }
    // 5 through 8 — past Forge's own UI_MAX_STACK_DEPTH (the fan caps at 4).
    for (let n = 5; n <= 8; n++) {
      const target = ids[n - 1]!;
      const box = await boxOf(baseEl());
      await pointerDrag(page, page.locator(`[data-card-id="${target}"]`), onTopPoint(box));
    }
    await checkEqualSizes(8);
  } finally {
    await stack.stop();
  }
});

/**
 * The operator, 2026-10-06, in a live game: *"lands are not tappable if they are stacked on top of
 * eachother"*, and *"when dragging a card OFF a stacked set of cards the viewport weirdly changes in
 * size … the whole thing resizes and gives me extra space at the bottom"*.
 *
 * Both were the pile's own markup. Its list (`ul.board-card__pile`) is laid over the whole pile and
 * took every press, so no click reached a card's button; and a card lifted out of a pile kept its
 * `data-pile-size`, whose `position: relative` beat the drag ghost's `position: absolute`, so the
 * ghost became one more row of the board, 600 px below the pointer, and squeezed the rows above it.
 */
test(titled('a piled land taps where it shows, and lifting a card off a pile moves nothing but the card'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w43-stack-lands');
    const page = alice.page;
    await page.setViewportSize({ width: 1280, height: 800 });
    const [a, b, c] = await eightLoneLands(page);
    const card = (id: string) => page.locator(`li.board-card[data-card-id="${id}"]`);
    await pointerDrag(page, card(b!), onTopPoint(await boxOf(card(a!))));
    await pointerDrag(page, card(c!), onTopPoint(await boxOf(card(a!))));
    await expect(card(a!), 'three Plains in one pile').toHaveAttribute('data-pile-size', '3');

    /** A point where `id` is the card actually under the pointer, or null when none of it shows. */
    const showsAt = (id: string) =>
      page.evaluate((cid) => {
        const r = document.querySelector(`li.board-card[data-card-id="${cid}"]`)!.getBoundingClientRect();
        for (let y = r.top + 2; y < r.bottom; y += 3) {
          for (let x = r.left + 2; x < r.right; x += 3) {
            const li = document.elementFromPoint(x, y)?.closest('li.board-card');
            if (li?.getAttribute('data-card-id') === cid) return { x, y };
          }
        }
        return null;
      }, id);

    // Each of the three is under the pointer somewhere, and a click there taps THAT land.
    for (const id of [a!, b!, c!]) {
      // Forge offers the lands again once the tap before this one has landed; a click before that is not a click on an offer.
      await expect(card(id), `Forge offers land ${id}`).toHaveAttribute('data-selectable', /.*/, { timeout: 10_000 });
      const at = await showsAt(id);
      expect(at, `some of land ${id} shows and takes the pointer`).not.toBeNull();
      await page.mouse.click(at!.x, at!.y);
      await expect(card(id), `the click tapped land ${id}`).toHaveAttribute('data-tapped', 'true', { timeout: 10_000 });
    }

    // Lift a card off the pile: every frame, the battlefield is where it was and the ghost is under the pointer.
    const lone = (await basePileIds(page)).find((id) => id !== a)!;
    await page.evaluate(() => {
      const frames: { field: string; ghost: { x: number; y: number } | null }[] = [];
      const state = { frames, run: true, pointer: { x: 0, y: 0 } };
      (window as unknown as { __lift: typeof state }).__lift = state;
      window.addEventListener('pointermove', (e) => (state.pointer = { x: e.clientX, y: e.clientY }));
      const tick = (): void => {
        if (!state.run) return;
        const f = document.querySelector('.seat[data-viewer] [data-zone="battlefield"]')!.getBoundingClientRect();
        const g = document.querySelector('[data-arrange-ghost]')?.getBoundingClientRect();
        frames.push({
          field: `${Math.round(f.left)},${Math.round(f.top)} ${Math.round(f.width)}x${Math.round(f.height)}`,
          ghost: g === undefined ? null : { x: Math.round(g.left + g.width / 2 - state.pointer.x), y: Math.round(g.top + g.height / 2 - state.pointer.y) },
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const from = (await showsAt(a!))!;
    const to = centreOf(await boxOf(card(lone)));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 16; i++) {
      await page.mouse.move(from.x + ((to.x + 160 - from.x) * i) / 16, from.y + ((to.y - from.y) * i) / 16);
      await page.waitForTimeout(25);
    }
    await page.mouse.up();
    const frames = await page.evaluate(() => {
      const state = (window as unknown as { __lift: { frames: { field: string; ghost: { x: number; y: number } | null }[]; run: boolean } }).__lift;
      state.run = false;
      return state.frames;
    });
    const held = frames.filter((f) => f.ghost !== null);
    expect(held.length, 'the card was lifted for many frames').toBeGreaterThan(10);
    expect([...new Set(frames.map((f) => f.field))], 'the battlefield never moved or resized').toHaveLength(1);
    for (const f of held) {
      expect(Math.abs(f.ghost!.x) < 80 && Math.abs(f.ghost!.y) < 80, `the lifted card is under the pointer, not ${f.ghost!.x},${f.ghost!.y} away`).toBe(true);
    }
  } finally {
    await stack.stop();
  }
});

/**
 * The operator, 2026-10-07: *"when an untapped card is put behind a tapped card, it displays as
 * tapped. that's bad."* A pile's members are nested inside the base card's element, and the turning
 * rule reached them. Tap the base alone: the base's face turns, the card behind it does not.
 */
test(titled('a card piled behind a tapped card is drawn upright: only its own tap turns it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w43-stack-lands');
    const page = alice.page;
    await page.setViewportSize({ width: 1280, height: 800 });
    const [a, b] = await eightLoneLands(page);
    const card = (id: string) => page.locator(`li.board-card[data-card-id="${id}"]`);
    await expect(card(a!), 'Forge offers the lands').toHaveAttribute('data-selectable', /.*/, { timeout: 15_000 });
    await pointerDrag(page, card(b!), onTopPoint(await boxOf(card(a!))));
    await expect(card(a!), 'two Plains in one pile').toHaveAttribute('data-pile-size', '2');
    // Tap the base alone: a click where it shows.
    const at = await page.evaluate((cid) => {
      const r = document.querySelector(`li.board-card[data-card-id="${cid}"]`)!.getBoundingClientRect();
      for (let y = r.top + 2; y < r.bottom; y += 3) {
        for (let x = r.left + 2; x < r.right; x += 3) {
          if (document.elementFromPoint(x, y)?.closest('li.board-card')?.getAttribute('data-card-id') === cid) return { x, y };
        }
      }
      return null;
    }, a!);
    expect(at).not.toBeNull();
    await page.mouse.click(at!.x, at!.y);
    await expect(card(a!), 'the base is tapped').toHaveAttribute('data-tapped', 'true', { timeout: 10_000 });
    await expect(card(b!), 'the card behind it is not').not.toHaveAttribute('data-tapped');
    const turned = (id: string) =>
      page.evaluate((cid) => {
        const face = document.querySelector(`li.board-card[data-card-id="${cid}"] > .board-card__face > .card`)!;
        const t = getComputedStyle(face).transform;
        // A quarter turn: the matrix's a and d are ~0, b and c are ±1. Upright: none, or the identity.
        if (t === 'none') return false;
        const m = /matrix\(([^)]+)\)/.exec(t)!;
        const [ma, , , md] = m[1]!.split(',').map(Number);
        return Math.abs(ma!) < 0.01 && Math.abs(md!) < 0.01;
      }, id);
    expect(await turned(a!), 'the base’s face is drawn turned').toBe(true);
    expect(await turned(b!), 'the card behind it is drawn upright').toBe(false);
  } finally {
    await stack.stop();
  }
});

/**
 * The operator, 2026-10-06: *"can we make it so i can draw boxes to tap things? drawing boxes to
 * attack seems to work, so why not lands?"* Eight Plains and nothing to cast: a box over four of
 * them taps those four, one after another as Forge takes each, and leaves the other four alone.
 * Then the same match proves the way back: a click on any of them untaps that one, in any order.
 */
test(titled('a box drawn over four lands taps those four and no others, and a click on any one of them untaps that one'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w43-stack-lands');
    const page = alice.page;
    await page.setViewportSize({ width: 1280, height: 800 });
    const lands = await eightLoneLands(page);
    const card = (id: string) => page.locator(`li.board-card[data-card-id="${id}"]`);
    await expect(card(lands[0]!), 'Forge offers the lands for their mana').toHaveAttribute('data-selectable', /.*/, { timeout: 15_000 });

    const first = await boxOf(card(lands[0]!));
    const fourth = await boxOf(card(lands[3]!));
    const fifth = await boxOf(card(lands[4]!));
    // From empty table just above-left of the first land to just short of the fifth.
    const from = { x: first.x - 6, y: first.y - 6 };
    const to = { x: (fourth.x + fourth.width + fifth.x) / 2, y: fourth.y + fourth.height + 6 };
    expect(
      await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('li.board-card') === null, from),
      'the box starts on empty table, not on a card',
    ).toBe(true);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await expect(page.locator('[data-testid="marquee"]'), 'the box is drawn while it is held').toHaveCount(1);
    await page.mouse.up();

    /*
     * The operator, 2026-10-08: "when drawing a box to tap lands, can
     * we have them all tap simultaneously rather than one at a time?" Forge
     * still takes one `selectCard` at a time (below): this is the DRAWN
     * state, an optimistic `data-tapped-pending` every boxed land gets at
     * the release, before any of them is confirmed — read together with the
     * real `data-tapped` once Forge answers, per the wave's own contract.
     */
    const tappedOrPending = (id: string) =>
      page.evaluate((cid) => {
        const el = document.querySelector(`li.board-card[data-card-id="${cid}"]`);
        return el !== null && (el.getAttribute('data-tapped') === 'true' || el.hasAttribute('data-tapped-pending'));
      }, id);
    for (const id of lands.slice(0, 4)) {
      await expect.poll(() => tappedOrPending(id), { message: `land ${id} is drawn tapped (really or optimistically) within one frame of the release`, timeout: 1_000 }).toBe(true);
    }
    // Not only the attribute: `card.css`'s own `data-tapped-pending` selector draws the SAME
    // quarter turn `data-tapped` does — read the computed transform, the way the piled-card test
    // above reads it, so the visual turn is proven, not just the state that is supposed to cause it.
    const turnedNow = (id: string) =>
      page.evaluate((cid) => {
        const face = document.querySelector(`li.board-card[data-card-id="${cid}"] > .board-card__face > .card`);
        if (face === null) return false;
        const t = getComputedStyle(face).transform;
        if (t === 'none') return false;
        const m = /matrix\(([^)]+)\)/.exec(t);
        if (m === null) return false;
        const [ma, , , md] = m[1]!.split(',').map(Number);
        return Math.abs(ma!) < 0.01 && Math.abs(md!) < 0.01;
      }, id);
    for (const id of lands.slice(0, 4)) {
      expect(await turnedNow(id), `land ${id} is drawn visually turned (quarter rotation) at the same moment, not only flagged`).toBe(true);
    }
    // And the fourth act had not yet reached the wire when all four were already drawn tapped.
    const selectCardActs = () =>
      messages(alice).filter((m) => m.kind === 'c2s' && typeof m.msg === 'object' && m.msg !== null && (m.msg as { method?: string }).method === 'selectCard').length;
    expect(selectCardActs(), 'not every boxed land’s own selectCard has reached the wire yet').toBeLessThan(4);

    for (const id of lands.slice(0, 4)) await expect(card(id), `land ${id} is tapped`).toHaveAttribute('data-tapped', 'true', { timeout: 20_000 });
    // Long enough for a fifth tap to have landed if the sweep had run on.
    await page.waitForTimeout(1500);
    for (const id of lands.slice(4)) await expect(card(id), `land ${id} was outside the box`).not.toHaveAttribute('data-tapped');

    /*
     * And back again, by a click (the operator, six times: "just let me untap things if it didn't
     * trigger anything"). Every land the box tapped takes a click while its mana floats, in any
     * order: the FIRST to tap, then the third; the other two stay tapped.
     */
    for (const id of lands.slice(0, 4)) await expect(card(id), `land ${id}, tapped, takes a click`).toHaveAttribute('data-selectable', /.*/, { timeout: 15_000 });
    for (const id of [lands[0]!, lands[2]!]) {
      await card(id).locator(':scope > .board-card__face').click();
      await expect(card(id), `the click untapped land ${id}`).not.toHaveAttribute('data-tapped', { timeout: 15_000 });
    }
    for (const id of [lands[1]!, lands[3]!]) await expect(card(id), `land ${id} is still tapped`).toHaveAttribute('data-tapped', 'true');
  } finally {
    await stack.stop();
  }
});

/**
 * Ledger Z8. The operator, 2026-10-07: *"it's still forcing a 'fill from left to right' placement. that's
 * fine generally, but if i want to place a card in a particular slot further to the right with gaps in
 * between i should be able to."* Eight Plains in one row: the last one, let go a column past the row's
 * end, sits in that column with empty columns before it (the one it left, and the one between); another
 * dropped on one of those gaps fills it. Eight Plains leave one spare column at 1280 wide, hence one.
 */
test(titled('a card let go further right sits in that column, with gaps before it, and a gap takes a card'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w43-stack-lands');
    const page = alice.page;
    await page.setViewportSize({ width: 1280, height: 800 });
    const lands = await eightLoneLands(page);
    const row = page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-tier="back"]');
    const columns = () =>
      row.locator(':scope > li').evaluateAll((els) => els.map((e) => (e.classList.contains('zone__gap') ? null : e.getAttribute('data-card-id'))));
    const card = (id: string) => page.locator(`li.board-card[data-card-id="${id}"]`);
    const first = await boxOf(card(lands[0]!));
    const second = await boxOf(card(lands[1]!));
    const pitch = second.x - first.x;
    expect(pitch, 'the row’s column pitch').toBeGreaterThan(first.width);
    const last = await boxOf(card(lands[7]!));
    const rowBox = (await row.boundingBox())!;
    // Two pitches past the last land's left edge is where the column after the spare one starts; 4px into
    // it, never on its edge (on the edge the release is as near the spare column as this one). The board
    // counts a column while it starts more than 4px inside the row (`Board.tsx`, `withColumnsToWidth`).
    const nextStart = last.x + 2 * pitch;
    const target = { x: nextStart + 4, y: last.y + last.height / 2 };
    expect(nextStart, 'the column a pitch past the spare one still starts inside the row').toBeLessThan(rowBox.x + rowBox.width - 4);

    await pointerDrag(page, card(lands[7]!), target);
    await expect.poll(columns, { message: 'the land sits a column past the row’s end: the column it left and one more are gaps' }).toEqual([
      ...lands.slice(0, 7),
      null,
      null,
      lands[7],
    ]);
    // Drawn past the gaps: the row's grid now has ten columns and a narrower pitch, so the proof is the
    // order of the columns above and the land sitting to the right of both gaps.
    const moved = await boxOf(card(lands[7]!));
    const lastGap = (await row.locator(':scope > li.zone__gap').last().boundingBox())!;
    expect(moved.x, 'drawn to the right of the gaps').toBeGreaterThan(lastGap.x + lastGap.width - 1);

    // A gap takes a card: the first Plains onto the first gap.
    const gap = (await row.locator(':scope > li.zone__gap').first().boundingBox())!;
    await pointerDrag(page, card(lands[0]!), { x: gap.x + gap.width / 2, y: gap.y + gap.height / 2 });
    await expect.poll(columns, { message: 'into the gap; the column it left stays open' }).toEqual([null, ...lands.slice(1, 7), lands[0], null, lands[7]]);
  } finally {
    await stack.stop();
  }
});
