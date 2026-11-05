/**
 * The operator, 2026-11-05: "small bug in mobile view, can't scroll the board when in combat, it always
 * draws a box. let's just drop the draw a box trigger and make sure mobile users can always pan through
 * the board". Real Forge, both seats on phones, every swipe a real CDP touch (`touchDrag`).
 *
 * In declare attackers (creatures offered) and in declare blockers (blockers offered), a finger swiping
 * sideways over a lane — over cards Forge offers nothing for, over offered creatures, and pinch-zoomed —
 * scrolls that lane, draws no box, and chooses nothing.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one each test SKIPS and its
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { enabledOk, makeTitled, ownNamed, serverLog } from './play/board.ts';
import { passToDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { PHONE, pinch, touchDrag } from './play/phone.ts';
import { startScenarioMatch } from './play/scenario.ts';

test.use(PHONE);

const forge = forgeAvailability();
const titled = makeTitled(forge);

const centre = async (l: Locator): Promise<{ x: number; y: number }> => {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** Forge's own commands from seat `seat`, as the server logged them, from row `from` on. */
const commands = (stack: { serverLogFile: string }, seat: number, from: number): string[] =>
  serverLog(stack)
    .slice(from)
    .filter((r) => r.evt === 'forge-command' && r.seat === seat)
    .map((r) => `${String(r.method)}${r.card === undefined ? '' : `:${String(r.card)}`}`);
/** A slow line of points from `a` to `b` in `n` steps. */
const line = (a: { x: number; y: number }, b: { x: number; y: number }, n: number) => Array.from({ length: n }, (_, i) => ({ x: a.x + ((b.x - a.x) * (i + 1)) / n, y: a.y + ((b.y - a.y) * (i + 1)) / n }));

/** Count every box the gesture layer ever draws on `page` from now on — a box shown for one frame counts. */
async function countBoxes(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as { __boxes: number };
    w.__boxes = 0;
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && r.target instanceof Element && r.target.hasAttribute('data-marquee')) w.__boxes++;
        r.addedNodes.forEach((n) => {
          if (n instanceof Element && n.matches('[data-testid="marquee"]')) w.__boxes++;
        });
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-marquee'] });
  });
  return () => page.evaluate(() => (window as unknown as { __boxes: number }).__boxes);
}

/**
 * Swipe a finger right to left across lane `testId`, through the middle of the band where the lane is
 * what a finger touches: pinch-zoomed, a lane's box runs under its neighbour's (each battlefield clips
 * its own), so the box's own middle can be the next lane's. Returns how far the lane scrolled.
 */
async function swipeLane(page: Page, testId: string): Promise<number> {
  const lane = page.getByTestId(testId);
  const band = await lane.evaluate((el) => {
    el.scrollLeft = 0;
    const r = el.getBoundingClientRect();
    const ys: number[] = [];
    for (let y = Math.ceil(r.top); y < r.bottom; y += 2) if (document.elementFromPoint(r.right - 30, y)?.closest('[data-testid^="lane-"]') === el) ys.push(y);
    return { x: r.right - 30, left: r.left + 40, y: ys.length === 0 ? null : (ys[0]! + ys.at(-1)!) / 2 };
  });
  expect(band.y, `${testId} is under a finger somewhere`).not.toBeNull();
  const from = { x: band.x, y: band.y! };
  await touchDrag(page, from, line(from, { x: band.left, y: from.y }, 10));
  await page.waitForTimeout(500);
  return lane.evaluate((el) => el.scrollLeft);
}

test(titled('a finger swiping a lane in declare attackers and in declare blockers scrolls it, draws no box and chooses nothing — pinch-zoomed too'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'tr-bigboard');
    const page = alice.page;
    await passToDeclareAttackers(page);
    const aliceBoxes = await countBoxes(page);
    const before = serverLog(stack).length;

    // Bob's creatures (nothing offered), Alice's lands (nothing offered), Alice's creatures (offered as attackers).
    for (const lane of ['lane-their-permanents', 'lane-my-lands', 'lane-my-permanents']) {
      expect.soft(await swipeLane(page, lane), `declare attackers: a swipe scrolls ${lane}`).toBeGreaterThan(0);
    }
    await pinch(page, { scale: 1.6 });
    await page.waitForTimeout(400);
    expect.soft(await swipeLane(page, 'lane-their-permanents'), 'pinch-zoomed, a swipe still scrolls').toBeGreaterThan(0);
    expect.soft(await aliceBoxes(), 'no box drawn').toBe(0);
    expect.soft(await page.locator('li.board-card[data-attacking]').count(), 'no attacker chosen').toBe(0);
    expect.soft(commands(stack, 0, before), 'nothing reached Forge').toEqual([]);

    // One attacker, by the finger's own drag onto bob, so bob has something to block.
    const [bears] = await ownNamed(page, 'Grizzly Bears');
    const bearsCard = page.locator(`[data-board-card="${bears}"]`);
    await bearsCard.scrollIntoViewIfNeeded();
    const from = await centre(bearsCard);
    await touchDrag(page, from, line(from, await centre(page.locator('[data-testid="seat-chip-opp"] [data-player-face]')), 14));
    await expect(bearsCard, 'the Bears attack').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
    await enabledOk(page).tap();

    await expect.poll(() => bob.page.getByTestId('live-says').textContent(), { timeout: 30_000 }).toMatch(/block/i);
    const bobBoxes = await countBoxes(bob.page);
    const blocking = serverLog(stack).length;
    // Alice's board (her lands and her attacker, nothing offered), and bob's own creatures (offered as blockers).
    for (const lane of ['lane-their-lands', 'lane-their-permanents', 'lane-my-permanents']) {
      expect.soft(await swipeLane(bob.page, lane), `declare blockers: a swipe scrolls ${lane}`).toBeGreaterThan(0);
    }
    expect.soft(await bobBoxes(), 'no box drawn').toBe(0);
    expect.soft(await bob.page.locator('li.board-card[data-blocking]').count(), 'no blocker chosen').toBe(0);
    expect.soft(commands(stack, 1, blocking), 'nothing reached Forge').toEqual([]);
  } finally {
    await stack.stop();
  }
});
