/**
 * Wave 53 §T — the operator, Playtest 9: *"cards like 'Magus of the moon' and
 * 'Urborg tomb of yawgmoth' change the types of cards. i need this to be
 * visually indicated by a tag of some kind … put one of our overlay pills over
 * the type bar."*
 *
 * Against real Forge: Urborg, Tomb of Yawgmoth turns a Plains into a Swamp
 * TOO (`AddType$ Swamp`, no `RemoveLandTypes` — the Plains keeps its own
 * type and gains Swamp alongside it), and Magus of the Moon turns a nonbasic
 * land INTO a Mountain (`AddType$ Mountain | RemoveLandTypes$ True` — the
 * land's own type is replaced outright). Both are the same `changedFrom`
 * mechanism (`adapter.ts`): the wire's live `Type` disagreeing with our own
 * static data's printed line.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one every test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist`.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const ownBattlefield = '.seat[data-viewer] [data-zone="battlefield"]';

/** The viewer's own battlefield `<li>` for the (unique) card named `name`. */
function ownNamed(page: Page, name: string): Locator {
  return page
    .locator(`${ownBattlefield} li.board-card`)
    .filter({ has: page.locator('.card__name', { hasText: name }) })
    .first();
}

const pill = (card: Locator): Locator => card.locator('.board-card__type-pill');

test(titled('T1 — Urborg, Tomb of Yawgmoth: a Plains wears a pill reading its current type, Basic Land — Plains on hover'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w53-t-urborg');
    const plains = ownNamed(alice.page, 'Plains');
    await expect(plains, 'the scripted Plains is on the battlefield').toBeVisible({ timeout: 30_000 });

    const typePill = pill(plains);
    await expect(typePill, 'Urborg’s AddType$ Swamp changed the Plains — the pill is drawn').toBeVisible({ timeout: 30_000 });
    await expect(typePill, 'visible text: the CURRENT type line (Swamp added alongside Plains)').toHaveText('Basic Land — Plains Swamp');
    await expect(typePill, 'its tooltip: the PRINTED type line').toHaveAttribute('data-tip', 'Printed as Basic Land — Plains');
  } finally {
    await stack.stop();
  }
});

test(titled('T2 — Magus of the Moon: a nonbasic land wears a pill reading Land — Mountain, Land on hover'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w53-t-magus');
    const land = ownNamed(alice.page, 'Seachrome Coast');
    await expect(land, 'the scripted nonbasic land is on the battlefield').toBeVisible({ timeout: 30_000 });

    const typePill = pill(land);
    await expect(typePill, 'Magus’s AddType$ Mountain | RemoveLandTypes$ True replaced the land’s type — the pill is drawn').toBeVisible({
      timeout: 30_000,
    });
    await expect(typePill, 'visible text: the CURRENT type line (Mountain, replacing whatever it had)').toHaveText('Land — Mountain');
    await expect(typePill, 'its tooltip: the PRINTED type line').toHaveAttribute('data-tip', 'Printed as Land');

    // Magus of the Moon itself is unaffected — the effect names "nonbasic
    // lands", not the creature making it happen.
    const magus = ownNamed(alice.page, 'Magus of the Moon');
    await expect(pill(magus), 'Magus of the Moon wears no pill of its own').toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

/*
 * T3 — the w52 follow-up (item 3): `nothingToDecide` folds `manaOnly` in
 * alongside the viewer's own lands, so End Turn is highlighted for a seat
 * whose only offer is a Signet (w52's own card, `setWeaklySelectable.manaOnly`
 * — `packages/forge-wire/src/tier-b.ts`).
 *
 * `w52-s-signet.state` itself is NOT used here: it puts the Signet on the
 * OPPONENT's battlefield specifically to prove the SERVER auto-passes that
 * seat's priority (`apps/server/src/play/w52-s-signet.jvm.test.ts`) — an
 * intentionally transient window a seat never has to act in. End Turn's
 * highlight is a different claim: the VIEWER's own priority, with nothing
 * left to decide, stays a stable, visible invitation to end the turn
 * (`nothing-left.state`'s own shape, e2e/w35.spec.ts R5). `w53-t-signet-only.
 * state` is that shape with w52's exact battlefield (Azorius Signet + two
 * Islands) instead of a land/no-ability creature, so what is new here is
 * specifically the `manaOnly` fold, not the land case w35 already proved.
 */
test(titled('T3 — End Turn is highlighted for a seat whose only offer is a Signet (w52’s manaOnly folded into nothingToDecide)'), async ({
  browser,
}) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w53-t-signet-only');
    const signet = ownNamed(alice.page, 'Azorius Signet');
    await expect(signet, 'the scripted Signet is on the battlefield').toBeVisible({ timeout: 30_000 });

    const endTurn = alice.page.getByTestId('live-button-end-turn');
    await expect(endTurn, 'End Turn is enabled (Forge is offering it)').toBeEnabled({ timeout: 30_000 });
    await expect(endTurn, 'and highlighted: nothing left to decide with only a Signet and Islands offered').toHaveAttribute(
      'data-highlight',
      '',
      { timeout: 30_000 },
    );
  } finally {
    await stack.stop();
  }
});
