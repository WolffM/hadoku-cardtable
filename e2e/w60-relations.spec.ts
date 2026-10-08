/**
 * Relations, generically. Playtest 14, the operator:
 * *"i played 'Cry of Contrition' which has haunt. i expect to see the
 * 'haunt' keyword on my creature. … is there an easier way to always get
 * that effect name to popup rather than having to hardcode all of them?"*
 *
 * Haunt is the ledger's own motivating case, but the mechanism built here
 * (`adapter.ts`'s `BoardCard.relations`, `Relations.tsx`'s pill) is generic
 * across every relation kind Forge's wire names — this spec proves the one
 * case the operator actually hit, against REAL Forge, on BOTH screens.
 *
 * `w60-haunt.state`: alice (seat 0) holds Cry of Contrition and one untapped
 * Swamp, with her own Memnite — the only creature on the table — already on
 * the battlefield. Casting it targets alice herself (its own discard
 * ability); once it resolves, Haunt's own separate trigger asks to choose a
 * target creature to haunt, and Memnite is the only legal one. Nothing here
 * is scripted directly — `GameState` has no key for a haunt relation, and
 * this spec reaches it exactly how a real board would.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`);
 * without one this SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { clickHandCard, clickOnce, handCardNamed, makeTitled, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/**
 * `name`'s own `<li>`, inside `zone` (`data-zone`'s value: `'battlefield'`,
 * `'exile'`, `'graveyard'`, …) — by `.card__name`, same pattern
 * `w53-type-pill.spec.ts` uses. Scoped by zone alone, NEVER by
 * `.seat[data-viewer]`/`:not()`: which side is "viewer" flips between
 * alice's page and bob's, and this scenario leaves exactly one of each
 * named card on the WHOLE board, so a seat-scoped selector only adds a way
 * to get it wrong — see `castCryOfContritionAndHaunt`'s own note on the one
 * way that bit this spec, against the real jar, before this comment did.
 */
function cardNamed(page: Page, zone: string, name: string): Locator {
  return page
    .locator(`[data-zone="${zone}"] li.board-card`)
    .filter({ has: page.locator('.card__name', { hasText: name }) })
    .first();
}

/** The relation pill of this one kind, on `card` — `Relations.tsx`'s own `.board-card__counter[data-relation]`. */
const relationPill = (card: Locator, kind: string): Locator => card.locator(`.board-card__counter[data-relation="${kind}"]`);

/**
 * Cast Cry of Contrition, target alice herself for the discard, pay its
 * `{B}`, then answer Haunt's own follow-up ask (a separate targeting step,
 * after the spell has already resolved and gone to the graveyard) by
 * clicking Memnite — the only legal target the scenario leaves on the table.
 * Drives both seats' priority (bob has nothing to respond with and never
 * acts) until the haunt pairing actually lands on the wire.
 */
async function castCryOfContritionAndHaunt(alice: Page, bob: Page): Promise<void> {
  await expect
    .poll(() => handCardNamed(alice, 'Cry of Contrition'), { timeout: 30_000, message: 'alice holds Cry of Contrition — the precondition "w60-haunt" sets up' })
    .not.toBeUndefined();
  const cry = (await handCardNamed(alice, 'Cry of Contrition'))!;
  await clickHandCard(alice, cry);
  await expect
    .poll(() => says(alice), { timeout: 10_000, message: 'the cast reached Forge: it opened a targeting ask for the discard' })
    .toMatch(/Cry of Contrition.*target/is);

  // Cry of Contrition's own ability targets a PLAYER (its discard) — alice
  // herself, the same `[data-player-face][data-viewer]` surface every other
  // spec uses for a self-targeted spell.
  await alice.locator('[data-player-face][data-viewer]').click();

  // Pay the {B}, let the discard resolve, then Haunt's own SEPARATE trigger
  // asks for a target creature. Two different Forge surfaces land here, not
  // one: discarding from alice's OWN hand is `match.selectables` drawn as
  // `SelectionPrompt`'s grid (`data-testid="live-selection-host"`, ticking
  // a card's own `prompt-choice` checkbox answers it immediately — found by
  // running this spec against the real jar: `answerPrompt`'s `live-prompt`
  // lookup never sees it, because this popup carries no such testid), while
  // choosing the haunt TARGET is a plain board `data-selectable` click, the
  // same shape Doom Blade's own target takes (S, wave 33). Both are handled
  // every iteration; only one is ever actually present at a time.
  const hauntedPill = relationPill(cardNamed(alice, 'battlefield', 'Memnite'), 'hauntedBy');
  const deadline = Date.now() + 90_000;
  while ((await hauntedPill.count()) === 0 && Date.now() < deadline) {
    await answerPrompt(alice);
    await answerPrompt(bob);
    const text = await says(alice);
    if (/Pay Mana Cost/i.test(text)) await clickOnce(alice, text, 'ok');
    const selectionChoice = alice.locator('[data-testid="live-selection-host"] input[data-testid="prompt-choice"]:not(:checked)');
    if ((await selectionChoice.count()) > 0) await selectionChoice.first().click({ force: true });
    await clickOnce(alice, text, 'ok'); // the selection grid's own "Done", once enabled
    const selectableMemnite = alice.locator('[data-zone="battlefield"] li.board-card[data-selectable]').filter({
      has: alice.locator('.card__name', { hasText: 'Memnite' }),
    });
    if ((await selectableMemnite.count()) > 0) await selectableMemnite.first().locator('button').first().click();
    await alice.waitForTimeout(40);
  }
}

test(titled('Cry of Contrition’s Haunt: the creature wears "Haunted by Cry of Contrition", the exiled card wears "Haunting Memnite", on BOTH screens'), async ({
  browser,
}) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w60-haunt');

    await castCryOfContritionAndHaunt(alice.page, bob.page);

    // Scoped by zone alone, not by which seat's `.seat[data-viewer]`/`:not()`
    // side it falls on: the scenario leaves exactly one Memnite and one Cry
    // of Contrition on the WHOLE board, and which side is "viewer" flips
    // between alice's page and bob's — a selector that names both sides
    // with a comma, then appends `li.board-card` after it, only binds that
    // suffix to the LAST comma-separated clause (a real bug this spec hit
    // once, against the real jar, before this comment existed).
    for (const page of [alice.page, bob.page]) {
      const creature = cardNamed(page, 'battlefield', 'Memnite');
      await expect(relationPill(creature, 'hauntedBy'), 'Memnite wears its own relation pill').toBeVisible({ timeout: 20_000 });
      await expect(relationPill(creature, 'hauntedBy'), 'the pill names the haunting card by its resolved name').toHaveText('Haunted by Cry of Contrition');

      // Haunt's own `game.getAction().exile(…)` moves Cry of Contrition OUT
      // of the graveyard and into exile the moment it haunts — never the
      // graveyard, on either screen.
      const exiled = cardNamed(page, 'exile', 'Cry of Contrition');
      await expect(exiled, 'the sorcery sits in exile, haunting — not the graveyard').toBeVisible({ timeout: 20_000 });
      await expect(relationPill(exiled, 'haunting'), 'its own pill names the creature it haunts').toHaveText('Haunting Memnite');

      const graveyardCry = cardNamed(page, 'graveyard', 'Cry of Contrition');
      await expect(graveyardCry, 'never also in the graveyard').toHaveCount(0);
    }
  } finally {
    await stack.stop();
  }
});
