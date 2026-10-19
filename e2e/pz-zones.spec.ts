/**
 * Against real Forge, driven by drag. The operator, 2026-10-19: *"the selection window for fate seal is a
 * bit confusing. it has 'select a card to put on bottom' But instead it would be nice if it were just two
 * zones 'top' and 'bottom' and i can drag between them … in general i feel like there way too many similar
 * UIs for this type of card selection and movement question. would be nice to unify as many of them as we
 * can"*. And on Ponder the same day: *"when dragging cards they are weirdly displaced from the cursor,
 * significantly down and left of where the cursor actually is … the unplaced zone disappears when all three
 * cards have been dragged … there's a horizontal scroll bar that appears in that window."*
 *
 * Every question that moves cards is one sheet of named zones (`apps/ui/src/play/prompts/MovePrompt.tsx`):
 *
 *  - `pz-fateseal`: Jace, the Mind Sculptor's +2 on bob. One prompt titled "Bob's library", Top | Bottom; the
 *    looked-at card dragged to Bottom goes under bob's library — Lantern of Insight shows bob's new top card.
 *  - `pz-scry`: Preordain's Scry 2. Top | Bottom; the second card dragged above the first, the first dragged
 *    to Bottom; Preordain draws the card the drag put on top.
 *  - `pz-surveil`: Notion Rain's Surveil 2. Top | Graveyard; one card dragged into the graveyard lands there,
 *    and the draw takes the other.
 *  - `order-drag-ponder`: Ponder. One zone, Top, every card in it from the start; a drag reorders it; Ponder
 *    draws the card the drag put on top.
 *
 * Each sheet is measured: the phantom keeps the spot it was grabbed at under the pointer (with the page
 * scrolled, for Ponder), an emptied zone is still drawn at its own size, and no box in the sheet scrolls
 * sideways. Screenshots at 1280×720 in both themes are kept beside the run's videos.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test SKIPS and its title
 * says why.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { castCard, clickPermanent, enabledOk, livePrompt, makeTitled, offered, pressOffered, promptMethod, resizeWindow, stackCount } from './play/board.ts';
import { answerConfirm, confirmOpen } from './play/confirm.ts';
import { forgeAvailability, RUN_DIR, startPlayStack } from './play/harness.ts';
import { beforePoint, pointIn, settle, stripPoint, type Point } from './play/order.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Kept with the videos, which a dispatch with `video` uploads even on success. */
const SHOTS = resolve(RUN_DIR, 'videos', 'pz-zones');
const SIZE = { width: 1280, height: 720 } as const;

const rows = (list: Locator): Locator => list.locator(':scope > li');
const idsIn = (list: Locator): Promise<number[]> => rows(list).evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card-id'))));
/** The cards' names, without the " (id)" Forge's own label ends in. */
const namesIn = (list: Locator): Promise<string[]> =>
  rows(list).evaluateAll((els) => els.map((e) => (e.querySelector('.card__name')?.textContent?.trim() ?? '').replace(/ \(\d+\)$/, '')));
const handNames = (page: Page): Promise<string[]> =>
  page
    .locator('[data-zone="hand"][data-owner="you"] [data-board-card]')
    .evaluateAll((els) => els.map((e) => (e.querySelector('.card__name')?.textContent?.trim() ?? '').replace(/ \(\d+\)$/, '')));
const headings = (page: Page): Promise<string[]> => livePrompt(page).locator('.prompt__col-head').allInnerTexts();

/** Every box in the sheet that scrolls sideways: none may. */
const sidewaysScroll = (page: Page): Promise<string[]> =>
  livePrompt(page).evaluate((host) =>
    [host, ...Array.from(host.querySelectorAll('*'))]
      .filter((el) => {
        const x = getComputedStyle(el).overflowX;
        return (x === 'auto' || x === 'scroll') && el.scrollWidth > el.clientWidth + 1;
      })
      .map((el) => `${el.className} ${el.scrollWidth}>${el.clientWidth}`),
  );

/** Both zones' boxes: an empty zone is still a drop target of its own size. */
const zoneBoxes = (page: Page): Promise<{ zone: string; w: number; h: number }[]> =>
  livePrompt(page).evaluate((host) =>
    Array.from(host.querySelectorAll<HTMLElement>('[data-testid="zone-source"], [data-testid="zone-dest"]')).map((el) => {
      const r = el.getBoundingClientRect();
      return { zone: el.dataset.zone ?? '?', w: Math.round(r.width), h: Math.round(r.height) };
    }),
  );

/** The sheet in both themes, at 1280×720. */
async function shoot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await settle(page);
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(SHOTS, `${name}-${theme}.png`) });
  }
}

/**
 * A real press-drag of `row` onto `onto`, a step at a time, measuring on every frame past the slop how far
 * the phantom's centre is from where the grab puts it (the pointer plus the press's offset from the row's
 * centre). Returns the worst of them, px.
 */
async function drag(page: Page, label: string, row: Locator, onto: Locator, at: Point | 'before' = { x: 0.5, y: 0.5 }): Promise<number> {
  await settle(page);
  const from = await stripPoint(row);
  const to = at === 'before' ? await beforePoint(onto) : await pointIn(onto, at);
  const box = (await row.boundingBox())!;
  const grab = { x: box.x + box.width / 2 - from.x, y: box.y + box.height / 2 - from.y };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  let drift = 0;
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
    await page.mouse.move(p.x, p.y);
    if (Math.hypot(p.x - from.x, p.y - from.y) < 10) continue;
    const off = await page.evaluate(
      ({ p, grab }) => {
        const copy = document.querySelector('[data-arrange-ghost] > li') ?? document.querySelector('[data-arrange-ghost]');
        if (copy === null) return Infinity;
        const r = copy.getBoundingClientRect();
        return Math.hypot(r.left + r.width / 2 - (p.x + grab.x), r.top + r.height / 2 - (p.y + grab.y));
      },
      { p, grab },
    );
    drift = Math.max(drift, off);
  }
  await page.mouse.up();
  console.log(`[pz] ${label}: drift ${drift.toFixed(1)}px`);
  expect(drift, `${label}: the phantom keeps the spot it was grabbed at under the pointer`).toBeLessThanOrEqual(2);
  return drift;
}

test(
  titled('Jace’s +2 fateseal is one prompt, “Bob’s library”, Top | Bottom: the card dragged to Bottom goes under bob’s library'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, 'pz-fateseal');
      const page = alice.page;
      await resizeWindow(page, SIZE);
      const bobTop = page.locator('.seat:not([data-viewer]) [data-library-top] .card__name');
      await expect(bobTop, 'Lantern of Insight shows bob’s top card').toHaveText('Lightning Bolt', { timeout: 30_000 });

      const jace = await page
        .locator('[data-zone="battlefield"][data-owner="you"] [data-board-card]')
        .filter({ has: page.locator('.card__name', { hasText: 'Jace, the Mind Sculptor' }) })
        .first()
        .getAttribute('data-board-card');
      expect(await clickPermanent(page, Number(jace)), 'Jace is offered').toBe(true);
      const plusTwo = page.locator('section[data-prompt="getAbilityToPlay"] [data-testid="prompt-choice"]').filter({ hasText: /top card of target player/i });
      const bobFace = page.locator('[data-player-face]:not([data-viewer])');
      await expect
        .poll(
          async () => {
            const method = await promptMethod(page);
            if (method === 'order') return 'order';
            if ((await plusTwo.count()) > 0) await plusTwo.first().click({ timeout: 1_000 }).catch(() => undefined);
            else if (await pressOffered(bobFace)) return 'targeted';
            else if (method !== null) await answerPrompt(page).catch(() => undefined);
            for (const p of [page, bob.page]) if ((await stackCount(p)) > 0 && (await enabledOk(p).count()) > 0) await enabledOk(p).first().click({ timeout: 1_000 }).catch(() => undefined);
            return method ?? 'none';
          },
          { timeout: 60_000, intervals: [250], message: 'the fateseal opens as one order of Top | Bottom' },
        )
        .toBe('order');

      const prompt = livePrompt(page);
      const top = page.getByTestId('zone-source');
      const bottom = page.getByTestId('zone-dest');
      console.log(`[pz] fateseal title ${JSON.stringify(await prompt.locator('.prompt__title').textContent())} headings ${JSON.stringify(await headings(page))} top ${JSON.stringify(await namesIn(top))}`);
      await expect(prompt.locator('.prompt__title'), 'the sheet is bob’s library').toHaveText(/^Bob.*'s library$/);
      expect(await headings(page), 'two zones, Top and Bottom').toEqual(['Top', 'Bottom']);
      await expect(prompt, 'no “select a card to put on bottom” sentence').not.toContainText(/choose|select/i);
      expect(await namesIn(top), 'the looked-at card starts on top').toEqual(['Lightning Bolt']);
      await expect(page.getByTestId('prompt-submit'), 'keeping it on top is an answer').toBeEnabled();
      await shoot(page, 'fateseal');

      const [bolt] = (await idsIn(top)) as [number];
      await drag(page, 'fateseal: top → bottom', prompt.locator(`li[data-card-id="${bolt}"]`), bottom);
      await expect.poll(() => idsIn(bottom), { message: 'the card is in Bottom' }).toEqual([bolt]);
      const boxes = await zoneBoxes(page);
      console.log(`[pz] fateseal zones ${JSON.stringify(boxes)} sideways ${JSON.stringify(await sidewaysScroll(page))}`);
      expect(boxes.find((b) => b.zone === 'top')!.h, 'the emptied Top zone is still drawn').toBeGreaterThan(40);
      expect(await sidewaysScroll(page), 'nothing in the sheet scrolls sideways').toEqual([]);
      await shoot(page, 'fateseal-bottom');

      await page.getByTestId('prompt-submit').click();
      await expect(bobTop, 'Lightning Bolt went under bob’s library: Shock is his top card').toHaveText('Shock', { timeout: 20_000 });
      expect(await promptMethod(page), 'one prompt was the whole fateseal').not.toBe('order');
    } finally {
      await stack.stop();
    }
  },
);

test(
  titled('Preordain’s Scry 2 is Top | Bottom: a card dragged above the other and the other dragged to Bottom, and Preordain draws the one on top'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioMatch(browser, stack, 'pz-scry');
      const page = alice.page;
      await resizeWindow(page, SIZE);
      await expect.poll(() => offered(page), { timeout: 30_000, message: 'alice is offered Preordain' }).not.toEqual([]);
      await castCard(page, (await offered(page))[0]!);
      await expect.poll(() => promptMethod(page), { timeout: 20_000, message: 'the scry opened' }).toBe('order');

      const prompt = livePrompt(page);
      const top = page.getByTestId('zone-source');
      const bottom = page.getByTestId('zone-dest');
      await expect(prompt.locator('.prompt__title')).toHaveText('Your library');
      expect(await headings(page)).toEqual(['Top', 'Bottom']);
      expect(await namesIn(top), 'Scry 2: both on top, in library order').toEqual(['Plains', 'Forest']);
      expect(await zoneBoxes(page).then((b) => b.find((z) => z.zone === 'bottom')!.h), 'the empty Bottom zone is drawn at its own size').toBeGreaterThan(40);
      await shoot(page, 'scry2');

      const [plains, forest] = (await idsIn(top)) as [number, number];
      const card = (id: number): Locator => prompt.locator(`li[data-card-id="${id}"]`);
      await drag(page, 'scry: Forest above Plains', card(forest), card(plains), 'before');
      await expect.poll(() => namesIn(top), { message: 'Forest is now the top card' }).toEqual(['Forest', 'Plains']);
      await drag(page, 'scry: Plains to the bottom', card(plains), bottom);
      await expect.poll(() => namesIn(bottom)).toEqual(['Plains']);
      expect(await sidewaysScroll(page), 'nothing in the sheet scrolls sideways').toEqual([]);
      await shoot(page, 'scry2-split');

      const before = await handNames(page);
      await page.getByTestId('prompt-submit').click();
      await expect.poll(async () => (await handNames(page)).length, { timeout: 20_000, message: 'Preordain draws' }).toBe(before.length + 1);
      const after = await handNames(page);
      console.log(`[pz] scry hand ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
      expect(after, 'Preordain drew Forest, the card dragged to the top').toContain('Forest');
      expect(after, 'not Plains, dragged to the bottom').not.toContain('Plains');
    } finally {
      await stack.stop();
    }
  },
);

test(
  titled('Notion Rain’s Surveil 2 is Top | Graveyard: the card dragged into the graveyard lands there, and the draw takes the other'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioMatch(browser, stack, 'pz-surveil');
      const page = alice.page;
      await resizeWindow(page, SIZE);
      await expect.poll(() => offered(page), { timeout: 30_000, message: 'alice is offered Notion Rain' }).not.toEqual([]);
      await castCard(page, (await offered(page))[0]!);
      await expect.poll(() => promptMethod(page), { timeout: 30_000, message: 'the surveil opened' }).toBe('order');

      const prompt = livePrompt(page);
      const top = page.getByTestId('zone-source');
      const graveyard = page.getByTestId('zone-dest');
      expect(await headings(page)).toEqual(['Top', 'Graveyard']);
      await expect(graveyard).toHaveAttribute('data-zone', 'graveyard');
      expect(await namesIn(top)).toEqual(['Plains', 'Forest']);
      await shoot(page, 'surveil');

      const [plains] = (await idsIn(top)) as [number, number];
      await drag(page, 'surveil: Plains into the graveyard', prompt.locator(`li[data-card-id="${plains}"]`), graveyard);
      await expect.poll(() => namesIn(graveyard)).toEqual(['Plains']);
      expect(await sidewaysScroll(page), 'nothing in the sheet scrolls sideways').toEqual([]);
      await shoot(page, 'surveil-split');

      await page.getByTestId('prompt-submit').click();
      const own = page.locator('[data-zone="graveyard"][data-owner="you"]');
      await expect.poll(() => own.getAttribute('data-count'), { timeout: 20_000, message: 'one card was surveilled into the graveyard (Notion Rain follows it)' }).not.toBe('0');
      await expect.poll(async () => (await handNames(page)).includes('Forest'), { timeout: 20_000, message: 'the draw took Forest, kept on top' }).toBe(true);
      expect(await handNames(page), 'not Plains').not.toContain('Plains');
    } finally {
      await stack.stop();
    }
  },
);

test(
  titled('Ponder is one zone, Top, every card in it from the start; drags with the page scrolled keep the phantom under the pointer, and Ponder draws the card dragged on top'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioMatch(browser, stack, 'order-drag-ponder');
      const page = alice.page;
      await resizeWindow(page, SIZE);
      await expect.poll(() => offered(page), { timeout: 30_000, message: 'alice is offered Ponder' }).not.toEqual([]);
      await castCard(page, (await offered(page))[0]!);
      await expect.poll(() => promptMethod(page), { timeout: 20_000, message: 'Ponder’s order opened' }).toBe('order');

      const prompt = livePrompt(page);
      const zone = page.getByTestId('zone-dest');
      await expect(page.getByTestId('zone-source'), 'one zone: nothing to empty, nothing to vanish').toHaveCount(0);
      expect(await headings(page)).toEqual(['Top']);
      expect(await namesIn(zone), 'every card in the zone from the start, top first').toEqual(['Plains', 'Forest', 'Swamp']);
      await expect(page.getByTestId('prompt-submit'), 'Forge’s order is an answer as it stands').toBeEnabled();
      expect(await sidewaysScroll(page), 'nothing in the sheet scrolls sideways').toEqual([]);
      await shoot(page, 'ponder');

      // The page scrolled under the prompt: the phantom is fixed, and must still sit under the pointer.
      const scrolled = await page.evaluate(() => {
        document.body.style.minHeight = '200vh';
        window.scrollTo(0, 120);
        return window.scrollY;
      });
      console.log(`[pz] ponder page scrolled to ${scrolled}`);
      expect(scrolled, 'the page is scrolled for the drag').toBeGreaterThan(0);
      const [plains, forest, swamp] = (await idsIn(zone)) as [number, number, number];
      const card = (id: number): Locator => prompt.locator(`li[data-card-id="${id}"]`);
      await drag(page, 'ponder: Swamp to the top, page scrolled', card(swamp), card(plains), 'before');
      await expect.poll(() => idsIn(zone)).toEqual([swamp, plains, forest]);
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        document.body.style.minHeight = '';
      });

      const before = await handNames(page);
      await page.getByTestId('prompt-submit').click();
      await expect.poll(() => confirmOpen(page), { timeout: 15_000, message: 'Ponder asks whether to shuffle' }).toBe(true);
      await answerConfirm(page, 'no');
      await expect.poll(async () => (await handNames(page)).length, { timeout: 15_000, message: 'Ponder draws' }).toBe(before.length + 1);
      expect(await handNames(page), 'Ponder drew Swamp, dragged to the top').toContain('Swamp');
    } finally {
      await stack.stop();
    }
  },
);
