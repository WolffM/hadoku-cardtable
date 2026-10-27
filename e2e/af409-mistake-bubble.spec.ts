/**
 * (2026-10-26, the operator: "you can ship it"): the seat's own character says what it got
 * wrong, on the seat's own screen only — never the opponent's, never a watcher's. Scenario
 * `af409-second-land` (`apps/server/src/play/scenarios/af409-second-land.state`): seat 0 holds a
 * Forest and a Mountain in hand, an uncontested turn-1 Main Phase 1.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and
 * the title says why. Serves the prebuilt `apps/ui/dist`.
 */
import { expect, test } from '@playwright/test';

import { clickHandCard, handCardNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { closeSettings, openSettings } from './play/w32.ts';

const forge = forgeAvailability();
const titled = (t: string): string => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);

const MISTAKE_BUBBLE = '[data-testid="mistake-bubble"]';
const LAND_MISTAKE_LINE = 'I already played a land this turn.';

test(titled('a second land press is said on the seat’s own screen only, and the setting turns it off'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'af409-second-land');

    const forest = await handCardNamed(alice.page, 'Forest');
    const mountain = await handCardNamed(alice.page, 'Mountain');
    expect(forest, 'alice holds Forest').toBeDefined();
    expect(mountain, 'alice holds Mountain').toBeDefined();

    // Play the Forest for real — the land this turn's own play, nothing wrong with it.
    await clickHandCard(alice.page, forest!);
    await expect.poll(async () => (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]').count()) > 0, {
      timeout: 15_000,
      message: 'the Forest landed on alice’s own battlefield',
    }).toBe(true);
    await expect(alice.page.locator(MISTAKE_BUBBLE), 'no mistake for a legal play').toHaveCount(0);

    // Press the second land — refused before it ever reaches Forge (NumLandThisTurn === MaxLandPlay).
    await clickHandCard(alice.page, mountain!);

    await expect(alice.page.locator(MISTAKE_BUBBLE), 'the exact line, on alice’s own screen').toHaveText(LAND_MISTAKE_LINE, { timeout: 10_000 });
    expect(await alice.page.locator(MISTAKE_BUBBLE).getAttribute('data-mistake')).toBe('land');

    // Never on bob's screen: he never sent this click, never received `match.mistake` for it, and
    // the rule is the seat's own avatar, never the opponent's.
    await expect(bob.page.locator(MISTAKE_BUBBLE), 'never on the opponent’s screen').toHaveCount(0);

    // "Say my mistakes" off: the bubble is gone. The Mountain is still in hand (still refused the
    // same way — today's behaviour for this exact refusal is unchanged either way: this classifier
    // never reaches Forge, so there was never a card shake for it to fall back to).
    const toggle = (await openSettings(alice.page)).locator('[data-testid="live-settings-mistake-bubbles"]');
    await expect(toggle, 'on by default').toBeChecked();
    await toggle.uncheck();
    await closeSettings(alice.page);

    await clickHandCard(alice.page, mountain!);
    await alice.page.waitForTimeout(500);
    await expect(alice.page.locator(MISTAKE_BUBBLE), 'the setting off: no bubble').toHaveCount(0);
    expect(await handCardNamed(alice.page, 'Mountain'), 'the Mountain is still in hand — never played').toBeDefined();
  } finally {
    await stack.stop();
  }
});
