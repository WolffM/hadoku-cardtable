/*
 * Llanowar Elves untap on a click, like a land — on both screens.
 *
 * The operator, three times (2026-10-04, 2026-10-06, 2026-10-08): "i should be
 * able to untap llanowar elves if i haven't done anything with the mana and it
 * hasn't triggered anything." Measured against the jar (`mana-sources.jvm.test.ts`):
 * Forge undoes a creature's mana ability exactly as a land's; what kept the
 * Elves off the click was the board's own tap record reading "Land". Scenario
 * `w65-elves`: alice's turn-1 Main 1 with Llanowar Elves (not sick) and two
 * Forests, an empty hand so nothing can spend the mana.
 *
 * Two screens: bob sees alice's Elves tap and untap exactly as she does. The
 * Forest afterwards is the control — the half that already worked (V6).
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const ownBattlefield = '.seat[data-viewer] [data-zone="battlefield"]';

/** The viewer's own battlefield cards named `name`, in DOM order. */
function ownNamed(page: Page, name: string): Promise<number[]> {
  return page
    .locator(`${ownBattlefield} [data-board-card]`)
    .evaluateAll(
      (els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))),
      name,
    );
}

const card = (page: Page, id: number) => page.locator(`[data-board-card="${id}"]`);
const isTapped = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-tapped'));
const isOffered = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-selectable'));

/**
 * Click an offered permanent until it taps. The first click after a scenario
 * applies can be dropped (the scenario-start race), so a click is repeated only
 * while the card is still untapped, a second apart — never once it has tapped.
 */
async function tapByClick(page: Page, id: number, what: string): Promise<void> {
  await expect.poll(() => isOffered(page, id), { timeout: 45_000, message: `${what} is offered at priority` }).toBe(true);
  for (let i = 0; i < 10 && !(await isTapped(page, id)); i++) {
    await card(page, id).locator('button').first().click();
    await expect
      .poll(() => isTapped(page, id), { timeout: 1_000 })
      .toBe(true)
      .catch(() => undefined);
  }
  expect(await isTapped(page, id), `${what} tapped on a click`).toBe(true);
}

/** Tap `id` by a click, then click it again: it untaps — on alice's screen and on bob's. */
async function tapThenUntap(alice: Page, bob: Page, id: number, what: string): Promise<void> {
  const t0 = Date.now();
  await tapByClick(alice, id, what);
  await expect.poll(() => isTapped(bob, id), { timeout: 10_000, message: `bob sees ${what} tapped` }).toBe(true);
  await expect.poll(() => isOffered(alice, id), { timeout: 10_000, message: `${what}, tapped last, is offered for the untap click` }).toBe(true);
  await card(alice, id).locator('button').first().click();
  await expect.poll(() => isTapped(alice, id), { timeout: 10_000, message: `a click on ${what} untapped it (Forge's Undo)` }).toBe(false);
  await expect.poll(() => isTapped(bob, id), { timeout: 10_000, message: `bob sees ${what} untapped` }).toBe(false);
  console.log(`[elves] ${what}#${id}: tapped and untapped on both screens in ${Date.now() - t0} ms`);
}

test(titled('Llanowar Elves tapped for mana untap on a click, on both screens — then a Forest, the control'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w65-elves');
    await expect.poll(() => ownNamed(alice.page, 'Llanowar Elves'), { timeout: 45_000, message: 'the Elves are on alice’s battlefield' }).toHaveLength(1);
    const [elves] = await ownNamed(alice.page, 'Llanowar Elves');
    const [forest] = await ownNamed(alice.page, 'Forest');
    if (elves === undefined || forest === undefined) throw new Error('the scenario gave alice no Elves or no Forest');

    await tapThenUntap(alice.page, bob.page, elves, 'Llanowar Elves');
    await tapThenUntap(alice.page, bob.page, forest, 'Forest');
  } finally {
    await stack.stop();
  }
});
