/**
 * The operator, 2026-10-10: "we need to do another pass on cursor position … in the first img you
 * can see the operator picking up a swamp and shifting it slightly. in the second image you can see
 * how it looks from the other side. the difference here is quite jarring. the second screen does
 * have maybe 20-30% less width which is probably where the distortion comes from but i dont think
 * its calculated correctly."
 *
 * Two browsers at different widths (bob ~28% narrower). Alice first leaves gaps before her Mountain
 * (so its home is not the row's first column, as in the screenshot), then lifts it and nudges it a
 * little to the right and down, and holds it there. On BOTH screens: the lifted copy's centre and
 * the cursor, each minus the real card's home centre, in units of that card's own size. Bob's
 * numbers must be alice's, mirrored top-to-bottom (the seats are).
 *
 * Scenario `land-into-middle`: alice has a Forest and a Mountain on her battlefield.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { boxOf, centre, type Box } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const ownCard = (page: Page, id: number) => page.locator(`.seat[data-viewer] [data-zone="battlefield"] li.board-card[data-card-id="${id}"]`);
const theirCard = (page: Page, id: number) => page.locator(`.seat:not([data-viewer]) [data-zone="battlefield"] li.board-card[data-card-id="${id}"]`);

/** The columns of the row `id` sits in: card ids, `null` for a gap (a virtual scaffold column is left out). */
async function rowOf(page: Page, side: 'you' | 'them', id: number): Promise<(number | null)[]> {
  const seat = side === 'you' ? '.seat[data-viewer]' : '.seat:not([data-viewer])';
  return page.locator(`${seat} [data-zone="battlefield"] li.board-card[data-card-id="${id}"]`).evaluate((li) =>
    Array.from(li.parentElement!.querySelectorAll(':scope > li.board-card, :scope > li.zone__gap:not([data-virtual])')).map((e) =>
      e.classList.contains('zone__gap') ? null : Number(e.getAttribute('data-card-id')),
    ),
  );
}

/** A box once it has stopped moving (the presence layer glides over a 90 ms transition). */
async function still(read: () => Promise<Box | null>): Promise<Box> {
  let last = await read();
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 120));
    const now = await read();
    if (now !== null && last !== null && Math.abs(now.x - last.x) < 0.5 && Math.abs(now.y - last.y) < 0.5) return now;
    last = now;
  }
  throw new Error('never settled');
}

const units = (p: { x: number; y: number }, home: Box) => {
  const c = centre(home);
  return { x: (p.x - c.x) / home.width, y: (p.y - c.y) / home.height };
};
const fmt = (u: { x: number; y: number }) => `(${u.x.toFixed(3)},${u.y.toFixed(3)})`;

test(titled('a battlefield card lifted and nudged stands the same fraction of a card off its home on the other, narrower screen — and so does the cursor'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'land-into-middle');
    await alice.page.setViewportSize({ width: 1600, height: 900 });
    await bob.page.setViewportSize({ width: 1150, height: 900 });
    const lands = () => alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card[data-card-id]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card-id'))));
    await expect.poll(lands, { timeout: 30_000, message: 'alice has her two lands' }).toHaveLength(2);
    const [, mountain] = (await lands()) as [number, number];
    await expect(theirCard(bob.page, mountain), 'bob draws her Mountain').toHaveCount(1, { timeout: 20_000 });

    // Leave gaps before the Mountain: carry it to the third empty column past the row's end.
    const home0 = centre(await boxOf(ownCard(alice.page, mountain)));
    await alice.page.mouse.move(home0.x, home0.y);
    await alice.page.mouse.down();
    await alice.page.mouse.move(home0.x + 8, home0.y + 8, { steps: 3 });
    const scaffold = ownCard(alice.page, mountain).locator('xpath=..').locator(':scope > li.zone__gap[data-virtual]');
    await expect.poll(() => scaffold.count(), { timeout: 3_000, message: 'the empty columns are drawn' }).toBeGreaterThan(2);
    const far = centre(await boxOf(scaffold.nth(2)));
    await alice.page.mouse.move(far.x, far.y, { steps: 12 });
    await alice.page.mouse.up();
    await expect.poll(async () => (await rowOf(alice.page, 'you', mountain)).indexOf(mountain), { timeout: 5_000, message: 'the Mountain sits past empty columns' }).toBeGreaterThan(2);
    const aliceRow = await rowOf(alice.page, 'you', mountain);
    await expect.poll(() => rowOf(bob.page, 'them', mountain), { timeout: 10_000, message: 'bob draws her row the same' }).toEqual(aliceRow);
    console.log(`[w69-cursor] row alice=${JSON.stringify(aliceRow)} bob=${JSON.stringify(await rowOf(bob.page, 'them', mountain))}`);

    // The operator's gesture: lift the Mountain and shift it slightly — 25 px right, 10 px down — and hold.
    const home = await boxOf(ownCard(alice.page, mountain));
    const grab = { x: home.x + home.width * 0.4, y: home.y + home.height * 0.6 };
    await alice.page.mouse.move(grab.x, grab.y);
    await alice.page.mouse.down();
    await alice.page.mouse.move(grab.x + 8, grab.y + 8, { steps: 3 });
    const pointer = { x: grab.x + 25, y: grab.y + 10 };
    await alice.page.mouse.move(pointer.x, pointer.y, { steps: 6 });
    const ghost = await still(() => alice.page.locator('.board > [data-arrange-ghost]').boundingBox());
    const aliceHome = await boxOf(ownCard(alice.page, mountain));
    const aliceLift = units(centre(ghost), aliceHome);
    const aliceCursor = units(pointer, aliceHome);

    await expect(bob.page.locator('[data-board-overlay] .presence__lift'), 'bob sees her lifted Mountain').toHaveCount(1, { timeout: 5_000 });
    const lift = await still(() => bob.page.locator('[data-board-overlay] .presence__lift').boundingBox());
    const tip = await still(() => bob.page.locator('[data-board-overlay] .presence').boundingBox());
    const bobHome = await boxOf(theirCard(bob.page, mountain));
    const bobLift = units(centre(lift), bobHome);
    const bobCursor = units({ x: tip.x, y: tip.y }, bobHome);
    console.log(
      `[w69-cursor] alice 1600 home=(${aliceHome.x.toFixed(0)},${aliceHome.y.toFixed(0)},${aliceHome.width.toFixed(0)}) lift=${fmt(aliceLift)} cursor=${fmt(aliceCursor)}` +
        ` | bob 1150 home=(${bobHome.x.toFixed(0)},${bobHome.y.toFixed(0)},${bobHome.width.toFixed(0)}) lift=${fmt(bobLift)} cursor=${fmt(bobCursor)} (bob's y is mirrored)`,
    );
    await alice.page.mouse.up();

    // Bob's y is alice's mirrored: her seat is drawn upside down at the top of his board.
    expect(Math.abs(bobLift.x - aliceLift.x), `the lifted card is ${aliceLift.x.toFixed(2)} of a card right of home on hers, ${bobLift.x.toFixed(2)} on his`).toBeLessThan(0.08);
    expect(Math.abs(bobLift.y + aliceLift.y), `the lifted card's height off home: ${aliceLift.y.toFixed(2)} on hers, ${bobLift.y.toFixed(2)} mirrored on his`).toBeLessThan(0.08);
    expect(Math.abs(bobCursor.x - aliceCursor.x), `the cursor is ${aliceCursor.x.toFixed(2)} of a card right of home on hers, ${bobCursor.x.toFixed(2)} on his`).toBeLessThan(0.08);
    expect(Math.abs(bobCursor.y + aliceCursor.y), `the cursor's height off home: ${aliceCursor.y.toFixed(2)} on hers, ${bobCursor.y.toFixed(2)} mirrored on his`).toBeLessThan(0.08);
  } finally {
    await stack.stop();
  }
});
