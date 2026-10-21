/**
 * A long press lifts a whole pile — the operator, 2026-10-21: *"when i have cards stacked, allow me
 * to 'long press' to pick up the whole stack and move it."* Against real Forge, with a real mouse:
 *
 *   - a press held still on a pile picks up every card in it, and the release puts the pile down
 *     where it was dropped, still one pile, in the same order;
 *   - a press that moves at once is today's drag, and lifts the one card under it.
 *
 * `w43-stack-lands.state`: seat 0 has eight separate Plains and nothing in hand.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one each test
 * SKIPS and its title says why. Serves the prebuilt `apps/ui/dist`: rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { makeTitled, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { boxOf, onTopPoint, pointerDrag, pressPoint } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const PILES = '.seat[data-viewer] [data-zone="battlefield"] [data-tier="back"] > li.board-card';

/** The viewer's lands as piles, left to right: each pile's card ids, bottom first. */
async function piles(page: Page): Promise<string[][]> {
  return page.locator(PILES).evaluateAll((els) =>
    els.map((el) => [el, ...el.querySelectorAll(':scope > .board-card__pile > li.board-card')].map((li) => li.getAttribute('data-card-id') ?? '')),
  );
}

test(titled('a long press on a pile lifts the whole pile; a press that moves at once still lifts one card'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w43-stack-lands');
    const page = alice.page;
    await resizeWindow(page, { width: 1280, height: 800 });
    await expect(page.locator(PILES), 'the scenario’s eight Plains, each its own pile').toHaveCount(8);
    const ids = (await piles(page)).map((p) => p[0]!);
    const [a, b, c] = ids;
    const card = (id: string) => page.locator(`[data-card-id="${id}"]`);

    // b and c stacked on a: one pile of three, then five lone lands.
    for (const id of [b!, c!]) await pointerDrag(page, card(id), onTopPoint(await boxOf(card(a!))));
    await expect(card(a!)).toHaveAttribute('data-pile-size', '3');
    const [pile, ...rest] = await piles(page);
    expect(rest, 'five lone lands after the pile').toEqual(ids.slice(3).map((id) => [id]));
    expect([...pile!].sort(), 'the pile is a, b and c').toEqual([a, b, c].sort());
    expect(pile![0], 'on a').toBe(a);
    const top = pile![pile!.length - 1]!;

    // Held still on the pile's top card, then carried past the last land's right edge.
    const last = ids[ids.length - 1]!;
    const from = await pressPoint(card(top));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.waitForTimeout(800);
    const to = await boxOf(card(last));
    await page.mouse.move(to.x + to.width * 0.95, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    const moved = [...ids.slice(3).map((id) => [id]), pile];
    await expect.poll(() => piles(page), { timeout: 5_000, message: `the whole pile moved after the last land, still ${pile!.join(', ')}` }).toEqual(moved);
    console.log(`[stack] long press: ${JSON.stringify(await piles(page))}`);

    // A press that moves at once is the one card: the top card alone leaves the pile, before the first land.
    const first = await boxOf(card(ids[3]!));
    await pointerDrag(page, card(top), { x: first.x + first.width * 0.05, y: first.y + first.height / 2 });
    await expect
      .poll(() => piles(page), { timeout: 5_000, message: 'a quick drag of the top card takes only that card' })
      .toEqual([[top], ...ids.slice(3).map((id) => [id]), pile!.slice(0, -1)]);
    console.log(`[stack] quick drag: ${JSON.stringify(await piles(page))}`);
  } finally {
    await stack.stop();
  }
});
