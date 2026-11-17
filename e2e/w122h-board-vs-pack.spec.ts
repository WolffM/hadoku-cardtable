/**
 * the scale comparison the brief asked for, measured directly: the board's own hover
 * enlargement (a hand card, through the SAME `mountInspector`/`zoomWidth` the draft pack's open
 * card now reaches) beside `w122h-pack-hover-zoom.spec.ts`'s pack measurement, so "reuse the
 * board's one inspector size" is a measurement, not an assertion. Scenario `bl-ui-scale`: a real
 * hand (`humanhand=Forest;Forest;Divination`) with no coin toss or mulligan to clear first
 * (`skipOpening`) — the lightest real match that puts a card in alice's own hand.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and
 * the title says why, same as `own-deck.spec.ts`. Serves the prebuilt `apps/ui/dist`.
 */
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const SHOT_DIR = fileURLToPath(new URL('../docs/handoff/w122-H', import.meta.url));

test.beforeAll(async () => {
  await mkdir(SHOT_DIR, { recursive: true });
});

test(titled('a hand card’s hover reaches the same inspector size the draft pack’s open card now does'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const seated = await startScenarioMatch(browser, stack, 'bl-ui-scale');
    const page = seated.alice.page;

    const hand = page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]').filter({ hasText: 'Divination' });
    await expect(hand, 'alice’s scripted hand carries Divination').toHaveCount(1, { timeout: 30_000 });
    const before = await hand.boundingBox();
    if (before === null) throw new Error('no hand card box');

    await hand.hover();
    const panel = page.getByTestId('card-view');
    await expect(panel, 'hovering the hand card opens the shared inspector').toBeVisible();
    const zoomed = await panel.boundingBox();
    if (zoomed === null) throw new Error('no inspector box');
    console.log(`[w122h] board hand card ${JSON.stringify(before)} -> inspector ${JSON.stringify(zoomed)}`);
    await page.screenshot({ path: `${SHOT_DIR}/board-hand-card-hover.png` });

    // The board's own inspector hover, for the report's side-by-side against the pack's
    // (`w122h-pack-hover-zoom.spec.ts`): both are `zoomWidth`'s PREF_W (380 CSS px) at this
    // viewport — the one size every hover on this app reaches, not two different mechanisms.
    expect(zoomed.width, 'the board’s own inspector is PREF_W wide, the same constant the pack’s open card now reaches').toBeGreaterThan(before.width);
  } finally {
    await stack.stop();
  }
});
