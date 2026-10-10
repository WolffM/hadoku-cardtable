/*
 * A spell that only a Signet's mana makes payable is offered as playable — and
 * Urza's Mine on its own untaps on a click.
 *
 * The operator, 2026-10-10: "through the breach wasn't showing as playable
 * because … it required tapping izzet signet … is it too hard to calculate that
 * tapping the signets creates mana?" Forge's priority-time affordability check
 * (`AvailableActions.canAfford` → `ComputerUtilMana.canPayManaCost`) counts only
 * mana abilities without a mana cost (`ComputerUtilMana.getAIPlayableMana`), so a
 * Signet ({1},{T}: add two) never counted.
 *
 * Scenario `w68-breach`: three Mountains, Urza's Mine and Izzet Signet; Through
 * the Breach ({4}{R}) in hand. Four lands make four; with the Signet, five.
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

async function named(page: Page, zone: string, name: string): Promise<number | undefined> {
  const ids = await page
    .locator(`${zone} [data-board-card]`)
    .evaluateAll((els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))), name);
  return ids[0];
}

const HAND = '[data-zone="hand"][data-owner="you"]';
const BATTLEFIELD = '.seat[data-viewer] [data-zone="battlefield"]';

test(titled('Through the Breach is offered when only Izzet Signet’s mana makes it payable; Urza’s Mine alone untaps on a click'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w68-breach');
    const a = alice.page;
    await expect.poll(() => named(a, HAND, 'Through the Breach'), { timeout: 45_000, message: 'alice holds Through the Breach' }).not.toBeUndefined();
    const breach = (await named(a, HAND, 'Through the Breach'))!;
    const mine = (await named(a, BATTLEFIELD, "Urza's Mine"))!;
    await expect.poll(() => isOffered(a, mine), { timeout: 45_000, message: 'alice has priority (her Mine is offered)' }).toBe(true);

    const offered = await expect.poll(() => isOffered(a, breach), { timeout: 10_000 }).toBe(true).then(() => true, () => false);
    console.log(`[w68-breach] Through the Breach with 4 lands + Izzet Signet: ${offered ? 'offered' : 'NOT offered'}`);
    expect.soft(offered, 'Through the Breach is offered: the Signet turns one land’s mana into two').toBe(true);

    // Urza's Mine alone ({C}, its amount a variable): tap it, click it.
    for (let i = 0; i < 10 && !(await isTapped(a, mine)); i++) {
      await card(a, mine).locator('button').first().click();
      await expect.poll(() => isTapped(a, mine), { timeout: 1_000 }).toBe(true).catch(() => undefined);
    }
    expect(await isTapped(a, mine), 'the Mine tapped on a click').toBe(true);
    await expect.poll(() => poolTotal(a), { timeout: 10_000, message: 'the Mine added {C}' }).toBe(1);
    await card(a, mine).locator('button').first().click();
    const back = await expect.poll(() => isTapped(a, mine), { timeout: 8_000 }).toBe(false).then(() => true, () => false);
    console.log(`[w68-breach] Urza's Mine alone, tapped then clicked: ${back ? 'untapped' : 'STILL TAPPED'}, pool ${await poolTotal(a)}`);
    expect.soft(back, 'a click on the tapped Mine untapped it').toBe(true);
    if (back) {
      await expect.poll(() => poolTotal(a), { timeout: 10_000, message: 'the untap took the {C} back' }).toBe(0);
      await expect.poll(() => isTapped(bob.page, mine), { timeout: 10_000, message: 'bob sees the Mine untapped' }).toBe(false);
    }
  } finally {
    await stack.stop();
  }
});
