/**
 * `#/replay/<matchId>` plays a finished real match back — wave 77 §B
 * (`docs/planning/wave77-2026-10-27.md`). A real two-human match starts on a scenario board (three
 * lands a side, so the comparison is never over empty zones), ends by concede, and the replay's
 * final board must hold the same cards per zone as the live board did when it ended.
 *
 * `[fp-replay]` lines are the evidence.
 */
import { expect, test } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { makeTitled } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('a finished match replays to the same final board, zone by zone'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob, matchId } = await startScenarioMatch(browser, stack, 'w67-outlines');

    // End the match quickly: bob concedes.
    await bob.page.getByTestId('live-concede').click();
    await bob.page.getByTestId('live-concede-yes').click();
    await expect(alice.page.getByTestId('game-result'), 'alice sees the result').toBeVisible({ timeout: 30_000 });

    // The live board's final hand/battlefield/graveyard counts, read straight
    // off alice's DOM — the replay must show the same.
    const liveBattlefield = await alice.page.locator('[data-zone="battlefield"] [data-card-id]').count();
    const liveGraveyards = await alice.page.locator('[data-zone="graveyard"] [data-card-id]').count();
    console.log(`[fp-replay] match ${matchId} ended: battlefield=${liveBattlefield} graveyards=${liveGraveyards}`);
    expect(liveBattlefield, 'the scenario put lands on the table: the comparison below is not over nothing').toBeGreaterThan(0);

    const carol = await openFriend(browser, 'carol');
    await carol.page.goto(`${stack.origin}${PREFIX}/#/replay/${matchId}`);

    const bar = carol.page.getByTestId('replay-bar');
    await expect(bar, 'the transport bar').toBeVisible({ timeout: 15_000 });

    // Let it play to the end (or scrub there), then compare.
    await carol.page.getByTestId('replay-bar-speed-4').click();
    await expect
      .poll(async () => carol.page.getByTestId('game-result').isVisible(), { timeout: 60_000, message: 'the replay reaches the same ending' })
      .toBe(true);
    const replayBattlefield = await carol.page.locator('[data-zone="battlefield"] [data-card-id]').count();
    const replayGraveyards = await carol.page.locator('[data-zone="graveyard"] [data-card-id]').count();
    expect(replayBattlefield, 'same battlefield count as the live board had at the end').toBe(liveBattlefield);
    expect(replayGraveyards, 'same graveyard count as the live board had at the end').toBe(liveGraveyards);
  } finally {
    await stack.stop();
  }
});
