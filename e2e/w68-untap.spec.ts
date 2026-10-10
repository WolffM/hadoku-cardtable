/*
 * Any mana source tapped for mana untaps on a click while its mana is unspent
 * and the tap triggered nothing — every kind of source, in any order, on both
 * screens.
 *
 * The operator, 2026-10-10, after five earlier fixes that each covered one
 * kind of source (basics V6, River of Tears AC7, painlands, Llanowar Elves
 * AE21): "tapped urza's mine and can't untap it. nothing was done with the
 * mana, nothing was triggered." And: "just let me untap things if it didn't
 * trigger anything." This spec is the table over every kind of source, so the
 * next kind is caught here rather than in a match.
 *
 * Scenario `w68-untap`: alice's turn-1 Main 1 with Forest, Island, the Tron
 * set, River of Tears, Izzet Signet, Llanowar Elves and Adarkar Wastes, and an
 * empty hand. For each source: tap it by a click and click it again (it was
 * tapped last); then tap it, tap a basic after it, and click the FIRST (out of
 * order). Every row ends with the pool and the board as they were before it.
 * Rows are soft so one run reports every kind that fails, with a tagged line
 * per row.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const SOURCES = ['Forest', "Urza's Mine", "Urza's Tower", "Urza's Power Plant", 'River of Tears', 'Izzet Signet', 'Llanowar Elves', 'Adarkar Wastes'];

const card = (page: Page, id: number) => page.locator(`[data-board-card="${id}"]`);
const isTapped = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-tapped'));
const poolTotal = (page: Page) =>
  page.locator('.seat[data-viewer] [data-mana-pool]').evaluate((el) => Number(el.getAttribute('data-mana-total') ?? '0'));

/** The viewer's own battlefield, id → name and tapped. */
function ownBoard(page: Page): Promise<{ id: number; name: string; tapped: boolean }[]> {
  return page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]').evaluateAll((els) =>
    els.map((e) => ({
      id: Number(e.getAttribute('data-board-card')),
      name: e.querySelector('.card__name')?.textContent?.trim() ?? '',
      tapped: e.hasAttribute('data-tapped'),
    })),
  );
}

const tappedIds = async (page: Page): Promise<number[]> => (await ownBoard(page)).filter((c) => c.tapped).map((c) => c.id).sort((a, b) => a - b);

/**
 * Whatever Forge asks after the click: which ability (the painland's two — the
 * coloured one, with the damage), then which colour.
 */
async function answerAsks(page: Page): Promise<void> {
  const prompt = page.getByTestId('live-prompt');
  const options = prompt.locator('[data-testid="prompt-choice"]');
  if (await options.first().isVisible({ timeout: 500 }).catch(() => false)) {
    const labels = await options.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''));
    const index = labels.findIndex((label) => /damage/i.test(label));
    await (index >= 0 ? options.nth(index) : options.first()).click();
    const submit = prompt.getByTestId('prompt-submit');
    if (await submit.isVisible({ timeout: 300 }).catch(() => false)) await submit.click();
  }
  const colour = page.getByRole('dialog').getByRole('button', { name: /white|blue/i }).first();
  if (await colour.isVisible({ timeout: 500 }).catch(() => false)) await colour.click();
}

/**
 * Tap `id` by a click. The first click after a scenario applies can be dropped
 * (the scenario-start race), so it is repeated a second apart while the card is
 * still untapped — never once it has tapped. Resolves once nothing is asking.
 */
async function tapByClick(page: Page, id: number, what: string): Promise<void> {
  for (let i = 0; i < 10 && !(await isTapped(page, id)); i++) {
    await card(page, id).locator('button').first().click();
    await answerAsks(page);
    await expect.poll(() => isTapped(page, id), { timeout: 1_000 }).toBe(true).catch(() => undefined);
  }
  expect(await isTapped(page, id), `${what} tapped on a click`).toBe(true);
  await answerAsks(page);
  await expect(page.getByTestId('live-prompt'), `nothing is left asking after ${what} tapped`).toHaveCount(0, { timeout: 10_000 });
}

/** Click a tapped `id` once; true when it untaps on alice's screen and on bob's. */
async function untapByClick(alice: Page, bob: Page, id: number): Promise<boolean> {
  await card(alice, id).locator('button').first().click();
  const mine = await expect.poll(() => isTapped(alice, id), { timeout: 8_000 }).toBe(false).then(() => true, () => false);
  if (!mine) return false;
  return expect.poll(() => isTapped(bob, id), { timeout: 8_000 }).toBe(false).then(() => true, () => false);
}

/** Undo whatever a failed row left tapped, by the same clicks, so the next row starts from the same board. */
async function settle(alice: Page, bob: Page, before: ReadonlySet<number>): Promise<void> {
  for (const id of (await tappedIds(alice)).reverse()) if (!before.has(id)) await untapByClick(alice, bob, id);
}

test(titled('every mana source tapped for mana untaps on a click while its mana is unspent — last-tapped and out of order, on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(8 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w68-untap');
    const a = alice.page;
    const b = bob.page;
    await expect.poll(async () => (await ownBoard(a)).length, { timeout: 45_000, message: 'alice’s scripted board is drawn' }).toBe(9);
    const board = await ownBoard(a);
    const idOf = (name: string): number => {
      const found = board.find((c) => c.name === name);
      if (found === undefined) throw new Error(`no ${name} on alice’s battlefield`);
      return found.id;
    };
    await expect.poll(() => card(a, idOf('Forest')).evaluate((e) => e.hasAttribute('data-selectable')), { timeout: 45_000, message: 'alice has priority' }).toBe(true);

    const results: string[] = [];
    const row = (what: string, ok: boolean, detail: string): void => {
      const line = `[w68-untap] ${ok ? 'ok  ' : 'FAIL'} ${what}: ${detail}`;
      console.log(line);
      results.push(line);
      expect.soft(ok, line).toBe(true);
    };

    for (const name of SOURCES) {
      const id = idOf(name);
      // What an earlier failed row left behind (its mana floats, its source stays tapped) is the baseline.
      let base = { pool: await poolTotal(a), tapped: new Set(await tappedIds(a)) };
      const fresh = async (): Promise<number[]> => (await tappedIds(a)).filter((t) => !base.tapped.has(t));

      // Last-tapped: tap it, click it.
      await tapByClick(a, id, name);
      const paid = (await fresh()).filter((t) => t !== id);
      const floating = (await poolTotal(a)) - base.pool;
      const back = await untapByClick(a, b, id);
      const after = { pool: (await poolTotal(a)) - base.pool, tapped: await fresh() };
      row(`${name} last-tapped`, back && after.pool === 0 && after.tapped.length === 0,
        `tapped (+${floating} mana${paid.length > 0 ? `, paid by #${paid.join(',#')}` : ''}), click → ${back ? 'untapped' : 'STILL TAPPED'}, pool +${after.pool}, still tapped [${after.tapped.join(',')}]`);
      await settle(a, b, base.tapped);
      base = { pool: await poolTotal(a), tapped: new Set(await tappedIds(a)) };

      // Out of order: tap it, tap a basic after it, click the first.
      if (await isTapped(a, id)) {
        row(`${name} out-of-order`, false, 'not tried: still tapped from the last-tapped row');
        continue;
      }
      const basic = idOf(name === 'Island' || name === 'Forest' ? 'Island' : 'Forest');
      await tapByClick(a, id, name);
      const signetPayer = (await fresh()).filter((t) => t !== id);
      const before = (await poolTotal(a)) - base.pool;
      const usable = !signetPayer.includes(basic);
      const control = usable ? basic : idOf('Island');
      await tapByClick(a, control, 'the basic tapped after it');
      const backOut = await untapByClick(a, b, id);
      const controlStays = await isTapped(a, control);
      const poolOut = (await poolTotal(a)) - base.pool;
      const controlBack = await untapByClick(a, b, control);
      const end = { pool: (await poolTotal(a)) - base.pool, tapped: await fresh() };
      row(`${name} out-of-order`, backOut && controlStays && controlBack && end.pool === 0 && end.tapped.length === 0,
        `tapped (+${before}), then #${control}; click on ${name} → ${backOut ? 'untapped' : 'STILL TAPPED'} with #${control} ${controlStays ? 'still tapped' : 'UNTAPPED TOO'}, pool +${poolOut}; then #${control} → ${controlBack ? 'untapped' : 'STILL TAPPED'}; end pool +${end.pool}, still tapped [${end.tapped.join(',')}]`);
      await settle(a, b, base.tapped);
    }
    console.log(`[w68-untap] summary: ${results.filter((l) => l.includes(' ok ')).length}/${results.length} rows ok`);
  } finally {
    await stack.stop();
  }
});
