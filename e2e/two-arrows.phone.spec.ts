/**
 * Portrait phone: one arrow at the target player, never two, for every player-targeting cast, by tap and by
 * finger drag. See `./two-arrows.ts`.
 */
import { test } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability } from './play/harness.ts';
import { PHONE } from './play/phone.ts';
import { twoArrowsScenario } from './two-arrows.ts';

test.use(PHONE);

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('a spell cast at a player, by tap or by finger drag, never draws two arrows at that player — phone'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  await twoArrowsScenario(browser, forge);
});
