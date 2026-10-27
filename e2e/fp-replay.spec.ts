/**
 * `#/replay/<matchId>` plays a finished real match back — wave 77 §B
 * (`docs/planning/wave77-2026-10-27.md`). A short real two-human match ends
 * by concede, and the replay's final board must hold the same cards per zone
 * as the live board did when it ended.
 *
 * **Expected RED until lane C lands `GET /api/replays/:matchId`**
 * (`apps/server/src/http/replays.ts`, contract 2 of the wave file) — this
 * worktree does not have that route, so the request does not 404 at all: the
 * server's SPA fallback (`App.tsx`'s own header, "a server that SPA-falls-back
 * every path") answers `index.html`, 200 OK, same as any unknown path. The
 * client reads that as "not a replay" (confirmed against a real run,
 * 2026-10-27) and `ReplayScreen` shows that message rather than a board —
 * the client behaving correctly against a server that has not shipped the
 * route yet, not a bug in this spec or in `ReplayScreen`/`replayTransport.ts`:
 * both are proven against a hand-built fixture in `apps/ui/src/replay/*.test.ts`.
 * Once C's route lands and this worktree rebases onto it, this spec should
 * pass unchanged.
 *
 * `[fp-replay]` lines are the evidence.
 */
import { expect, test } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { makeTitled } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { enterMatch } from './play/enter.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('a finished match replays to the same final board, zone by zone'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { matchId } = await enterMatch(alice, bob, stack.origin);

    // End the match quickly: bob concedes.
    await bob.page.getByTestId('live-concede').click();
    await bob.page.getByTestId('live-concede-yes').click();
    await expect(alice.page.getByTestId('game-result'), 'alice sees the result').toBeVisible({ timeout: 30_000 });

    // The live board's final hand/battlefield/graveyard counts, read straight
    // off alice's DOM — the replay must show the same.
    const liveBattlefield = await alice.page.locator('[data-zone="battlefield"] [data-card-id]').count();
    const liveGraveyards = await alice.page.locator('[data-zone="graveyard"] [data-card-id]').count();
    console.log(`[fp-replay] match ${matchId} ended: battlefield=${liveBattlefield} graveyards=${liveGraveyards}`);

    const carol = await openFriend(browser, 'carol');
    await carol.page.goto(`${stack.origin}${PREFIX}/#/replay/${matchId}`);

    const bar = carol.page.getByTestId('replay-bar');
    const barAppeared = await bar.isVisible({ timeout: 15_000 }).catch(() => false);
    if (!barAppeared) {
      const errorText = await carol.page.locator('p').last().textContent().catch(() => null);
      console.log(`[fp-replay] RED, as expected without lane C's route: transport bar never appeared (error shown: ${JSON.stringify(errorText)})`);
    }
    await expect(bar, 'the transport bar (blocked on lane C\'s GET /api/replays/:matchId — see this file\'s header)').toBeVisible({ timeout: 15_000 });

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
