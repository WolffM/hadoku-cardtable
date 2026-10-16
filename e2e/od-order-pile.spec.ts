/**
 * Against real Forge. The operator, 2026-10-15, over Tezzeret, Agent of Bolas's +1 ("… Put the rest on
 * the bottom of your library in any order"), drawn as a grid of whole tiles under "Unplaced 0" and
 * "Closest to top 4": *"this UI is really awkward. it's not clear what card is on top. we need a better
 * way to order card. the goal is still for this view to not need a scroll bar. why not just visually
 * stack the cards like how we stack cards on the board? then we can fit more cards in the same spot."*
 * Then, 2026-10-16, over the pile that answered it: *"also the 'Closest to top 2' wording is confusing.
 * can we instead just show 'Bottom of deck' and show a transparent ethereal representation of the deck
 * above the stack?"*
 *
 * So each group of an order over cards is ONE pile, measured at both of `table-fit.spec.ts`'s sizes:
 *
 *  - one column, each card drawn above the one below it by less than half a card: they overlap;
 *  - the lowest card is in front: every corner of it and its middle hit it; every other card's strip,
 *    above the card below it, hits that card;
 *  - a group going into the library says where in plain words ("Bottom of library"), and a ghost of the
 *    library is drawn where the library is: above the pile when the cards go under it, below when they go
 *    on top. The card that touches the ghost is the one Forge puts next to the rest of the library;
 *  - nothing scrolls: the sheet, its body and both lists hold what they draw.
 *
 * `od-tezzeret-pile`: alice activates Tezzeret's +1 over five non-artifacts, so all five go to the bottom
 * and Forge asks their order. `scry-one-prompt`: Foresee's Scry 4, the two-group order — and Foresee's
 * draw is the proof of which way up the top pile is. `order-drag-ponder`: Ponder puts three back on top,
 * and its draw is the card the pile drew farthest from the library.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test SKIPS and
 * its title says why.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { castCard, clickPermanent, enabledOk, livePrompt, makeTitled, offered, promptMethod, stackCount } from './play/board.ts';
import { answerConfirm, confirmOpen } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { dragRowOnto, settle } from './play/order.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const SIZES = [
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
] as const;

interface PileReport {
  list: string;
  /** The group's heading, as drawn. */
  heading: string;
  /** The answer's order: the rows as the DOM holds them. */
  ids: number[];
  /** The rows from the top of the screen down. */
  drawn: number[];
  /** Every card in one column: the same left edge and width. */
  column: boolean;
  /** How far each card is drawn above the one below it, px (top of the screen first). */
  rises: number[];
  /** A card's height, px. */
  height: number;
  /** Every corner and the middle of the lowest card hit it. */
  frontWhole: boolean;
  /** Each card above the lowest shows its strip: the part above the card below it hits it. */
  stripsShow: boolean[];
  /** The library's ghost in this group: where it is against the pile, and the gap to the nearest card, px. */
  ghost: { side: 'above' | 'below' | 'overlaps'; gap: number; touching: number | null } | null;
}

/** Both groups as drawn, and every box of the sheet that scrolls. */
function measure(page: Page): Promise<{ piles: PileReport[]; scrolls: string[] }> {
  return page.evaluate(() => {
    const host = document.querySelector('[data-testid="live-prompt"]');
    if (host === null) throw new Error('no prompt');
    const sheet = host.matches('.prompt') ? host : host.querySelector('.prompt');
    const lists = ['order-source', 'order-dest'].flatMap((t) => {
      const el = host.querySelector<HTMLElement>(`[data-testid="${t}"]`);
      return el === null ? [] : [el];
    });
    const owner = (x: number, y: number) => document.elementFromPoint(x, y)?.closest('li[data-card-id]') ?? null;
    const piles = lists.map((list) => {
      const rows = Array.from(list.querySelectorAll<HTMLElement>(':scope > li[data-card-id]'));
      const down = rows.map((row) => ({ row, box: row.getBoundingClientRect() })).sort((a, b) => a.box.top - b.box.top);
      const front = down[down.length - 1];
      const inset = 4;
      const frontWhole =
        front === undefined ||
        [
          [front.box.left + inset, front.box.top + inset],
          [front.box.right - inset, front.box.top + inset],
          [front.box.left + inset, front.box.bottom - inset],
          [front.box.right - inset, front.box.bottom - inset],
          [(front.box.left + front.box.right) / 2, (front.box.top + front.box.bottom) / 2],
        ].every(([x, y]) => owner(x!, y!) === front.row);
      const section = list.closest('section');
      const ghostEl = section?.querySelector<HTMLElement>('[data-testid="order-library"]') ?? null;
      let ghost: PileReport['ghost'] = null;
      if (ghostEl !== null && down.length > 0) {
        const g = ghostEl.getBoundingClientRect();
        const top = down[0]!;
        const foot = down[down.length - 1]!;
        if (g.bottom <= top.box.top + 2) ghost = { side: 'above', gap: Math.round(top.box.top - g.bottom), touching: Number(top.row.dataset.cardId) };
        else if (g.top >= foot.box.bottom - 2) ghost = { side: 'below', gap: Math.round(g.top - foot.box.bottom), touching: Number(foot.row.dataset.cardId) };
        else ghost = { side: 'overlaps', gap: 0, touching: null };
      } else if (ghostEl !== null) {
        ghost = { side: 'overlaps', gap: 0, touching: null };
      }
      return {
        list: list.dataset.testid ?? '?',
        heading: section?.querySelector('.prompt__col-head')?.textContent?.trim() ?? '',
        ids: rows.map((r) => Number(r.dataset.cardId)),
        drawn: down.map((d) => Number(d.row.dataset.cardId)),
        column: down.every((d) => Math.abs(d.box.left - down[0]!.box.left) < 2 && Math.abs(d.box.width - down[0]!.box.width) < 2),
        rises: down.slice(1).map((d, i) => Math.round(d.box.top - down[i]!.box.top)),
        height: Math.round(front?.box.height ?? 0),
        frontWhole,
        stripsShow: down.slice(0, -1).map((d, k) => owner(d.box.left + d.box.width / 2, (d.box.top + down[k + 1]!.box.top) / 2) === d.row),
        ghost,
      };
    });
    const boxesThatScroll = [sheet, sheet?.querySelector('.prompt__body') ?? null, ...lists].filter((e): e is Element => e !== null);
    const scrolls = boxesThatScroll
      .filter((e) => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)
      .map((e) => `${e.className} ${e.scrollWidth}x${e.scrollHeight} in ${e.clientWidth}x${e.clientHeight}`);
    return { piles, scrolls };
  });
}

/** The claims at one size: every group is one pile, the lowest card in front, and nothing scrolls. */
async function expectPiles(page: Page, label: string): Promise<PileReport[]> {
  await settle(page);
  const { piles, scrolls } = await measure(page);
  console.log(`[od] ${label} ${JSON.stringify(page.viewportSize())} piles ${JSON.stringify(piles)} scrolls ${JSON.stringify(scrolls)}`);
  for (const p of piles) {
    if (p.ids.length === 0) continue;
    expect(p.frontWhole, `${label} ${p.list}: the lowest card is drawn whole, in front`).toBe(true);
    if (p.ids.length < 2) continue;
    expect(p.column, `${label} ${p.list}: the cards are one pile, one column`).toBe(true);
    for (const rise of p.rises) {
      expect(rise, `${label} ${p.list}: each card is drawn above the one below it`).toBeGreaterThan(0);
      expect(rise, `${label} ${p.list}: and overlaps it — less than half a card up`).toBeLessThan(p.height / 2);
    }
    expect(p.stripsShow, `${label} ${p.list}: every card behind shows its strip`).toEqual(p.ids.slice(1).map(() => true));
  }
  expect(scrolls, `${label}: nothing in the sheet scrolls`).toEqual([]);
  return piles;
}

/**
 * The group going into the library at `end`: its heading says so, its ghost library sits on the side the
 * library is (above for the bottom, below for the top) and touches the pile, and the card touching it is
 * `adjacent` — the one Forge puts next to the rest of the library.
 */
function expectLibraryGroup(p: PileReport, label: string, end: 'top' | 'bottom', adjacent: number): void {
  const words = end === 'top' ? 'Top of library' : 'Bottom of library';
  expect(p.heading, `${label} ${p.list}: the heading says where the cards go`).toMatch(new RegExp(`^${words}`));
  expect(p.heading, `${label} ${p.list}: no "Closest to" caption`).not.toContain('Closest to');
  expect(p.ghost, `${label} ${p.list}: a ghost of the library is drawn with the pile`).not.toBeNull();
  expect(p.ghost!.side, `${label} ${p.list}: the library's ghost is ${end === 'top' ? 'below' : 'above'} the pile`).toBe(end === 'top' ? 'below' : 'above');
  expect(p.ghost!.gap, `${label} ${p.list}: and touches it`).toBeLessThanOrEqual(8);
  expect(p.ghost!.touching, `${label} ${p.list}: the card touching the ghost is the one Forge puts next to the library`).toBe(adjacent);
}

const rowsIds = (list: Locator): Promise<number[]> => list.locator(':scope > li').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card-id'))));
const handIds = (page: Page): Promise<number[]> =>
  page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));

/** The permanent named `name` on the viewer's battlefield, by id. */
async function ownPermanent(page: Page, name: string): Promise<number> {
  let id: number | undefined;
  await expect
    .poll(
      async () => {
        const cards = await page
          .locator('[data-zone="battlefield"][data-owner="you"] [data-board-card]')
          .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
        id = cards.find((c) => c.name === name)?.id;
        return id;
      },
      { timeout: 30_000, message: `${name} is on the battlefield` },
    )
    .not.toBeUndefined();
  return id!;
}

test(
  titled(
    'Tezzeret’s “put the rest on the bottom in any order”: one pile under “Bottom of library” with the library’s ghost above it, the card Forge puts next to the library touching it, no scroll bar at 1280×800 or 1366×768, and a drag reorders it',
  ),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(4 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, 'od-tezzeret-pile');
      const page = alice.page;
      await page.setViewportSize(SIZES[0]);

      const tezzeret = await ownPermanent(page, 'Tezzeret, Agent of Bolas');
      expect(await clickPermanent(page, tezzeret), 'Tezzeret is offered').toBe(true);
      const plusOne = page.locator('section[data-prompt="getAbilityToPlay"] [data-testid="prompt-choice"]').filter({ hasText: 'top five cards' });
      // The +1, then whatever stands between it and the order: priority on its way off the stack, and
      // Dig's optional artifact pick, which has nothing to take here.
      await expect
        .poll(
          async () => {
            const method = await promptMethod(page);
            if (method === 'order') return 'order';
            if ((await plusOne.count()) > 0) await plusOne.first().click({ timeout: 1_000 }).catch(() => undefined);
            else if (method !== null) await answerPrompt(page).catch(() => undefined);
            for (const p of [page, bob.page]) if ((await stackCount(p)) > 0 && (await enabledOk(p).count()) > 0) await enabledOk(p).first().click({ timeout: 1_000 }).catch(() => undefined);
            return method ?? 'none';
          },
          { timeout: 60_000, intervals: [250], message: 'Forge asks the order of the cards going to the bottom' },
        )
        .toBe('order');
      const prompt = livePrompt(page);
      console.log(`[od] tezzeret prompt ${JSON.stringify(((await prompt.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 200))} headings ${JSON.stringify(await prompt.locator('.prompt__col-head').allInnerTexts())}`);
      await expect(prompt, 'no "Closest to" caption anywhere').not.toContainText('Closest to');
      const source = page.getByTestId('order-source');
      const dest = page.getByTestId('order-dest');
      // Whichever group Forge started them in, the five are in one of them.
      await expect.poll(async () => (await rowsIds(source)).length + (await rowsIds(dest)).length, { message: 'all five cards are in the order' }).toBe(5);

      for (const size of SIZES) {
        await page.setViewportSize(size);
        await expectPiles(page, 'tezzeret');
      }
      await page.setViewportSize(SIZES[0]);

      // Every card placed, so the answer is the pile of five.
      for (let guard = 0; guard < 10 && (await rowsIds(source)).length > 0; guard++) await source.locator(':scope > li').first().click();
      await expect.poll(() => rowsIds(dest)).toHaveLength(5);
      for (const size of SIZES) {
        await page.setViewportSize(size);
        const placed = (await expectPiles(page, 'tezzeret placed')).find((p) => p.list === 'order-dest')!;
        // Forge reverses this answer and slides each card under the library in turn
        // (`PlayerControllerHuman.orderMoveToZoneList`, `DigEffect`'s `LibraryPosition2` -1): the answer's
        // LAST card goes under first, so it is the one next to the rest of the library, and the first is the
        // library's new bottom card — drawn lowest, in front.
        expectLibraryGroup(placed, 'tezzeret placed', 'bottom', placed.ids[placed.ids.length - 1]!);
        expect(placed.drawn[placed.drawn.length - 1], 'tezzeret placed: the library’s new bottom card is the lowest, in front').toBe(placed.ids[0]);
      }
      await page.setViewportSize(SIZES[0]);

      const order = await rowsIds(dest);
      const card = (id: number): Locator => prompt.locator(`li[data-card-id="${id}"]`);
      const deepest = order[order.length - 1]!;
      await dragRowOnto(page, card(deepest), card(order[0]!), 'before');
      await expect.poll(() => rowsIds(dest), { message: 'the card next to the library, dragged before the first, is now the first' }).toEqual([deepest, ...order.slice(0, -1)]);
      await expectPiles(page, 'tezzeret reordered');

      await page.getByTestId('prompt-submit').click();
      await expect.poll(() => promptMethod(page), { timeout: 15_000, message: 'the order reached Forge' }).not.toBe('order');
    } finally {
      await stack.stop();
    }
  },
);

test(
  titled('Foresee’s Scry 4: “Top of library” sits on the library’s ghost and “Bottom of library” hangs under its own, no scroll bar, and Foresee draws the two cards drawn farthest from the ghost'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioMatch(browser, stack, 'scry-one-prompt');
      const page = alice.page;
      await page.setViewportSize(SIZES[0]);
      await expect.poll(() => offered(page), { timeout: 30_000, message: 'alice is offered Foresee' }).not.toEqual([]);
      const [foresee] = await offered(page);
      await castCard(page, foresee!);
      await expect.poll(() => promptMethod(page), { timeout: 20_000, message: 'the scry opened' }).toBe('order');

      const prompt = livePrompt(page);
      const top = page.getByTestId('order-source');
      const bottom = page.getByTestId('order-dest');
      await expect(top.locator(':scope > li'), 'Scry 4: all four start on top').toHaveCount(4);
      for (const size of SIZES) {
        await page.setViewportSize(size);
        const piles = await expectPiles(page, 'scry');
        const onTop = piles.find((p) => p.list === 'order-source')!;
        // The top group's first card is the library's new top card (`GameAction.scry` reverses it and puts
        // each on top in turn): the last is the one resting on the rest of the library.
        expectLibraryGroup(onTop, 'scry', 'top', onTop.ids[onTop.ids.length - 1]!);
        expect(onTop.drawn[0], 'scry: the library’s new top card is drawn highest').toBe(onTop.ids[0]);
        const under = piles.find((p) => p.list === 'order-dest')!;
        expect(under.heading, 'scry: the bottom group says where its cards go').toMatch(/^Bottom of library/);
      }
      await page.setViewportSize(SIZES[0]);

      const [a, b] = (await rowsIds(top)) as [number, number, number, number];
      await dragRowOnto(page, prompt.locator(`li[data-card-id="${b}"]`), bottom);
      await expect.poll(() => rowsIds(bottom), { message: 'the second card went to the bottom' }).toEqual([b]);
      let drawnTop: number[] = [];
      for (const size of SIZES) {
        await page.setViewportSize(size);
        const piles = await expectPiles(page, 'scry split');
        const onTop = piles.find((p) => p.list === 'order-source')!;
        expectLibraryGroup(onTop, 'scry split', 'top', onTop.ids[onTop.ids.length - 1]!);
        // One card under the library: it is the one next to it (`GameAction.scry` slides each under in turn).
        expectLibraryGroup(piles.find((p) => p.list === 'order-dest')!, 'scry split', 'bottom', b);
        drawnTop = onTop.drawn;
      }
      expect((await rowsIds(top))[0], 'the first card is still the top one').toBe(a);

      const handBefore = await handIds(page);
      await page.getByTestId('prompt-submit').click();
      await expect.poll(async () => (await handIds(page)).length, { timeout: 20_000, message: 'Foresee draws two' }).toBe(handBefore.length + 2);
      const drew = (await handIds(page)).filter((id) => !handBefore.includes(id));
      console.log(`[od] scry drew ${JSON.stringify(drew)} top pile from the screen's top ${JSON.stringify(drawnTop)}`);
      expect([...drew].sort(), 'Foresee drew the two cards drawn farthest from the library’s ghost').toEqual(drawnTop.slice(0, 2).sort());
    } finally {
      await stack.stop();
    }
  },
);

test(
  titled('Ponder’s “put them back in any order”: one pile under “Top of library” sitting on the library’s ghost, no scroll bar, and Ponder draws the card drawn farthest from the ghost'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioMatch(browser, stack, 'order-drag-ponder');
      const page = alice.page;
      await page.setViewportSize(SIZES[0]);
      await expect.poll(() => offered(page), { timeout: 30_000, message: 'alice is offered Ponder' }).not.toEqual([]);
      const [ponder] = await offered(page);
      await castCard(page, ponder!);
      await expect.poll(() => promptMethod(page), { timeout: 20_000, message: 'Ponder’s order opened' }).toBe('order');

      const prompt = livePrompt(page);
      await expect(prompt, 'no "Closest to" caption anywhere').not.toContainText('Closest to');
      const source = page.getByTestId('order-source');
      const dest = page.getByTestId('order-dest');
      for (let guard = 0; guard < 10 && (await rowsIds(source)).length > 0; guard++) await source.locator(':scope > li').first().click();
      await expect.poll(() => rowsIds(dest)).toHaveLength(3);
      let drawnDest: number[] = [];
      for (const size of SIZES) {
        await page.setViewportSize(size);
        const placed = (await expectPiles(page, 'ponder')).find((p) => p.list === 'order-dest')!;
        // Forge reverses the answer and puts each card on top in turn (`RearrangeTopOfLibraryEffect`): the
        // answer's first card ends on top, its last rests on the rest of the library.
        expectLibraryGroup(placed, 'ponder', 'top', placed.ids[placed.ids.length - 1]!);
        drawnDest = placed.drawn;
      }
      await page.setViewportSize(SIZES[0]);

      const handBefore = await handIds(page);
      await page.getByTestId('prompt-submit').click();
      await expect.poll(() => confirmOpen(page), { timeout: 15_000, message: 'Ponder asks whether to shuffle' }).toBe(true);
      await answerConfirm(page, 'no');
      await expect.poll(async () => (await handIds(page)).length, { timeout: 15_000, message: 'Ponder draws' }).toBe(handBefore.length + 1);
      const drew = (await handIds(page)).filter((id) => !handBefore.includes(id));
      console.log(`[od] ponder drew ${JSON.stringify(drew)} pile from the screen's top ${JSON.stringify(drawnDest)}`);
      expect(drew, 'Ponder drew the card drawn farthest from the library’s ghost').toEqual([drawnDest[0]]);
    } finally {
      await stack.stop();
    }
  },
);
