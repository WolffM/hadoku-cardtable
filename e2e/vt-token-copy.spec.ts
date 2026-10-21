/**
 * The operator, 2026-10-20: *"vaultborn tyrant: 1. the copy doesn't appear to be a token in any way 2. the
 * copy is missing the artifact pill which should have been added to it when it came back."*
 *
 * Vaultborn Tyrant dies and Forge makes a token copy of it, "except it's an artifact in addition to its other
 * types". The copy is drawn with the Tyrant's own art, whose printed type bar says neither "Token" nor
 * "Artifact" — so its type pill must say both: `Token Artifact Creature — Dinosaur`, printed as
 * `Creature — Dinosaur`, on the controller's page and the opponent's.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test SKIPS and its
 * title says why. Serves the prebuilt `apps/ui/dist`.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { castUntilOnStack, grindPriority, handCardNamed, makeTitled, offered, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The battlefield `<li>`s named `name` on the viewer's own side, or the opponent's. */
function named(page: Page, side: 'own' | 'theirs', name: string): Locator {
  const seat = side === 'own' ? '.seat[data-viewer]' : '.seat:not([data-viewer])';
  return page.locator(`${seat} [data-zone="battlefield"] li.board-card`).filter({ has: page.locator('.card__name', { hasText: name }) });
}

const pill = (card: Locator): Locator => card.locator('.board-card__type-pill').first();

test(titled('Vaultborn Tyrant’s token copy wears the pill on both sides: Token Artifact Creature — Dinosaur, printed Creature — Dinosaur'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'vt-token-copy');
    const { alice, bob } = seated;
    const own = named(alice.page, 'own', 'Vaultborn Tyrant');
    await expect(own, 'alice’s Vaultborn Tyrant is on the battlefield').toHaveCount(1, { timeout: 30_000 });
    const original = (await own.first().getAttribute('data-board-card'))!;
    await expect.poll(() => handCardNamed(alice.page, 'Murder'), { timeout: 30_000, message: 'alice holds Murder' }).not.toBeUndefined();
    const murder = (await handCardNamed(alice.page, 'Murder'))!;
    await expect.poll(() => offered(alice.page), { timeout: 45_000, message: 'Murder is offered' }).toContain(murder);
    await castUntilOnStack(alice.page, stack, murder, [own.first()]);
    console.log(`[vt] Murder is on the stack at alice’s Tyrant #${original}`);

    const copy = (page: Page, side: 'own' | 'theirs'): Locator => named(page, side, 'Vaultborn Tyrant').and(page.locator(`:not([data-board-card="${original}"])`)).first();
    await grindPriority([alice.page, bob.page], async () => (await copy(alice.page, 'own').count()) > 0 && (await copy(bob.page, 'theirs').count()) > 0, { timeoutMs: 60_000 }).catch(
      async (e: unknown) => {
        console.log(`[vt] the copy never arrived — alice says "${await says(alice.page)}", bob says "${await says(bob.page)}"`);
        throw e;
      },
    );

    for (const [who, card] of [
      ['alice’s copy (own side)', copy(alice.page, 'own')],
      ['alice’s copy on bob’s page', copy(bob.page, 'theirs')],
    ] as const) {
      const typePill = pill(card);
      await expect
        .poll(async () => (await typePill.count()) > 0, { timeout: 15_000, message: `${who} wears the type pill` })
        .toBe(true)
        .catch(async (e: unknown) => {
          console.log(`[vt] ${who}: NO pill; type bar "${await card.locator('.card__type').first().textContent().catch(() => '?')}"`);
          throw e;
        });
      console.log(`[vt] ${who}: pill "${await typePill.textContent()}" tip "${await typePill.getAttribute('data-tip')}"`);
      await expect(typePill, `${who}: the pill names it a token and an artifact`).toHaveText('Token Artifact Creature — Dinosaur');
      await expect(typePill, `${who}: printed as the Tyrant`).toHaveAttribute('data-tip', 'Printed as Creature — Dinosaur');
    }
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
