/**
 * `#/replay/<matchId>` plays a finished real match back — wave 77 §B
 * (`docs/planning/wave77-2026-10-27.md`). A real two-human match starts on a scenario board (three
 * lands a side, so the comparison is never over empty zones), ends by concede, and the replay's
 * final board must hold the same cards per zone as both live seats' boards did when it ended.
 * `w81-replay.spec.ts` plays a whole game back; this is the short one.
 *
 * `[fp-replay]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

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

    // Both live boards' final battlefield/graveyard counts, read straight off
    // each seat's DOM — the replay must show the same as both.
    const counts = async (page: Page): Promise<{ battlefield: number; graveyards: number }> => ({
      battlefield: await page.locator('[data-zone="battlefield"] [data-card-id]').count(),
      graveyards: await page.locator('[data-zone="graveyard"] [data-card-id]').count(),
    });
    const live = await counts(alice.page);
    expect(await counts(bob.page), 'both seats ended on the same table').toEqual(live);
    console.log(`[fp-replay] match ${matchId} ended: ${JSON.stringify(live)} on both seats`);
    expect(live.battlefield, 'the scenario put lands on the table: the comparison below is not over nothing').toBeGreaterThan(0);

    const carol = await openFriend(browser, 'carol');
    await carol.page.goto(`${stack.origin}${PREFIX}/#/replay/${matchId}`);

    const bar = carol.page.getByTestId('replay-bar');
    await expect(bar, 'the transport bar').toBeVisible({ timeout: 15_000 });

    // Let it play to the end (or scrub there), then compare.
    await carol.page.getByTestId('replay-bar-speed-4').click();
    await expect
      .poll(async () => carol.page.getByTestId('game-result').isVisible(), { timeout: 60_000, message: 'the replay reaches the same ending' })
      .toBe(true);
    expect(await counts(carol.page), 'the same table both seats had at the end').toEqual(live);
  } finally {
    await stack.stop();
  }
});
