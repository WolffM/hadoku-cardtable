/**
 * Wave 52 §E — mana you can tap is mana you can click, against a real Forge
 * match. The operator's live match m-6ce49e226aef, 2026-10-06:
 *
 *  1. *"azorius signet is not tappable at all."* Forge offered a mana ability at
 *     priority only when its cost was exactly `{T}`
 *     (`AvailableActions.cardHasActionable`); the Signet's is `{1},{T}`. The fork
 *     now offers a mana ability whose cost is a tap plus mana it can pay.
 *     `w52-e-signet.state`: Signet, three Islands, Divination in hand.
 *  2. *"after tapping it i can only undo using the 'undo' button i can't click to
 *     untap anymore. after undoing it's not tappable anymore."* (ledger W10).
 *     `PlayerControllerHuman.tryUndoLastAction` re-showed the prompt with the
 *     actionable set cached while the Island was tapped; the fork drops that cache
 *     first. Proven twice: in Main 1 with something castable (`w52-e-signet`) and
 *     in Main 2 with nothing castable (`w52-e-island`, W10's own shape).
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one
 * every test SKIPS and its title says why. Serves the prebuilt `apps/ui/dist`.
 */

import { expect, test, type Page } from '@playwright/test';

import { livePrompt, makeTitled } from './play/board.ts';
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
const pool = (page: Page) =>
  page.locator('.seat[data-viewer] [data-mana-pool]').evaluate((el) => ({
    total: Number(el.getAttribute('data-mana-total') ?? '0'),
    W: Number(el.querySelector('[data-mana="W"]')?.getAttribute('data-mana-count') ?? '0'),
    U: Number(el.querySelector('[data-mana="U"]')?.getAttribute('data-mana-count') ?? '0'),
  }));

/**
 * Click an offered permanent until it taps. The first click after a scenario
 * applies can be dropped (the scenario-start race, `PlayBridge.java`'s
 * `refreshActionable`), so a click is repeated only while the card is still
 * untapped, a second apart — never once it has tapped.
 */
async function tapByClick(page: Page, id: number, what: string): Promise<void> {
  await expect.poll(() => isOffered(page, id), { timeout: 45_000, message: `${what} is offered at priority` }).toBe(true);
  for (let i = 0; i < 10 && !(await isTapped(page, id)); i++) {
    await card(page, id).locator('button').first().click();
    await expect.poll(() => isTapped(page, id), { timeout: 1_000 }).toBe(true).catch(() => undefined);
  }
  expect(await isTapped(page, id), `${what} tapped on a click`).toBe(true);
}

/** Island → tapped → Undo → untapped and offered again → tapped again. */
async function tapUndoTap(page: Page): Promise<void> {
  const island = (await ownNamed(page, 'Island'))[0];
  if (island === undefined) throw new Error('no Island on the viewer battlefield');
  await tapByClick(page, island, 'the Island');
  await expect.poll(async () => (await pool(page)).U, { timeout: 10_000, message: 'the Island added {U}' }).toBe(1);

  // The way back is a click on the land tapped last (Forge's Undo underneath, ledger V6): after a mana tap
  // the table draws no Undo button and Next Phase stays live (operator, 2026-10-06).
  await expect(page.getByTestId('live-decision'), 'no pop-up after a mana tap').toHaveCount(0);
  await expect(page.getByTestId('live-button-next-phase'), 'Next Phase stays live after a mana tap').toBeEnabled({ timeout: 10_000 });
  await card(page, island).locator('button').first().click();
  await expect.poll(() => isTapped(page, island), { timeout: 10_000, message: 'a click on the Island untapped it (Undo)' }).toBe(false);
  await expect.poll(async () => (await pool(page)).total, { timeout: 10_000, message: 'Undo emptied the pool' }).toBe(0);
  // The claim: the re-shown prompt offers the Island again, so a click taps it.
  await expect.poll(() => isOffered(page, island), { timeout: 10_000, message: 'the Island is offered again after Undo' }).toBe(true);
  await card(page, island).locator('button').first().click();
  await expect.poll(() => isTapped(page, island), { timeout: 10_000, message: 'the Island taps again after Undo' }).toBe(true);
  await expect.poll(async () => (await pool(page)).U, { timeout: 10_000 }).toBe(1);
}

test(titled('w52 — Azorius Signet is clickable at priority; a click adds {W}{U} while an Island pays the {1}'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w52-e-signet');
    const page = alice.page;
    const signet = (await ownNamed(page, 'Azorius Signet'))[0];
    if (signet === undefined) throw new Error('no Azorius Signet on alice’s battlefield');
    expect(await pool(page), 'the pool starts empty').toEqual({ total: 0, W: 0, U: 0 });

    await tapByClick(page, signet, 'Azorius Signet');
    await expect.poll(() => pool(page), { timeout: 15_000, message: 'the pool shows {W}{U}' }).toEqual({ total: 2, W: 1, U: 1 });
    const islandsTapped = await Promise.all((await ownNamed(page, 'Island')).map((id) => isTapped(page, id)));
    expect(islandsTapped.filter(Boolean), 'exactly one Island paid the {1}').toHaveLength(1);
    await expect(livePrompt(page), 'nothing is left asking').toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

test(titled('w52 — Island: tap, Undo, tap again — Main 1 with something castable'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w52-e-signet');
    await tapUndoTap(alice.page);
  } finally {
    await stack.stop();
  }
});

test(titled('w52 — Island: tap, Undo, tap again — Main 2 with nothing castable (W10)'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w52-e-island');
    await tapUndoTap(alice.page);
  } finally {
    await stack.stop();
  }
});
