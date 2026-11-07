/**
 * Desktop: one arrow at the target player, never two, for every player-targeting cast. See `./two-arrows.ts`.
 */
import { test } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability } from './play/harness.ts';
import { twoArrowsScenario } from './two-arrows.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('a spell cast at a player, by click or by drag, never draws two arrows at that player'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  await twoArrowsScenario(browser, forge);
});
