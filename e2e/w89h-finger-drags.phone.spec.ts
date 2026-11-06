/**
 * Wave 89 polish 6 — every drag the desktop has works with a finger (the operator, 2026-11-04: "lets make
 * sure that finger dragging to select stuff works"). Real Forge, both seats on phones, every press a real
 * CDP touch (`touchDrag`, `Locator.tap`), never a mouse. What each gesture sent is read from what Forge
 * answered: the server's own command log, or the board both screens draw from it.
 *
 * - a hand card dragged up plays it; a targeted spell dragged onto its target casts it at that target;
 * - a stack item is carried by a finger, and the other screen sees it move;
 * - attackers dragged onto a player and onto a planeswalker; a blocker dragged onto an attacker, and a
 *   second tap on it takes the block back;
 * - a finger sweeping sideways over a lane, or over the hand, scrolls it and starts nothing;
 * - a slow drag never opens the long-press card view;
 * - a card dragged within an order prompt (Ponder's library) moves there.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one each test SKIPS and its
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { castCard, dragHandCard, enabledOk, handCardNamed, makeTitled, offeredCard, ownNamed, promptMethod, serverLog } from './play/board.ts';
import { assignBlock, passToDeclareAttackers, undoBlock } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { PHONE, raiseHand, touchDrag } from './play/phone.ts';
import { startScenarioMatch } from './play/scenario.ts';

test.use(PHONE);

const forge = forgeAvailability();
const titled = makeTitled(forge);

const centre = async (l: Locator): Promise<{ x: number; y: number }> => {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const card = (page: Page, id: number): Locator => page.locator(`[data-board-card="${id}"]`);
const theirNamed = (page: Page, name: string): Promise<number[]> =>
  page
    .locator('[data-testid^="lane-their-"] li.board-card')
    .evaluateAll((els, n) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === n).map((e) => Number(e.getAttribute('data-board-card'))), name);
/** Forge's own commands from seat `seat`, as the server logged them, from row `from` on. */
const commands = (stack: { serverLogFile: string }, seat: number, from = 0): string[] =>
  serverLog(stack)
    .slice(from)
    .filter((r) => r.evt === 'forge-command' && r.seat === seat)
    .map((r) => `${String(r.method)}${r.card === undefined ? '' : `:${String(r.card)}`}`);
/** A slow line of points from `a` to `b`, `ms` long in `n` steps. */
const line = (a: { x: number; y: number }, b: { x: number; y: number }, n: number) => Array.from({ length: n }, (_, i) => ({ x: a.x + ((b.x - a.x) * (i + 1)) / n, y: a.y + ((b.y - a.y) * (i + 1)) / n }));

test(titled('a finger scrolls a lane and the hand sideways and starts nothing; a slow drag opens no card view; a spell dragged onto its target is cast at it; a stack item carried by a finger moves on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'promo-valakut');
    const page = alice.page;
    await page.waitForTimeout(1_000);
    const before = serverLog(stack).length;

    // Sideways over the lands lane's cards: the lane scrolls, nothing is sent, nothing opens.
    const lands = page.getByTestId('lane-my-lands');
    const lb = (await lands.boundingBox())!;
    const scrolled = (l: Locator) => l.evaluate((el) => el.scrollLeft);
    const landsAt = await scrolled(lands);
    await touchDrag(page, { x: lb.x + lb.width - 30, y: lb.y + lb.height / 2 }, line({ x: lb.x + lb.width - 30, y: lb.y + lb.height / 2 }, { x: lb.x + 40, y: lb.y + lb.height / 2 }, 10));
    await page.waitForTimeout(500);
    expect.soft(await scrolled(lands), 'a sideways swipe scrolls the lands lane').toBeGreaterThan(landsAt);
    // Sideways over the hand: the carousel scrolls, no card lifts.
    const hand = page.getByTestId('lane-my-hand');
    await raiseHand(page);
    const hb = (await hand.boundingBox())!;
    const handAt = await scrolled(hand);
    await touchDrag(page, { x: hb.x + hb.width - 30, y: hb.y + hb.height / 2 }, line({ x: hb.x + hb.width - 30, y: hb.y + hb.height / 2 }, { x: hb.x + 40, y: hb.y + hb.height / 2 }, 10));
    await page.waitForTimeout(500);
    expect.soft(await scrolled(hand), 'a sideways swipe scrolls the hand').toBeGreaterThan(handAt);
    expect.soft(await page.locator('[data-cast-lift]').count(), 'and lifts nothing').toBe(0);
    expect.soft(await page.getByTestId('card-view').count(), 'nor opens a card view').toBe(0);
    expect.soft(commands(stack, 0, before), 'nothing reached Forge').toEqual([]);
    await hand.evaluate((el) => {
      el.scrollLeft = 0;
    });

    // A slow drag up and back home: a second and a half under the finger, and no long-press read.
    const bolt = await offeredCard(page, 'Lightning Bolt', { zone: 'hand' });
    const home = await centre(card(page, bolt));
    let views = 0;
    const counting = setInterval(() => {
      void page.getByTestId('card-view').count().then((n) => (views += n));
    }, 100);
    await touchDrag(page, home, [...line(home, { x: home.x, y: home.y - 140 }, 40), ...line({ x: home.x, y: home.y - 140 }, home, 40)]);
    clearInterval(counting);
    await page.waitForTimeout(400);
    expect.soft(views, 'no card view opened during a slow drag').toBe(0);
    expect.soft(await handCardNamed(page, 'Lightning Bolt'), 'let go over the hand, the card is still in it').toBe(bolt);

    // Bolt dragged up onto the table parks it, and Forge asks for its target; a drag from the parked
    // card onto Tarmogoyf aims it there (the arrow drag).
    const [goyf] = await theirNamed(page, 'Tarmogoyf');
    const sent = serverLog(stack).length;
    const park = await centre(page.getByTestId('lane-my-permanents'));
    expect(await dragHandCard(page, bolt, park), 'the finger lifted Bolt').toBe(true);
    await expect(card(page, goyf!), 'Forge asks for Bolt’s target').toHaveAttribute('data-selectable', 'true', { timeout: 20_000 });
    // A finger has no hover to aim with: it carries the arrow from the parked card itself.
    const parked = await centre(page.locator(`[data-cast-ghost="${bolt}"], [data-board-card="${bolt}"]`).first());
    await touchDrag(page, parked, line(parked, await centre(card(page, goyf!)), 14));
    await expect
      .poll(() => commands(stack, 0, sent), { timeout: 20_000, message: 'Bolt was cast, and Tarmogoyf chosen as its target' })
      .toEqual(expect.arrayContaining([`selectCard:${bolt}`, `selectCard:${goyf}`]));

    // The Bolt on the stack, carried by alice's finger: it moves on her screen, and on bob's.
    const placed = page.locator('[data-placed-spell]:not([data-placed-leaving])').first();
    await placed.waitFor({ timeout: 15_000 });
    const id = await placed.getAttribute('data-placed-spell');
    const at = (p: Page) => p.locator(`[data-placed-spell="${id}"]`).evaluate((el) => [el.style.getPropertyValue('--placed-x'), el.style.getPropertyValue('--placed-y')].join(','));
    const [aliceWas, bobWas] = [await at(page), await at(bob.page)];
    const from = await centre(placed);
    await touchDrag(page, from, line(from, { x: from.x - 60, y: from.y + 70 }, 12));
    await expect.poll(() => at(page), { timeout: 5_000, message: 'the stack item moved under alice’s finger' }).not.toBe(aliceWas);
    await expect.poll(() => at(bob.page), { timeout: 10_000, message: 'and bob saw it move' }).not.toBe(bobWas);
  } finally {
    await stack.stop();
  }
});

test(titled('attackers dragged by a finger onto a player and onto a planeswalker attack them; a blocker dragged onto an attacker blocks it, and a second tap takes the block back'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'tr-bigboard');
    const page = alice.page;
    await passToDeclareAttackers(page);
    const [bears] = await ownNamed(page, 'Grizzly Bears');
    const [elves] = await ownNamed(page, 'Llanowar Elves');
    const [elspeth] = await theirNamed(page, "Elspeth, Sun's Champion");
    const face = page.locator('[data-testid="seat-chip-opp"] [data-player-face]');
    // Elspeth is the last of bob's permanents, past the lane's right edge: a player scrolls to her first.
    await card(page, elspeth!).scrollIntoViewIfNeeded();
    for (const [who, target, what] of [
      [bears!, face, 'bob'],
      [elves!, card(page, elspeth!), 'Elspeth'],
    ] as const) {
      // A player scrolls each lane to the card it wants first: on this board both run past the screen.
      await card(page, who).scrollIntoViewIfNeeded();
      await target.scrollIntoViewIfNeeded();
      const from = await centre(card(page, who));
      await touchDrag(page, from, line(from, await centre(target), 14));
      await expect(card(page, who), `dragged onto ${what}, it attacks`).toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
    }
    await enabledOk(page).click();

    // Bob blocks the Bears by dragging his Serra Angel onto it, then takes it back with a second tap.
    await expect.poll(() => bob.page.getByTestId('live-says').textContent(), { timeout: 30_000 }).toMatch(/block/i);
    const [angel] = await ownNamed(bob.page, 'Serra Angel');
    await card(bob.page, angel!).scrollIntoViewIfNeeded();
    await card(bob.page, bears!).scrollIntoViewIfNeeded();
    await assignBlock(bob.page, angel!, bears!);
    await expect(card(bob.page, angel!), 'dragged onto the Bears, the Angel blocks').toHaveAttribute('data-blocking', 'true', { timeout: 10_000 });
    const sent = serverLog(stack).length;
    await undoBlock(bob.page, angel!);
    await expect.poll(() => commands(stack, 1, sent), { timeout: 10_000, message: 'the second tap reached Forge' }).toContain(`selectCard:${angel}`);
    await expect(card(bob.page, angel!), 'and the block is taken back').not.toHaveAttribute('data-blocking', 'true', { timeout: 10_000 });
  } finally {
    await stack.stop();
  }
});

test(titled('a card dragged by a finger within Ponder’s library order moves there'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'order-drag-ponder');
    const page = alice.page;
    const ponder = await offeredCard(page, 'Ponder', { zone: 'hand', timeout: 30_000 });
    await castCard(page, ponder);
    await expect.poll(() => promptMethod(page), { timeout: 20_000, message: 'Ponder’s order opened' }).toBe('order');
    const dest = page.getByTestId('zone-dest');
    const ids = () => dest.locator('li[data-card-id]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card-id'))));
    const [a, , c] = (await ids()) as [number, number, number];
    const from = await centre(dest.locator(`li[data-card-id="${c}"]`));
    const top = (await dest.locator(`li[data-card-id="${a}"]`).boundingBox())!;
    // The row runs across: the first card's left edge is before it.
    await touchDrag(page, from, line(from, { x: top.x + 6, y: top.y + top.height / 2 }, 14));
    await expect.poll(ids, { timeout: 5_000, message: 'the third card is first now' }).toEqual(expect.arrayContaining([c]));
    expect((await ids())[0], 'dragged to the top, it is the top').toBe(c);
  } finally {
    await stack.stop();
  }
});
