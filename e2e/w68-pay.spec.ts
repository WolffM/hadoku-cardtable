/*
 * A Signet tapped while paying for a spell: the cast resolves, nothing stalls.
 *
 * Main's run 38025198400 (play.spec, Cunning Wish): alice, paying, clicked
 * Skycloud Expanse ({1},{T}: add {W}{U}). Forge opened the land's own {1} as a
 * payment inside the payment, on the thread that had taken her click; fork
 * 7ddd4daa ran a connection's acts one at a time, so the OK that inner payment
 * waited for queued behind that same thread, and the seat froze for good.
 *
 * Scenario `by-hand-signets` (moved here from `w68-pay` on the 2026-11-08 Forge
 * upstream sync, `828e6f735`): one Island, Izzet Signet, Azorius Signet,
 * Divination ({2}{U}) in hand. Forge's Auto now chains one Signet
 * (`ComputerUtilMana.prepayFilterManaAbility`) but never pays a Signet with
 * another, so the old two-Islands-and-one-Signet board auto-pays on the new
 * pin and this by-hand path never opens; the new board still leaves it to the
 * player. Alice casts it by a click and, in the payment window, clicks
 * whichever Signet Forge still offers, then whatever else it offers (the
 * Island, or floating mana already in her pool) — one press per offer, same
 * as before. Divination must reach her graveyard, and bob must see it there.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, makeTitled, pressOffered } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const card = (page: Page, id: number) => page.locator(`[data-board-card="${id}"]`);
const isTapped = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-tapped'));
const isOffered = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-selectable')).catch(() => false);
const poolPip = (page: Page) => page.locator('.seat[data-viewer] [data-mana-pool] [data-pool-pay]').first();

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

test(titled('two Signets, one paying the other, inside Divination’s payment: the cast resolves, nothing stalls'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'by-hand-signets');
    const a = alice.page;
    await expect.poll(() => named(a, HAND, 'Divination'), { timeout: 45_000, message: 'alice holds Divination' }).not.toBeUndefined();
    const divination = (await named(a, HAND, 'Divination'))!;
    const izzetSignet = (await named(a, BATTLEFIELD, 'Izzet Signet'))!;
    const azoriusSignet = (await named(a, BATTLEFIELD, 'Azorius Signet'))!;
    await expect
      .poll(() => isOffered(a, divination), { timeout: 45_000, message: 'Divination is offered (only the two Signets, one paying the other, make it payable)' })
      .toBe(true);

    const t0 = Date.now();
    for (let i = 0; i < 10 && (await named(a, HAND, 'Divination')) !== undefined; i++) {
      await clickHandCard(a, divination);
      await expect.poll(() => named(a, HAND, 'Divination'), { timeout: 2_000 }).toBeUndefined().catch(() => undefined);
    }
    expect(await named(a, HAND, 'Divination'), 'Divination left the hand on the click').toBeUndefined();

    // The payment window: either Signet (whichever Forge still offers), then the Island that pays
    // whichever Signet's own {1} is open, then the floating mana the first Signet left in the pool
    // (the other Signet's own {1}) — one press per offer.
    const clicked: string[] = [];
    const deadline = Date.now() + 30_000;
    while (!(await inGraveyard(a, 'you', divination)) && Date.now() < deadline) {
      let pressed = false;
      for (const [name, id] of [
        ['Izzet Signet', izzetSignet],
        ['Azorius Signet', azoriusSignet],
      ] as const) {
        if (!(await isTapped(a, id)) && (await pressOffered(card(a, id)))) {
          clicked.push(name);
          pressed = true;
          break;
        }
      }
      if (!pressed) {
        const islands = await a
          .locator(`${BATTLEFIELD} [data-board-card][data-selectable]:not([data-tapped])`)
          .evaluateAll((els) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === 'Island').map((e) => Number(e.getAttribute('data-board-card'))));
        if (islands[0] !== undefined && (await pressOffered(card(a, islands[0])))) {
          clicked.push(`Island#${islands[0]}`);
          pressed = true;
        }
      }
      if (!pressed) {
        const pip = poolPip(a);
        if ((await pip.count()) > 0) {
          const color = await pip.getAttribute('data-mana');
          await pip.click();
          clicked.push(`pool:${color ?? '?'}`);
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const resolved = await inGraveyard(a, 'you', divination);
    console.log(
      `[w68-pay] Divination ${resolved ? 'resolved' : 'NEVER resolved'} ${Date.now() - t0} ms after the click; alice clicked [${clicked.join(', ')}]; ` +
        `Izzet ${(await isTapped(a, izzetSignet)) ? 'tapped' : 'untapped'}; Azorius ${(await isTapped(a, azoriusSignet)) ? 'tapped' : 'untapped'}`,
    );
    expect(clicked, 'the Izzet Signet was tapped inside the payment').toContain('Izzet Signet');
    expect(clicked, 'the Azorius Signet was tapped inside the payment, paid by mana the other Signet left floating').toContain('Azorius Signet');
    expect(resolved, 'Divination resolved after both Signets paid inside its payment').toBe(true);
    await expect.poll(() => inGraveyard(bob.page, 'them', divination), { timeout: 10_000, message: 'bob sees Divination in alice’s graveyard' }).toBe(true);
  } finally {
    await stack.stop();
  }
});
