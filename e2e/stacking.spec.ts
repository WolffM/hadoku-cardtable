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
import { boxOf, onTopPoint, pointerDrag, type Box } from './play/w32.ts';

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
