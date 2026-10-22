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
 * That was a pile. Then, 2026-10-19, over Ponder's pile: *"the UI for ponder is quite ugly"*, and the
 * manager: you cannot order cards you cannot read. So each zone of an order over cards is ONE ROW of whole
 * cards (`MovePrompt.tsx`), measured at both of `table-fit.spec.ts`'s sizes:
 *
 *  - one line, left to right, every card drawn whole: every corner and the middle of each hit it;
 *  - a zone going into the library is named by its end ("Bottom", under the title "Your library"), and a ghost
 *    of the library is drawn on the side the zone meets it: after the Top zone, before the Bottom zone. The card
 *    that touches the ghost is the one Forge puts next to the rest of the library;
 *  - nothing scrolls: the sheet, its body and the zones hold what they draw.
 *
 * `od-tezzeret-pile`: alice activates Tezzeret's +1 over five non-artifacts, so all five go to the bottom
 * and Forge asks their order. `scry-one-prompt`: Foresee's Scry 4, the two-group order — and Foresee's
 * draw is the proof of which way round the top row is. `order-drag-ponder`: Ponder puts three back on top,
 * and its draw is the card the row drew farthest from the library. `ol-relic-exile`: Relic of Progenitus
 * exiles alice's three graveyard cards and Forge asks their order, which the server answers with Forge's
 * own (`exileOrder`, `arrange.ts`): exile has no order (the operator, 2026-10-22: *"we can remove all
 * questions about exile order"*), so no order sheet opens.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test SKIPS and
 * its title says why.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { castCard, clickPermanent, livePrompt, makeTitled, offered, passOverStack, promptMethod, resizeWindow, serverLog } from './play/board.ts';
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

interface RowReport {
  list: string;
  /** The zone's heading, as drawn. */
  heading: string;
  /** The cards as the DOM holds them. */
  ids: number[];
  /** The cards from the left of the screen. */
  drawn: number[];
  /** Every card on one line. */
  line: boolean;
  /** Every corner and the middle of every card hit it: nothing covers any of them. */
  whole: boolean[];
  /** A card's width, px. */
  width: number;
  /** The library's ghost in this zone: where it is against the row, and the gap to the nearest card, px. */
  ghost: { side: 'left' | 'right' | 'overlaps'; gap: number; touching: number | null } | null;
}

/** Both zones as drawn, and every box of the sheet that scrolls. */
function measure(page: Page): Promise<{ rows: RowReport[]; scrolls: string[] }> {
  return page.evaluate(() => {
    const host = document.querySelector('[data-testid="live-prompt"]');
    if (host === null) throw new Error('no prompt');
    const sheet = host.matches('.prompt') ? host : host.querySelector('.prompt');
    const lists = ['zone-source', 'zone-dest'].flatMap((t) => {
      const el = host.querySelector<HTMLElement>(`[data-testid="${t}"]`);
      return el === null ? [] : [el];
    });
    const owner = (x: number, y: number) => document.elementFromPoint(x, y)?.closest('li[data-card-id]') ?? null;
    const rows = lists.map((list) => {
      const cards = Array.from(list.querySelectorAll<HTMLElement>(':scope > li[data-card-id]'));
      const across = cards.map((row) => ({ row, box: row.getBoundingClientRect() })).sort((a, b) => a.box.left - b.box.left);
      const inset = 4;
      const whole = across.map(({ row, box }) =>
        [
          [box.left + inset, box.top + inset],
          [box.right - inset, box.top + inset],
          [box.left + inset, box.bottom - inset],
          [box.right - inset, box.bottom - inset],
          [(box.left + box.right) / 2, (box.top + box.bottom) / 2],
        ].every(([x, y]) => owner(x!, y!) === row),
      );
      const section = list.closest('section');
      const ghostEl = section?.querySelector<HTMLElement>('[data-testid="zone-library"]') ?? null;
      let ghost: { side: 'left' | 'right' | 'overlaps'; gap: number; touching: number | null } | null = null;
      if (ghostEl !== null && across.length > 0) {
        const g = ghostEl.getBoundingClientRect();
        const first = across[0]!;
        const last = across[across.length - 1]!;
        if (g.right <= first.box.left + 2) ghost = { side: 'left', gap: Math.round(first.box.left - g.right), touching: Number(first.row.dataset.cardId) };
        else if (g.left >= last.box.right - 2) ghost = { side: 'right', gap: Math.round(g.left - last.box.right), touching: Number(last.row.dataset.cardId) };
        else ghost = { side: 'overlaps', gap: 0, touching: null };
      } else if (ghostEl !== null) {
        ghost = { side: 'overlaps', gap: 0, touching: null };
      }
      return {
        list: list.dataset.testid ?? '?',
        heading: section?.querySelector('.prompt__col-head')?.textContent?.trim() ?? '',
        ids: cards.map((r) => Number(r.dataset.cardId)),
        drawn: across.map((d) => Number(d.row.dataset.cardId)),
        line: across.every((d) => Math.abs(d.box.top - across[0]!.box.top) < 2),
        whole,
        width: Math.round(across[0]?.box.width ?? 0),
        ghost,
      };
    });
    const boxesThatScroll = [sheet, sheet?.querySelector('.prompt__body') ?? null, ...lists].filter((e): e is Element => e !== null);
    const scrolls = boxesThatScroll
      .filter((e) => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)
      .map((e) => `${e.className} ${e.scrollWidth}x${e.scrollHeight} in ${e.clientWidth}x${e.clientHeight}`);
    return { rows, scrolls };
  });
}

/** The claims at one size: every zone is one row of whole cards, readable, and nothing scrolls. */
async function expectRows(page: Page, label: string): Promise<RowReport[]> {
  await settle(page);
  const { rows, scrolls } = await measure(page);
  console.log(`[od] ${label} ${JSON.stringify(page.viewportSize())} rows ${JSON.stringify(rows)} scrolls ${JSON.stringify(scrolls)}`);
  for (const r of rows) {
    if (r.ids.length === 0) continue;
    expect(r.line, `${label} ${r.list}: the cards are one row`).toBe(true);
    expect(r.whole, `${label} ${r.list}: every card is drawn whole, nothing over it`).toEqual(r.ids.map(() => true));
    expect(r.width, `${label} ${r.list}: a card is readable — at least a small board card wide`).toBeGreaterThanOrEqual(56);
    expect(r.drawn, `${label} ${r.list}: the cards are drawn left to right as the DOM holds them`).toEqual(r.ids);
  }
  expect(scrolls, `${label}: nothing in the sheet scrolls`).toEqual([]);
  return rows;
}

/**
 * The zone going into the library at `end`: its heading says so, its ghost library sits on the side the zone
 * meets it (after the Top zone, before the Bottom zone) and touches the row, and the card touching it is
 * `adjacent` — the one Forge puts next to the rest of the library.
 */
function expectLibraryGroup(r: RowReport, label: string, end: 'top' | 'bottom', adjacent: number): void {
  const words = end === 'top' ? 'Top' : 'Bottom';
  expect(r.heading, `${label} ${r.list}: the heading says where the cards go`).toBe(words);
  expect(r.heading, `${label} ${r.list}: no "Closest to" caption`).not.toContain('Closest to');
  expect(r.ghost, `${label} ${r.list}: a ghost of the library is drawn with the row`).not.toBeNull();
  expect(r.ghost!.side, `${label} ${r.list}: the library's ghost is ${end === 'top' ? 'after' : 'before'} the row`).toBe(end === 'top' ? 'right' : 'left');
  expect(r.ghost!.gap, `${label} ${r.list}: and touches it`).toBeLessThanOrEqual(8);
  expect(r.ghost!.touching, `${label} ${r.list}: the card touching the ghost is the one Forge puts next to the library`).toBe(adjacent);
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
    'Tezzeret’s “put the rest on the bottom in any order”: one row of whole cards under “Bottom” with the library’s ghost before it, the card Forge puts next to the library touching it, no scroll bar at 1280×800 or 1366×768, and a drag reorders it',
  ),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(4 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, 'od-tezzeret-pile');
      const page = alice.page;
      await resizeWindow(page, SIZES[0]);

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
            for (const p of [page, bob.page]) await passOverStack(p);
            return method ?? 'none';
          },
          { timeout: 60_000, intervals: [250], message: 'Forge asks the order of the cards going to the bottom' },
        )
        .toBe('order');
      const prompt = livePrompt(page);
      console.log(`[od] tezzeret prompt ${JSON.stringify(((await prompt.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 200))} headings ${JSON.stringify(await prompt.locator('.prompt__col-head').allInnerTexts())}`);
      await expect(prompt, 'no "Closest to" caption anywhere').not.toContainText('Closest to');
      const source = page.getByTestId('zone-source');
      const dest = page.getByTestId('zone-dest');
      await expect(prompt.locator('.prompt__title'), 'the sheet is named by the library').toHaveText('Your library');
      // An order that places every card is one zone, every card in it from the start.
      await expect.poll(() => rowsIds(dest), { message: 'all five cards are in the one zone' }).toHaveLength(5);
      await expect(source, 'no second zone').toHaveCount(0);

      for (const size of SIZES) {
        await resizeWindow(page, size);
        await expectRows(page, 'tezzeret');
      }
      await resizeWindow(page, SIZES[0]);

      await expect(prompt.getByRole('heading', { name: /^Unplaced/ }), 'no "Unplaced" heading').toHaveCount(0);
      for (const size of SIZES) {
        await resizeWindow(page, size);
        const placed = (await expectRows(page, 'tezzeret placed')).find((r) => r.list === 'zone-dest')!;
        // Forge reverses this answer and slides each card under the library in turn
        // (`PlayerControllerHuman.orderMoveToZoneList`, `DigEffect`'s `LibraryPosition2` -1): the answer's
        // LAST card goes under first, so it is the one next to the rest of the library. That answer runs from
        // its lowest card (`first: 'bottom'`), so it is drawn the other way round: the card next to the
        // library is the leftmost, against the ghost, and the library's new bottom card the rightmost.
        expectLibraryGroup(placed, 'tezzeret placed', 'bottom', placed.ids[0]!);
      }
      await resizeWindow(page, SIZES[0]);

      const order = await rowsIds(dest);
      const card = (id: number): Locator => prompt.locator(`li[data-card-id="${id}"]`);
      const lowest = order[order.length - 1]!;
      await dragRowOnto(page, card(lowest), card(order[0]!), 'before');
      await expect.poll(() => rowsIds(dest), { message: 'the lowest card, dragged before the first, is now the first' }).toEqual([lowest, ...order.slice(0, -1)]);
      await expectRows(page, 'tezzeret reordered');

      await page.getByTestId('prompt-submit').click();
      await expect.poll(() => promptMethod(page), { timeout: 15_000, message: 'the order reached Forge' }).not.toBe('order');
    } finally {
      await stack.stop();
    }
  },
);

test(
  titled('Foresee’s Scry 4: “Top” runs into the library’s ghost and “Bottom” starts at its own, no scroll bar, and Foresee draws the two cards drawn farthest from the ghost'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioMatch(browser, stack, 'scry-one-prompt');
      const page = alice.page;
      await resizeWindow(page, SIZES[0]);
      await expect.poll(() => offered(page), { timeout: 30_000, message: 'alice is offered Foresee' }).not.toEqual([]);
      const [foresee] = await offered(page);
      await castCard(page, foresee!);
      await expect.poll(() => promptMethod(page), { timeout: 20_000, message: 'the scry opened' }).toBe('order');

      const prompt = livePrompt(page);
      const top = page.getByTestId('zone-source');
      const bottom = page.getByTestId('zone-dest');
      await expect(top.locator(':scope > li'), 'Scry 4: all four start on top').toHaveCount(4);
      for (const size of SIZES) {
        await resizeWindow(page, size);
        const rows = await expectRows(page, 'scry');
        const onTop = rows.find((r) => r.list === 'zone-source')!;
        // The top group's first card is the library's new top card (`GameAction.scry` reverses it and puts
        // each on top in turn): the last is the one resting on the rest of the library.
        expectLibraryGroup(onTop, 'scry', 'top', onTop.ids[onTop.ids.length - 1]!);
        expect(onTop.drawn[0], 'scry: the library’s new top card is drawn leftmost').toBe(onTop.ids[0]);
        const under = rows.find((r) => r.list === 'zone-dest')!;
        expect(under.heading, 'scry: the bottom group says where its cards go').toBe('Bottom');
      }
      await resizeWindow(page, SIZES[0]);

      const [a, b] = (await rowsIds(top)) as [number, number, number, number];
      await dragRowOnto(page, prompt.locator(`li[data-card-id="${b}"]`), bottom);
      await expect.poll(() => rowsIds(bottom), { message: 'the second card went to the bottom' }).toEqual([b]);
      let drawnTop: number[] = [];
      for (const size of SIZES) {
        await resizeWindow(page, size);
        const rows = await expectRows(page, 'scry split');
        const onTop = rows.find((r) => r.list === 'zone-source')!;
        expectLibraryGroup(onTop, 'scry split', 'top', onTop.ids[onTop.ids.length - 1]!);
        // One card under the library: it is the one next to it (`GameAction.scry` slides each under in turn).
        expectLibraryGroup(rows.find((r) => r.list === 'zone-dest')!, 'scry split', 'bottom', b);
        drawnTop = onTop.drawn;
      }
      expect((await rowsIds(top))[0], 'the first card is still the top one').toBe(a);

      const handBefore = await handIds(page);
      await page.getByTestId('prompt-submit').click();
      await expect.poll(async () => (await handIds(page)).length, { timeout: 20_000, message: 'Foresee draws two' }).toBe(handBefore.length + 2);
      const drew = (await handIds(page)).filter((id) => !handBefore.includes(id));
      console.log(`[od] scry drew ${JSON.stringify(drew)} top row from the left ${JSON.stringify(drawnTop)}`);
      expect([...drew].sort(), 'Foresee drew the two cards drawn farthest from the library’s ghost').toEqual(drawnTop.slice(0, 2).sort());
    } finally {
      await stack.stop();
    }
  },
);

test(
  titled('Ponder’s “put them back in any order”: one row of whole cards under “Top” ending at the library’s ghost, no scroll bar, and Ponder draws the card drawn farthest from the ghost'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioMatch(browser, stack, 'order-drag-ponder');
      const page = alice.page;
      await resizeWindow(page, SIZES[0]);
      await expect.poll(() => offered(page), { timeout: 30_000, message: 'alice is offered Ponder' }).not.toEqual([]);
      const [ponder] = await offered(page);
      await castCard(page, ponder!);
      await expect.poll(() => promptMethod(page), { timeout: 20_000, message: 'Ponder’s order opened' }).toBe('order');

      const prompt = livePrompt(page);
      await expect(prompt, 'no "Closest to" caption anywhere').not.toContainText('Closest to');
      const dest = page.getByTestId('zone-dest');
      await expect.poll(() => rowsIds(dest), { message: 'the three are in the one zone from the start' }).toHaveLength(3);
      await expect(page.getByTestId('zone-source'), 'no second zone to empty').toHaveCount(0);
      let drawnDest: number[] = [];
      for (const size of SIZES) {
        await resizeWindow(page, size);
        const placed = (await expectRows(page, 'ponder')).find((r) => r.list === 'zone-dest')!;
        // Forge reverses the answer and puts each card on top in turn (`RearrangeTopOfLibraryEffect`): the
        // answer's first card ends on top, its last rests on the rest of the library.
        expectLibraryGroup(placed, 'ponder', 'top', placed.ids[placed.ids.length - 1]!);
        drawnDest = placed.drawn;
      }
      await resizeWindow(page, SIZES[0]);

      const handBefore = await handIds(page);
      await page.getByTestId('prompt-submit').click();
      await expect.poll(() => confirmOpen(page), { timeout: 15_000, message: 'Ponder asks whether to shuffle' }).toBe(true);
      await answerConfirm(page, 'no');
      await expect.poll(async () => (await handIds(page)).length, { timeout: 15_000, message: 'Ponder draws' }).toBe(handBefore.length + 1);
      const drew = (await handIds(page)).filter((id) => !handBefore.includes(id));
      console.log(`[od] ponder drew ${JSON.stringify(drew)} row from the left ${JSON.stringify(drawnDest)}`);
      expect(drew, 'Ponder drew the card drawn farthest from the library’s ghost').toEqual([drawnDest[0]]);
    } finally {
      await stack.stop();
    }
  },
);

/** `ol-relic-exile.state`'s graveyard for alice: the cards "Exile all graveyards" moves together. */
const RELIC_GRAVEYARD = ['Lightning Bolt', 'Counterspell', 'Ponder'];

test(
  titled('Relic of Progenitus’s “exile all graveyards”: Forge’s exile order is answered for alice, no order sheet opens, and her three graveyard cards land in exile'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, 'ol-relic-exile');
      const page = alice.page;
      await resizeWindow(page, SIZES[0]);
      const relic = await ownPermanent(page, 'Relic of Progenitus');
      expect(await clickPermanent(page, relic), 'Relic of Progenitus is offered').toBe(true);
      const exileAll = page.locator('section[data-prompt="getAbilityToPlay"] [data-testid="prompt-choice"]').filter({ hasText: /graveyards/i });
      const exiled = page.locator('.seat[data-viewer] [data-zone="exile"] [data-board-card]');
      const shown = new Set<string>();
      await expect
        .poll(
          async () => {
            const method = await promptMethod(page);
            if (method !== null) shown.add(method);
            if ((await exileAll.count()) > 0) await exileAll.first().click({ timeout: 1_000 }).catch(() => undefined);
            else if (method !== null && method !== 'order') await answerPrompt(page).catch(() => undefined);
            for (const p of [page, bob.page]) await passOverStack(p);
            const names = await exiled.evaluateAll((els) => els.map((e) => e.querySelector('.card__name')?.textContent?.trim() ?? ''));
            return RELIC_GRAVEYARD.filter((name) => names.includes(name)).length;
          },
          { timeout: 60_000, intervals: [250], message: 'the three graveyard cards reached exile' },
        )
        .toBe(RELIC_GRAVEYARD.length);
      const answered = serverLog(stack).filter((r) => r.evt === 'ask-auto-answered' && r.seat === 0 && r.method === 'order');
      console.log(`[od] relic shown ${JSON.stringify([...shown])} answered ${JSON.stringify(answered.map((r) => r.why))}`);
      expect(answered.map((r) => r.why), 'Forge asked the exile order and the server answered it with Forge’s own').toEqual(['exile has no order']);
      expect([...shown], 'no order sheet opened').not.toContain('order');
    } finally {
      await stack.stop();
    }
  },
);
