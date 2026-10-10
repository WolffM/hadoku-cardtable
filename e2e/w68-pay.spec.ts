/*
 * A Signet tapped while paying for a spell: the cast resolves, nothing stalls.
 *
 * Main's run 38025198400 (play.spec, Cunning Wish): alice, paying, clicked
 * Skycloud Expanse ({1},{T}: add {W}{U}). Forge opened the land's own {1} as a
 * payment inside the payment, on the thread that had taken her click; fork
 * 7ddd4daa ran a connection's acts one at a time, so the OK that inner payment
 * waited for queued behind that same thread, and the seat froze for good.
 *
 * Scenario `w68-pay`: two Islands, Izzet Signet, Divination ({2}{U}) in hand —
 * payable only through the Signet. Alice casts it by a click and, in the
 * payment window, clicks the Signet first, then whatever Forge still offers.
 * Divination must reach her graveyard, and bob must see it there.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const card = (page: Page, id: number) => page.locator(`[data-board-card="${id}"]`);
const isTapped = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-tapped'));
const isOffered = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-selectable')).catch(() => false);

async function named(page: Page, zone: string, name: string): Promise<number | undefined> {
  const ids = await page
    .locator(`${zone} [data-board-card]`)
    .evaluateAll((els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))), name);
  return ids[0];
}

const HAND = '[data-zone="hand"][data-owner="you"]';
const BATTLEFIELD = '.seat[data-viewer] [data-zone="battlefield"]';
const inGraveyard = (page: Page, owner: 'you' | 'them', id: number) =>
  page.locator(`[data-zone="graveyard"][data-owner="${owner}"] [data-board-card="${id}"]`).count().then((n) => n > 0);

test(titled('Izzet Signet tapped inside Divination’s payment: the cast resolves, nothing stalls'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w68-pay');
    const a = alice.page;
    await expect.poll(() => named(a, HAND, 'Divination'), { timeout: 45_000, message: 'alice holds Divination' }).not.toBeUndefined();
    const divination = (await named(a, HAND, 'Divination'))!;
    const signet = (await named(a, BATTLEFIELD, 'Izzet Signet'))!;
    await expect.poll(() => isOffered(a, divination), { timeout: 45_000, message: 'Divination is offered (only the Signet makes it payable)' }).toBe(true);

    const t0 = Date.now();
    for (let i = 0; i < 10 && (await named(a, HAND, 'Divination')) !== undefined; i++) {
      await clickHandCard(a, divination);
      await expect.poll(() => named(a, HAND, 'Divination'), { timeout: 2_000 }).toBeUndefined().catch(() => undefined);
    }
    expect(await named(a, HAND, 'Divination'), 'Divination left the hand on the click').toBeUndefined();

    // The payment window: the Signet first, then whatever Forge still offers — one click per offer.
    const clicked: string[] = [];
    const deadline = Date.now() + 30_000;
    while (!(await inGraveyard(a, 'you', divination)) && Date.now() < deadline) {
      if (!(await isTapped(a, signet)) && (await isOffered(a, signet))) {
        await card(a, signet).locator('button').first().click();
        clicked.push('Izzet Signet');
      } else {
        const islands = await a
          .locator(`${BATTLEFIELD} [data-board-card][data-selectable]:not([data-tapped])`)
          .evaluateAll((els) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === 'Island').map((e) => Number(e.getAttribute('data-board-card'))));
        if (islands[0] !== undefined) {
          await card(a, islands[0]).locator('button').first().click();
          clicked.push(`Island#${islands[0]}`);
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const resolved = await inGraveyard(a, 'you', divination);
    console.log(`[w68-pay] Divination ${resolved ? 'resolved' : 'NEVER resolved'} ${Date.now() - t0} ms after the click; alice clicked [${clicked.join(', ')}]; Signet ${(await isTapped(a, signet)) ? 'tapped' : 'untapped'}`);
    expect(clicked, 'the Signet was tapped inside the payment').toContain('Izzet Signet');
    expect(resolved, 'Divination resolved after the Signet paid inside its payment').toBe(true);
    await expect.poll(() => inGraveyard(bob.page, 'them', divination), { timeout: 10_000, message: 'bob sees Divination in alice’s graveyard' }).toBe(true);
  } finally {
    await stack.stop();
  }
});
