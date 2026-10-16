/**
 * The operator, 2026-10-15: *"phyrexian metamorph makes a creature an artifact when it copies it. i
 * would have expect this to show the card type changed. please make sure that any card that changes a
 * cards type is reflected as a pill"* — and Urborg, Tomb of Yawgmoth must keep working, on every land,
 * on both sides of the table.
 *
 * The type pill is Forge's own fact: the wire's current `Type` against the printed type the bridge
 * names (`printedTypes`), for every battlefield permanent — a card the cube pool has never heard of
 * included. Each test reads the pill on both seats' pages: the controller's own battlefield and the
 * opponent's.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one every test SKIPS and
 * its title says why. Serves the prebuilt `apps/ui/dist`.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { castCard, clickOnce, enabledOk, grindPriority, handCardNamed, makeTitled, offered, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The battlefield `<li>` for the (unique) card named `name` on the viewer's own side, or the opponent's. */
function named(page: Page, side: 'own' | 'theirs', name: string): Locator {
  const seat = side === 'own' ? '.seat[data-viewer]' : '.seat:not([data-viewer])';
  return page
    .locator(`${seat} [data-zone="battlefield"] li.board-card`)
    .filter({ has: page.locator('.card__name', { hasText: name }) })
    .first();
}

const pill = (card: Locator): Locator => card.locator('.board-card__type-pill');

/** The card's pill reads `current` and its tooltip names `printed`, logged as an evidence line first. */
async function expectPill(card: Locator, label: string, current: string, printed: string): Promise<void> {
  await expect(card, `${label} is on the battlefield`).toBeVisible({ timeout: 30_000 });
  const typePill = pill(card);
  await expect
    .poll(async () => (await typePill.count()) > 0, { timeout: 15_000, message: `${label} wears the type pill — its type bar reads "${await card.locator('.card__type').first().textContent().catch(() => '')}"` })
    .toBe(true)
    .catch(async (e: unknown) => {
      console.log(`[tl] ${label}: NO pill; type bar "${await card.locator('.card__type').first().textContent().catch(() => '?')}"`);
      throw e;
    });
  console.log(`[tl] ${label}: pill "${await typePill.textContent()}" tip "${await typePill.getAttribute('data-tip')}"`);
  await expect(typePill, `${label}: visible text is the CURRENT type line`).toHaveText(current);
  await expect(typePill, `${label}: the tooltip is the PRINTED type line`).toHaveAttribute('data-tip', `Printed as ${printed}`);
}

async function closeAll(seated: ScenarioMatch | null, stack: { stop(): Promise<void> }): Promise<void> {
  await seated?.alice.context.close();
  await seated?.bob.context.close();
  await stack.stop();
}

test(titled('Phyrexian Metamorph copying Grizzly Bears wears the pill: Artifact Creature — Bear, printed Creature — Bear'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'tl-metamorph');
    const { alice, bob } = seated;
    await expect.poll(() => handCardNamed(alice.page, 'Phyrexian Metamorph'), { timeout: 30_000, message: 'alice holds Phyrexian Metamorph' }).not.toBeUndefined();
    const metamorph = (await handCardNamed(alice.page, 'Phyrexian Metamorph'))!;
    await expect.poll(() => offered(alice.page), { timeout: 45_000, message: 'Phyrexian Metamorph is offered' }).toContain(metamorph);
    await castCard(alice.page, metamorph);
    const copy = named(alice.page, 'own', 'Grizzly Bears');
    // The copy is Forge's InputConfirm ("Apply replacement effect of Phyrexian Metamorph?"), drawn in
    // the decision area (`live-confirm-host`), where button one copies; every other window is the plain OK.
    const press = async (page: Page): Promise<void> => {
      const yes = page.locator('[data-testid="live-confirm-host"] [data-testid="prompt-confirm-yes"]:enabled');
      if ((await yes.count()) > 0) {
        console.log(`[tl] ${page === alice.page ? 'alice' : 'bob'} answers yes to "${await says(page)}"`);
        await yes.first().click({ timeout: 1_000 }).catch(() => undefined);
      } else if ((await enabledOk(page).count()) > 0) await clickOnce(page, await says(page), 'ok');
    };
    await grindPriority([alice.page, bob.page], async () => (await copy.count()) > 0, { timeoutMs: 45_000, press }).catch(async (e: unknown) => {
      console.log(`[tl] metamorph never resolved as the Bears — alice says "${await says(alice.page)}"`);
      throw e;
    });
    console.log(`[tl] metamorph resolved — alice says "${await says(alice.page)}"`);

    await expectPill(copy, 'alice’s Metamorph copy (own side)', 'Artifact Creature — Bear', 'Creature — Bear');
    await expectPill(named(bob.page, 'theirs', 'Grizzly Bears'), 'alice’s Metamorph copy on bob’s page', 'Artifact Creature — Bear', 'Creature — Bear');
    await expect(pill(named(bob.page, 'own', 'Grizzly Bears')), 'the original Bears is unchanged').toHaveCount(0);
  } finally {
    await closeAll(seated, stack);
  }
});

test(titled('Urborg, Tomb of Yawgmoth: lands the pool never heard of wear the pill on both sides; a basic Plains still does'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'tl-urborg');
    const { alice, bob } = seated;
    await expectPill(named(alice.page, 'own', 'Adarkar Wastes'), 'alice’s Adarkar Wastes (own side)', 'Land — Swamp', 'Land');
    await expectPill(named(alice.page, 'theirs', 'Glacial Fortress'), 'bob’s Glacial Fortress on alice’s page', 'Land — Swamp', 'Land');
    await expectPill(named(alice.page, 'own', 'Plains'), 'alice’s Plains (own side)', 'Basic Land — Plains Swamp', 'Basic Land — Plains');
    await expectPill(named(bob.page, 'own', 'Glacial Fortress'), 'bob’s Glacial Fortress (own side)', 'Land — Swamp', 'Land');
    await expectPill(named(bob.page, 'theirs', 'Adarkar Wastes'), 'alice’s Adarkar Wastes on bob’s page', 'Land — Swamp', 'Land');
  } finally {
    await closeAll(seated, stack);
  }
});

test(titled('Blood Moon: nonbasic lands the pool never heard of wear Land — Mountain on both sides'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'tl-blood-moon');
    const { alice, bob } = seated;
    await expectPill(named(alice.page, 'own', 'Adarkar Wastes'), 'alice’s Adarkar Wastes (own side)', 'Land — Mountain', 'Land');
    await expectPill(named(alice.page, 'theirs', 'Glacial Fortress'), 'bob’s Glacial Fortress on alice’s page', 'Land — Mountain', 'Land');
    await expectPill(named(bob.page, 'own', 'Glacial Fortress'), 'bob’s Glacial Fortress (own side)', 'Land — Mountain', 'Land');
    await expect(pill(named(alice.page, 'own', 'Blood Moon')), 'Blood Moon itself is unchanged').toHaveCount(0);
  } finally {
    await closeAll(seated, stack);
  }
});
