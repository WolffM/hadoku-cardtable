/**
 * Against real Forge. The operator, 2026-10-15, over Tezzeret, Agent of Bolas's +1 ("… Put the rest on
 * the bottom of your library in any order"), drawn as a grid of whole tiles under "Unplaced 0" and
 * "Closest to top 4": *"this UI is really awkward. it's not clear what card is on top. we need a better
 * way to order card. the goal is still for this view to not need a scroll bar. why not just visually
 * stack the cards like how we stack cards on the board? then we can fit more cards in the same spot."*
 *
 * So each group of an order over cards is ONE pile, measured at both of `table-fit.spec.ts`'s sizes:
 *
 *  - one column, each card drawn above the one before it by less than half a card: they overlap;
 *  - the first card — the one closest to the top of the library — is in front, at the foot: every
 *    corner of it and its middle hit it; every other card's strip, above the card before it, hits that card;
 *  - nothing scrolls: the sheet, its body and both lists hold what they draw.
 *
 * Then the deepest card is dragged in front of the first, and the answer starts with it.
 *
 * `od-tezzeret-pile`: alice activates Tezzeret's +1 over five non-artifacts, so all five go to the
 * bottom and Forge asks their order. `scry-one-prompt`: Foresee's Scry 4, the two-group order.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test SKIPS and
 * its title says why.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { castCard, clickPermanent, enabledOk, livePrompt, makeTitled, offered, promptMethod, stackCount } from './play/board.ts';
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
  ids: number[];
  /** Every card in one column: the same left edge and width. */
  column: boolean;
  /** How far each card is drawn above the one before it, px. */
  rises: number[];
  /** A card's height, px. */
  height: number;
  /** Every corner and the middle of the first card hit it. */
  frontWhole: boolean;
  /** Each later card's strip, above the card before it, hits it. */
  stripsShow: boolean[];
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
      const boxes = rows.map((r) => r.getBoundingClientRect());
      const first = boxes[0];
      const inset = 4;
      const frontWhole =
        first === undefined ||
        [
          [first.left + inset, first.top + inset],
          [first.right - inset, first.top + inset],
          [first.left + inset, first.bottom - inset],
          [first.right - inset, first.bottom - inset],
          [(first.left + first.right) / 2, (first.top + first.bottom) / 2],
        ].every(([x, y]) => owner(x!, y!) === rows[0]);
      return {
        list: list.dataset.testid ?? '?',
        ids: rows.map((r) => Number(r.dataset.cardId)),
        column: boxes.every((b) => Math.abs(b.left - first!.left) < 2 && Math.abs(b.width - first!.width) < 2),
        rises: boxes.slice(1).map((b, i) => Math.round(boxes[i]!.top - b.top)),
        height: Math.round(first?.height ?? 0),
        frontWhole,
        stripsShow: rows.slice(1).map((r, k) => {
          const b = boxes[k + 1]!;
          return owner(b.left + b.width / 2, (b.top + boxes[k]!.top) / 2) === r;
        }),
      };
    });
    const boxesThatScroll = [sheet, sheet?.querySelector('.prompt__body') ?? null, ...lists].filter((e): e is Element => e !== null);
    const scrolls = boxesThatScroll
      .filter((e) => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)
      .map((e) => `${e.className} ${e.scrollWidth}x${e.scrollHeight} in ${e.clientWidth}x${e.clientHeight}`);
    return { piles, scrolls };
  });
}

/** The two claims at one size: every group is one pile, the first card in front, and nothing scrolls. */
async function expectPiles(page: Page, label: string): Promise<PileReport[]> {
  await settle(page);
  const { piles, scrolls } = await measure(page);
  console.log(`[od] ${label} ${JSON.stringify(page.viewportSize())} piles ${JSON.stringify(piles)} scrolls ${JSON.stringify(scrolls)}`);
  for (const p of piles) {
    if (p.ids.length === 0) continue;
    expect(p.frontWhole, `${label} ${p.list}: the first card is drawn whole, in front`).toBe(true);
    if (p.ids.length < 2) continue;
    expect(p.column, `${label} ${p.list}: the cards are one pile, one column`).toBe(true);
    for (const rise of p.rises) {
      expect(rise, `${label} ${p.list}: each card is drawn above the one before it`).toBeGreaterThan(0);
      expect(rise, `${label} ${p.list}: and overlaps it — less than half a card up`).toBeLessThan(p.height / 2);
    }
    expect(p.stripsShow, `${label} ${p.list}: every card behind shows its strip`).toEqual(p.ids.slice(1).map(() => true));
  }
  expect(scrolls, `${label}: nothing in the sheet scrolls`).toEqual([]);
  return piles;
}

const rowsIds = (list: Locator): Promise<number[]> => list.locator(':scope > li').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card-id'))));

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
  titled('Tezzeret’s “put the rest on the bottom in any order”: the five cards are one pile, the top card in front, no scroll bar at 1280×800 or 1366×768, and a drag reorders it'),
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
      const placed = await expectPiles(page, 'tezzeret placed');
      const order = placed.find((p) => p.list === 'order-dest')!.ids;
      const card = (id: number): Locator => prompt.locator(`li[data-card-id="${id}"]`);
      const deepest = order[order.length - 1]!;
      await dragRowOnto(page, card(deepest), card(order[0]!), 'before');
      await expect.poll(() => rowsIds(dest), { message: 'the deepest card, dragged in front of the first, is now the first' }).toEqual([deepest, ...order.slice(0, -1)]);
      await expectPiles(page, 'tezzeret reordered');

      await page.getByTestId('prompt-submit').click();
      await expect.poll(() => promptMethod(page), { timeout: 15_000, message: 'the order reached Forge' }).not.toBe('order');
    } finally {
      await stack.stop();
    }
  },
);

test(titled('Foresee’s Scry 4: cards on top and on bottom are two piles, the top card in front, no scroll bar'), async ({ browser }) => {
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
      await expectPiles(page, 'scry');
    }
    await page.setViewportSize(SIZES[0]);

    const [a, b] = (await rowsIds(top)) as [number, number, number, number];
    await dragRowOnto(page, prompt.locator(`li[data-card-id="${b}"]`), bottom);
    await expect.poll(() => rowsIds(bottom), { message: 'the second card went to the bottom' }).toEqual([b]);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await expectPiles(page, 'scry split');
    }
    expect((await rowsIds(top))[0], 'the first card is still the top one').toBe(a);

    await page.getByTestId('prompt-submit').click();
    await expect
      .poll(async () => (await prompt.count()) === 0 || (await promptMethod(page)) !== 'order', { timeout: 15_000, message: 'the scry answer reached Forge' })
      .toBe(true);
  } finally {
    await stack.stop();
  }
});
