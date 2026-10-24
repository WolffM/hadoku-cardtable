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

import { clickPermanent, clickRecords, isOffered, isTapped, livePrompt, makeTitled, manaPool as pool, nextPhaseLive, ownNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** One click on an offered permanent in a live window; it taps. */
async function tapByClick(page: Page, stack: PlayStack, id: number, what: string): Promise<void> {
  expect(await clickPermanent(page, id), `${what} is offered in a live window`).toBe(true);
  await expect.poll(() => isTapped(page, id), { timeout: 10_000, message: `${what} tapped on one click — the server's clicks on it: ${clickRecords(stack, id)}` }).toBe(true);
}

/** Island → tapped → Undo → untapped and offered again → tapped again. */
async function tapUndoTap(page: Page, stack: PlayStack): Promise<void> {
  const island = (await ownNamed(page, 'Island'))[0];
  if (island === undefined) throw new Error('no Island on the viewer battlefield');
  await tapByClick(page, stack, island, 'the Island');
  await expect.poll(async () => (await pool(page)).U, { timeout: 10_000, message: 'the Island added {U}' }).toBe(1);

  // The way back is a click on the land tapped last (Forge's Undo underneath, ledger V6): after a mana tap
  // the pass pop-up draws no Undo button and Next Phase stays live (operator, 2026-10-06; wave 75 moved
  // that pop-up off the control box, but the stack is still empty so the route is still the plain pass).
  await expect(page.getByTestId('live-decision-cancel'), 'no Undo button beside it').toHaveCount(0);
  await expect(nextPhaseLive(page), 'Next Phase stays live after a mana tap').toHaveCount(1, { timeout: 10_000 });
  expect(await clickPermanent(page, island, 10_000), 'the tapped Island is offered for the untap click').toBe(true);
  await expect.poll(() => isTapped(page, island), { timeout: 10_000, message: 'a click on the Island untapped it (Undo)' }).toBe(false);
  await expect.poll(async () => (await pool(page)).total, { timeout: 10_000, message: 'Undo emptied the pool' }).toBe(0);
  // The claim: the re-shown prompt offers the Island again, so a click taps it.
  await expect.poll(() => isOffered(page, island), { timeout: 10_000, message: 'the Island is offered again after Undo' }).toBe(true);
  expect(await clickPermanent(page, island, 10_000), 'the Island is offered in a live window after Undo').toBe(true);
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
    expect((await pool(page)).total, 'the pool starts empty').toBe(0);

    await tapByClick(page, stack, signet, 'Azorius Signet');
    await expect.poll(async () => { const p = await pool(page); return [p.total, p.W, p.U]; }, { timeout: 15_000, message: 'the pool shows {W}{U}' }).toEqual([2, 1, 1]);
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
    await tapUndoTap(alice.page, stack);
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
    await tapUndoTap(alice.page, stack);
  } finally {
    await stack.stop();
  }
});
