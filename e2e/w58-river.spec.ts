/*
 * A non-basic land taps and UNTAPS by a click, like a Swamp (ledger AB8).
 *
 * The operator, 2026-10-08: *"when non-basic lands are tapped they are not able
 * to be untapped."* River of Tears' ability is a Mana ability with a Mana
 * sub-ability ("add {B} instead"), and Forge marked every ability with a
 * sub-ability not undoable, so the click that undoes a Swamp's tap did
 * nothing on the River. The fork makes a mana-only chain undoable and refunds
 * every part's mana (WolffM/forge `cardtable/w58-undo`); this spec proves both
 * branches against real Forge, through the same click the table uses.
 */
import { expect, test, type Page } from '@playwright/test';
import { clickHandCard, makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const card = (page: Page, id: number) => page.locator(`[data-board-card="${id}"]`);
const isTapped = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-tapped'));
const isOffered = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-selectable'));
const pool = (page: Page) =>
  page.locator('.seat[data-viewer] [data-mana-pool]').evaluate((el) => ({
    total: Number(el.getAttribute('data-mana-total') ?? '0'),
    U: Number(el.querySelector('[data-mana="U"]')?.getAttribute('data-mana-count') ?? '0'),
    B: Number(el.querySelector('[data-mana="B"]')?.getAttribute('data-mana-count') ?? '0'),
  }));

/** The hand card named `name`, Forge-offered or not — by its own `.card__name` text. */
async function handCardNamed(page: Page, name: string): Promise<number | undefined> {
  const cards = await page
    .locator('[data-zone="hand"][data-owner="you"] [data-board-card]')
    .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
  return cards.find((c) => c.name === name)?.id;
}

/** The viewer's own battlefield card named `name`. */
async function ownNamed(page: Page, name: string): Promise<number> {
  const ids = await page
    .locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]')
    .evaluateAll((els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))), name);
  if (ids[0] === undefined) throw new Error(`no ${name} on the battlefield`);
  return ids[0];
}

/** A click on an offered permanent until it taps: the first click after a scenario applies can be dropped (`PlayBridge.java`'s `refreshActionable`). */
async function tapByClick(page: Page, id: number, what: string): Promise<void> {
  await expect.poll(() => isOffered(page, id), { timeout: 45_000, message: `${what} is offered at priority` }).toBe(true);
  for (let i = 0; i < 10 && !(await isTapped(page, id)); i++) {
    await card(page, id).locator('button').first().click();
    await expect.poll(() => isTapped(page, id), { timeout: 1_000 }).toBe(true).catch(() => undefined);
  }
  expect(await isTapped(page, id), `${what} tapped on a click`).toBe(true);
}

/** River → tapped, `colour` floats → a click on it again → untapped, the pool empty, offered again. */
async function tapUndo(page: Page, river: number, colour: 'U' | 'B'): Promise<void> {
  await tapByClick(page, river, 'River of Tears');
  await expect.poll(async () => (await pool(page))[colour], { timeout: 10_000, message: `the River added {${colour}}` }).toBe(1);
  await card(page, river).locator('button').first().click();
  await expect.poll(() => isTapped(page, river), { timeout: 10_000, message: 'a click on the tapped River untapped it (Undo)' }).toBe(false);
  await expect.poll(async () => (await pool(page)).total, { timeout: 10_000, message: 'Undo emptied the pool: nothing left floating' }).toBe(0);
  await expect.poll(() => isOffered(page, river), { timeout: 10_000, message: 'the River is offered again after Undo' }).toBe(true);
}

test(titled('AB8 — River of Tears, no land played: tap for {U} by a click, untap by another'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'river-of-tears');
    const river = await ownNamed(alice.page, 'River of Tears');
    await tapUndo(alice.page, river, 'U');
  } finally {
    await stack.stop();
  }
});

test(titled('AB8 — River of Tears after a land drop: tap for {B} (the sub-ability) by a click, untap by another with no {B} left floating'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'river-of-tears');
    const river = await ownNamed(alice.page, 'River of Tears');
    await expect.poll(() => handCardNamed(alice.page, 'Island'), { timeout: 20_000, message: 'alice holds the Island' }).not.toBeUndefined();
    const island = (await handCardNamed(alice.page, 'Island'))!;
    await clickHandCard(alice.page, island);
    await expect.poll(() => ownNamed(alice.page, 'Island').catch(() => null), { timeout: 20_000, message: 'the Island is played' }).not.toBeNull();
    await tapUndo(alice.page, river, 'B');
  } finally {
    await stack.stop();
  }
});
