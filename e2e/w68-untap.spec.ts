/*
 * Any mana source tapped for mana untaps on a click while its mana is unspent
 * and the tap triggered nothing — every kind of source, in any order, on both
 * screens.
 *
 * The operator, 2026-10-10, after five earlier fixes that each covered one
 * kind of source (basics V6, River of Tears AB8, painlands AC7, Llanowar Elves
 * AE21): "tapped urza's mine and can't untap it. nothing was done with the
 * mana, nothing was triggered." And: "just let me untap things if it didn't
 * trigger anything." This spec is the table over every kind of source, so the
 * next kind is caught here rather than in a match.
 *
 * Scenario `w68-untap`: alice's turn-1 Main 1 with Forest, Island, the Tron
 * set, River of Tears, Izzet Signet, Llanowar Elves and Adarkar Wastes, and
 * only an Island in hand. For each source: tap it by a click (bob sees it
 * tapped) and click it again (it was tapped last); then tap it, tap a basic
 * after it, and click the FIRST (out of order). Every row ends with the pool,
 * the life and the board as they were before it, and the source offered
 * again. The painland's tap costs 1 life and its untap gives it back (AC7).
 * Last, alice plays the Island and the River row runs again: River's {B}
 * sub-ability, which Forge once refused to undo (AB8). Rows are soft so one
 * run reports every kind that fails, with a tagged line per row.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, clickPermanent, clickRecords, handCardNamed, isOffered, isTapped, makeTitled, manaPool } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

type Colour = 'U' | 'B';
/** Each source, with what its tap must cost in life and, where it is fixed, the colour it adds. */
const SOURCES: { name: string; life?: number; adds?: Colour }[] = [
  { name: 'Forest' },
  { name: "Urza's Mine" },
  { name: "Urza's Tower" },
  { name: "Urza's Power Plant" },
  { name: 'River of Tears', adds: 'U' },
  { name: 'Izzet Signet' },
  { name: 'Llanowar Elves' },
  { name: 'Adarkar Wastes', life: 1 },
];

const life = (page: Page) =>
  page.locator('.seat[data-viewer] [data-testid="life"]').first().evaluate((el) => Number((el.textContent ?? '').replace(/\D/g, '')));

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

    /** Tap `id` by one click; resolves once it is tapped on both screens and nothing is asking. */
    const tapByClick = async (id: number, what: string): Promise<void> => {
      expect(await clickPermanent(a, id), `${what} is offered in a live window`).toBe(true);
      await answerAsks(a);
      await expect.poll(() => isTapped(a, id), { timeout: 10_000, message: `${what} tapped on one click — the server's clicks on it: ${clickRecords(stack, id)}` }).toBe(true);
      await expect.poll(() => isTapped(b, id), { timeout: 10_000, message: `bob sees ${what} tapped` }).toBe(true);
      await answerAsks(a);
      await expect(a.getByTestId('live-prompt'), `nothing is left asking after ${what} tapped`).toHaveCount(0, { timeout: 10_000 });
    };

    /** Click a tapped `id` once; true when it untaps on alice's screen and on bob's. */
    const untapByClick = async (id: number): Promise<boolean> => {
      if (!(await clickPermanent(a, id, 8_000))) return false;
      const mine = await expect.poll(() => isTapped(a, id), { timeout: 8_000 }).toBe(false).then(() => true, () => false);
      if (!mine) return false;
      return expect.poll(() => isTapped(b, id), { timeout: 8_000 }).toBe(false).then(() => true, () => false);
    };

    /** Undo whatever a failed row left tapped, by the same clicks, so the next row starts from the same board. */
    const settle = async (before: ReadonlySet<number>): Promise<void> => {
      for (const id of (await tappedIds(a)).reverse()) if (!before.has(id)) await untapByClick(id);
    };

    const results: string[] = [];
    const row = (what: string, ok: boolean, detail: string): void => {
      const line = `[w68-untap] ${ok ? 'ok  ' : 'FAIL'} ${what}: ${detail}`;
      console.log(line);
      results.push(line);
      expect.soft(ok, line).toBe(true);
    };

    // What an earlier failed row left behind (its mana floats, its source stays tapped) is the baseline.
    const baseline = async () => ({ pool: (await manaPool(a)).total, life: await life(a), tapped: new Set(await tappedIds(a)) });

    /** Tap it, click it: it untaps with its mana and life given back, and is offered again. */
    const lastTapped = async (what: string, source: (typeof SOURCES)[number]): Promise<void> => {
      const id = idOf(source.name);
      const base = await baseline();
      const fresh = async (): Promise<number[]> => (await tappedIds(a)).filter((t) => !base.tapped.has(t));
      await tapByClick(id, source.name);
      const paid = (await fresh()).filter((t) => t !== id);
      const pool = await manaPool(a);
      const floating = pool.total - base.pool;
      const added = source.adds === undefined || pool[source.adds] === 1;
      const lifeCost = base.life - (await life(a));
      const back = await untapByClick(id);
      const offeredAgain = back && (await expect.poll(() => isOffered(a, id), { timeout: 10_000 }).toBe(true).then(() => true, () => false));
      const after = { pool: (await manaPool(a)).total - base.pool, life: (await life(a)) - base.life, tapped: await fresh() };
      row(
        what,
        added && lifeCost === (source.life ?? 0) && back && offeredAgain && after.pool === 0 && after.life === 0 && after.tapped.length === 0,
        `tapped (+${floating} mana${source.adds === undefined ? '' : ` {${source.adds}} ${added ? 'added' : 'NOT ADDED'}`}, ${lifeCost} life${paid.length > 0 ? `, paid by #${paid.join(',#')}` : ''}), click → ${back ? 'untapped' : 'STILL TAPPED'}${back ? (offeredAgain ? ', offered again' : ', NOT OFFERED AGAIN') : ''}, pool +${after.pool}, life ${after.life >= 0 ? '+' : ''}${after.life}, still tapped [${after.tapped.join(',')}]`,
      );
      await settle(base.tapped);
    };

    for (const source of SOURCES) {
      const { name } = source;
      const id = idOf(name);
      await lastTapped(`${name} last-tapped`, source);

      // Out of order: tap it, tap a basic after it, click the first.
      if (await isTapped(a, id)) {
        row(`${name} out-of-order`, false, 'not tried: still tapped from the last-tapped row');
        continue;
      }
      const base = await baseline();
      const fresh = async (): Promise<number[]> => (await tappedIds(a)).filter((t) => !base.tapped.has(t));
      const basic = idOf(name === 'Island' || name === 'Forest' ? 'Island' : 'Forest');
      await tapByClick(id, name);
      const signetPayer = (await fresh()).filter((t) => t !== id);
      const before = (await manaPool(a)).total - base.pool;
      const control = signetPayer.includes(basic) ? idOf('Island') : basic;
      await tapByClick(control, 'the basic tapped after it');
      const backOut = await untapByClick(id);
      const controlStays = await isTapped(a, control);
      const poolOut = (await manaPool(a)).total - base.pool;
      const controlBack = await untapByClick(control);
      const end = { pool: (await manaPool(a)).total - base.pool, life: (await life(a)) - base.life, tapped: await fresh() };
      row(
        `${name} out-of-order`,
        backOut && controlStays && controlBack && end.pool === 0 && end.life === 0 && end.tapped.length === 0,
        `tapped (+${before}), then #${control}; click on ${name} → ${backOut ? 'untapped' : 'STILL TAPPED'} with #${control} ${controlStays ? 'still tapped' : 'UNTAPPED TOO'}, pool +${poolOut}; then #${control} → ${controlBack ? 'untapped' : 'STILL TAPPED'}; end pool +${end.pool}, life ${end.life >= 0 ? '+' : ''}${end.life}, still tapped [${end.tapped.join(',')}]`,
      );
      await settle(base.tapped);
    }

    // River of Tears adds {B} instead once a land was played: its sub-ability undoes too.
    const island = await handCardNamed(a, 'Island');
    if (island === undefined) throw new Error('alice holds no Island to play');
    await clickHandCard(a, island);
    await expect.poll(async () => (await ownBoard(a)).length, { timeout: 20_000, message: 'the Island is played' }).toBe(10);
    await lastTapped('River of Tears after a land drop', { name: 'River of Tears', adds: 'B' });

    console.log(`[w68-untap] summary: ${results.filter((l) => l.includes(' ok ')).length}/${results.length} rows ok`);
  } finally {
    await stack.stop();
  }
});
