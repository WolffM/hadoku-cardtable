/*
 * The operator, 2026-10-11 (match m-131c6008692a, Izzet Control): "clue wasn't clickable until
 * after i tapped lands. clue should be activatable there because i clearly did have 2 mana."
 *
 * Scenario `w70-clue`: alice holds a Clue token and four untapped lands of that deck (Shivan Reef,
 * Wandering Fumarole, Mountain, Drownyard Temple), with a Smoldering Marsh and the deck's spells in
 * hand. Her own mouse plays the Marsh, as she did that turn, and clicks the Clue with no mana
 * floating: it is offered before and after the land, and the click draws a card on both screens.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, handCardNamed, makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const OWN_BATTLEFIELD = '.seat[data-viewer] [data-zone="battlefield"]';
const THEIR_BATTLEFIELD = '[data-zone="battlefield"][data-owner="them"]';
const HAND = '[data-zone="hand"][data-owner="you"]';

const card = (page: Page, id: number) => page.locator(`[data-board-card="${id}"]`);
const isOffered = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-selectable')).catch(() => false);
const handSize = (page: Page) => page.locator(`${HAND} [data-board-card]`).count();

async function clueIn(page: Page, zone: string): Promise<number | undefined> {
  const ids = await page
    .locator(`${zone} [data-board-card]`)
    .evaluateAll((els) => els.filter((e) => /^Clue/.test(e.querySelector('.card__name')?.textContent?.trim() ?? '')).map((e) => Number(e.getAttribute('data-board-card'))));
  return ids[0];
}

test(titled('a Clue beside four untapped lands is offered, before and after a land play, and a click on it draws a card'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w70-clue');
    const a = alice.page;
    await expect.poll(() => clueIn(a, OWN_BATTLEFIELD), { timeout: 45_000, message: 'alice controls the Clue' }).not.toBeUndefined();
    const clue = (await clueIn(a, OWN_BATTLEFIELD))!;
    await expect.poll(() => isOffered(a, clue), { timeout: 30_000, message: 'the Clue is offered at priority, no mana floating' }).toBe(true);
    console.log('[w70-clue] before the land: clue offered');

    const marsh = await handCardNamed(a, 'Smoldering Marsh');
    expect(marsh, 'the Marsh is in hand').not.toBeUndefined();
    expect(await clickHandCard(a, marsh!, { row: 'back' }), 'the Marsh is played').toBe(true);
    await expect.poll(() => card(a, marsh!).evaluate((e) => e.closest('[data-zone="battlefield"]') !== null).catch(() => false), { timeout: 20_000, message: 'the Marsh on the battlefield' }).toBe(true);
    await expect.poll(() => isOffered(a, clue), { timeout: 20_000, message: 'the Clue is offered after the land play' }).toBe(true);
    console.log('[w70-clue] after the land: clue offered');

    const before = await handSize(a);
    const box = (await card(a, clue).boundingBox())!;
    await a.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => clueIn(a, OWN_BATTLEFIELD), { timeout: 20_000, message: 'alice: the Clue is sacrificed' }).toBeUndefined();
    await expect.poll(() => handSize(a), { timeout: 20_000, message: 'alice draws a card' }).toBe(before + 1);
    await expect.poll(() => clueIn(bob.page, THEIR_BATTLEFIELD), { timeout: 20_000, message: 'bob: the Clue is gone' }).toBeUndefined();
    console.log(`[w70-clue] clicked: clue gone, hand ${before} -> ${await handSize(a)}`);
  } finally {
    await stack.stop();
  }
});
