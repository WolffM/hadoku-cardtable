/**
 * The operator: "why does error speech 'I have to wait for priority' show when clicking on my
 * opponents graveyard? i was just trying to view it, not use any effect." Live telemetry (match
 * m-dadc9e87cb11) named the real class precisely: seat 1 clicked seat 0's own battlefield
 * permanents (cards 14, 11, 17) while waiting, and `click-refused` read `reason:"nothing-offered"`,
 * `said:"priority"` for every one of them — none were seat 1's own card. `mistakes.test.ts` forces
 * that exact shape directly on the classifier and is RED on the base code, GREEN on the fix.
 *
 * `w121a-mistake-priority`: bob (ai) holds priority in an uncontested turn-1 Main Phase 1; alice
 * (human) has none of her own. This spec passes on both the base and the fixed `mistakes.ts` —
 * clicking bob's own Mountain, or his graveyard card, never shows a mistake bubble in this exact
 * e2e harness, on either build (the button's own `tabindex="-1"`/no `[data-selectable]` confirm
 * the press is read as refused the way the viewer's own summoning-sick creature reliably is —
 * `mistake-bubbles.spec.ts` — but no observable signal, bubble or otherwise, ever follows a press
 * on the OTHER seat's own card here). It is kept as a regression guard on the observable
 * behaviour, not as the RED→GREEN proof — that lives in `mistakes.test.ts`.
 *
 * Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const MISTAKE_BUBBLE = '[data-testid="mistake-bubble"]';

test(titled('clicking the opponent’s own battlefield permanent, while this seat waits, shows no mistake'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w121a-mistake-priority');
    const page = alice.page;

    const theirBattlefield = page.locator('[data-zone="battlefield"][data-owner="them"]');
    await expect(theirBattlefield.locator('[data-board-card]'), 'bob’s Mountain is drawn').toHaveCount(1, { timeout: 20_000 });
    await theirBattlefield.locator('[data-board-card] button.board-card__face').first().click();

    await expect(page.locator(MISTAKE_BUBBLE), 'no mistake bubble — this was never an attempt to act').toHaveCount(0);
    await page.waitForTimeout(1_000);
    await expect(page.locator(MISTAKE_BUBBLE), 'and none shows up late either').toHaveCount(0);

    // The same check on a public zone's card: bob's graveyard.
    const theirGraveyard = page.locator('[data-zone="graveyard"][data-owner="them"]');
    await expect(theirGraveyard, 'bob’s graveyard is drawn with his one card').toHaveAttribute('data-count', '1', { timeout: 20_000 });
    await theirGraveyard.locator('[data-board-card] button.board-card__face').first().click();
    await expect(page.locator(MISTAKE_BUBBLE), 'no mistake bubble for the graveyard view either').toHaveCount(0);
  } finally {
    await stack.stop();
  }
});
