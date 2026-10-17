/**
 * The operator, 2026-10-17 ~09:50Z: *"my room was just closed? did that happen
 * from a redeploy? 'This match is no longer running on the server — it ended
 * when the server restarted or when Forge stopped. Nothing you did caused it.
 * Start a new match to play again.'"*
 *
 * Prod m-e055472e0d6e had FINISHED — both players were on its result screen —
 * when a deploy restarted the server. A finished match was not handed to the
 * next process, so its Forge was reaped and the reconnecting join was answered
 * `match-gone`.
 *
 * Two real browsers, a real Forge match: bob concedes, both see the result
 * screen, the server restarts. Both screens must come back to the result
 * screen — not the "no longer running" page — and so must a reload, with the
 * way back to the room still offered. `[rs]` lines are the evidence.
 */
import { expect, test } from '@playwright/test';

import { makeTitled, serverLog } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { enterMatch } from './play/enter.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('a deploy after the game ended keeps both result screens, and a reload still finds it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { matchId } = await enterMatch(alice, bob, stack.origin);

    await bob.page.getByTestId('live-concede').click();
    await bob.page.getByTestId('live-concede-yes').click();
    for (const f of [alice, bob]) await expect(f.page.getByTestId('game-result'), `${f.name}'s result screen`).toBeVisible({ timeout: 45_000 });

    const before = serverLog(stack).length;
    await stack.restart();
    const since = () => serverLog(stack).slice(before);
    const answered = () => since().filter((r) => r.matchId === matchId && (r.evt === 'joined' || r.evt === 'match-gone'));
    await expect.poll(() => answered().length, { message: 'both screens rejoined after the deploy', timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    const shutdown = since().find((r) => r.evt === 'shutdown-matches');
    console.log(`[rs] deploy after game over: shutdown ${JSON.stringify(shutdown ?? null)}; answers ${JSON.stringify(answered().map((r) => r.evt))}`);

    for (const f of [alice, bob]) {
      await expect(f.page.getByTestId('game-result'), `${f.name}'s result screen after the deploy`).toBeVisible({ timeout: 30_000 });
      await expect(f.page.getByTestId('live-gone'), `${f.name} is not told the match is gone`).toHaveCount(0);
    }

    await alice.page.reload();
    await expect(alice.page.getByTestId('game-result'), "alice's result screen after a reload").toBeVisible({ timeout: 45_000 });
    await expect(alice.page.getByTestId('game-result-room'), 'the way back to the room').toBeEnabled({ timeout: 15_000 });
    const gone = since().filter((r) => r.evt === 'match-gone');
    console.log(`[rs] after the reload: match-gone lines ${gone.length}; alice at ${alice.page.url().split('#')[1]}`);
    expect(gone, 'no seat was told the match is gone').toEqual([]);
  } finally {
    await stack.stop();
  }
});
