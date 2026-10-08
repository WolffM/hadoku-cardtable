/*
 * A painland taps and UNTAPS by a click, like an Island (ledger AC7).
 *
 * The operator, 2026-10-08: *"i just tapped yavimaya coast and now i can't
 * untap it."* Its coloured ability deals 1 damage to its controller as a
 * sub-ability, which Forge counted as "not undoable". The fork undoes a fixed
 * self-damage sub-ability with the mana, giving the life back (WolffM/forge
 * `cardtable/w58-undo` `702b207e`); this spec proves it through the table's
 * own clicks against real Forge.
 */
import { expect, test, type Page } from '@playwright/test';
import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const card = (page: Page, id: number) => page.locator(`[data-board-card="${id}"]`);
const isTapped = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-tapped'));
const isOffered = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-selectable'));
const poolTotal = (page: Page) =>
  page.locator('.seat[data-viewer] [data-mana-pool]').evaluate((el) => Number(el.getAttribute('data-mana-total') ?? '0'));
const life = (page: Page) =>
  page.locator('.seat[data-viewer] [data-testid="life"]').first().evaluate((el) => Number((el.textContent ?? '').replace(/\D/g, '')));

async function ownNamed(page: Page, name: string): Promise<number> {
  const ids = await page
    .locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]')
    .evaluateAll((els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))), name);
  if (ids[0] === undefined) throw new Error(`no ${name} on the battlefield`);
  return ids[0];
}

/**
 * Answer whatever choice pop-up is open: the option matching `prefer` if one
 * is, else the first; then its submit, if it has one.
 *
 * Matched by `aria-label`, not the button's own rendered text: an ability's
 * mana and tap symbols draw as the Mana font's glyphs now (wave 60 §M, AD6 /
 * Z10 / Y23), so a letter like "G" or "R" is no longer anywhere `hasText`
 * could find it — the plain words (`aria-label`) are the only text an
 * option carries that Forge's own `{G}`/`{T}` tokens still read as.
 */
async function answerChoice(page: Page, prefer: RegExp): Promise<boolean> {
  const prompt = page.getByTestId('live-prompt');
  const options = prompt.locator('[data-testid="prompt-choice"]');
  if (!(await options.first().isVisible({ timeout: 1_500 }).catch(() => false))) return false;
  const labels = await options.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''));
  const index = labels.findIndex((label) => prefer.test(label));
  await (index >= 0 ? options.nth(index) : options.first()).click();
  const submit = prompt.getByTestId('prompt-submit');
  if (await submit.isVisible({ timeout: 500 }).catch(() => false)) await submit.click();
  return true;
}

test(titled('AC7 — Yavimaya Coast: tap for a colour by a click (1 damage), untap by another — the mana and the life both come back'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'yavimaya-coast');
    const coast = await ownNamed(alice.page, 'Yavimaya Coast');
    await expect.poll(() => isOffered(alice.page, coast), { timeout: 45_000, message: 'the Coast is offered at priority' }).toBe(true);
    const lifeBefore = await life(alice.page);
    // A click offers its two abilities; the coloured one is the one with the damage. Then the colour.
    for (let i = 0; i < 10 && !(await isTapped(alice.page, coast)); i++) {
      await card(alice.page, coast).locator('button').first().click();
      await answerChoice(alice.page, /\{G\}|\{U\}|damage/i);
      await expect.poll(() => isTapped(alice.page, coast), { timeout: 2_000 }).toBe(true).catch(() => undefined);
    }
    expect(await isTapped(alice.page, coast), 'the Coast tapped').toBe(true);
    // Forge taps the land as the cost FIRST, then asks the colour in its own dialog ("Green" / "Blue").
    const colour = alice.page.getByRole('dialog').getByRole('button', { name: /green|blue/i }).first();
    await expect(colour, 'the colour question').toBeVisible({ timeout: 15_000 });
    await colour.click();
    await expect.poll(() => poolTotal(alice.page), { timeout: 10_000, message: 'a coloured mana floats' }).toBe(1);
    await expect.poll(() => life(alice.page), { timeout: 10_000, message: 'and it cost 1 life' }).toBe(lifeBefore - 1);

    await card(alice.page, coast).locator('button').first().click();
    await expect.poll(() => isTapped(alice.page, coast), { timeout: 10_000, message: 'a click on the tapped Coast untapped it (Undo)' }).toBe(false);
    await expect.poll(() => poolTotal(alice.page), { timeout: 10_000, message: 'Undo emptied the pool' }).toBe(0);
    await expect.poll(() => life(alice.page), { timeout: 10_000, message: 'and gave the life back' }).toBe(lifeBefore);
    await expect.poll(() => isOffered(alice.page, coast), { timeout: 10_000, message: 'the Coast is offered again' }).toBe(true);
  } finally {
    await stack.stop();
  }
});
