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
