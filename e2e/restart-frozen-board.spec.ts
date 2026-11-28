/**
 * What a seat sees through a server restart mid-round, timed from the seat's own page: the server
 * is replaced as a deploy replaces it (SIGTERM, its matches handed over, the next process on the same
 * dirs) while bob holds priority with a Lightning Bolt offered, and bob's board is sampled in the page
 * every 100 ms. The spec logs every status line bob was shown (`live-status`, by its `data-status`:
 * `updating`, `reconnecting`, …) and when, and how long until his
 * Bolt was offered to him again, and fails past `LIVE_AGAIN_MS`: the tournament runbook's restart
 * row quotes this number (pre-soak lane, 2026-11-28; PPE measured 5–8 s for a round's worth of
 * matches from the server's side, this is the board's side).
 *
 * `w63-yield.state`: bob's Main 1, two Lightning Bolts and two Mountains; alice holds Counterspell.
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test SKIPS and
 * its title says why. Serves the prebuilt `apps/ui/dist`: rebuild before running.
 */
import { expect, test } from '@playwright/test';

import { makeTitled, offeredNamed, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The longest a seat may wait, from the restart, for its board to offer it a play again. */
const LIVE_AGAIN_MS = 30_000;

test(titled("a restart mid-round: bob's board offers him his Bolt again within 30 s, and its status lines are logged"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { bob } = await startScenarioMatch(browser, stack, 'w63-yield');
    const b = bob.page;
    await expect.poll(() => offeredNamed(b, 'Lightning Bolt', 'hand'), { timeout: 45_000, message: 'bob is offered Lightning Bolt' }).not.toBeUndefined();

    // In the page, every 100 ms: the status line's state (null while none shows), and whether a card in bob's hand is offered.
    await b.evaluate(() => {
      const w = window as unknown as { __restartTimeline: { at: number; label: string | null; offered: boolean }[] };
      w.__restartTimeline = [];
      setInterval(() => {
        const line = document.querySelector('[data-testid="live-status"]');
        const label = line === null ? null : `${line.getAttribute('data-status') ?? ''}: ${line.textContent?.trim() ?? ''}`;
        const offered = document.querySelector('[data-zone="hand"][data-owner="you"] [data-board-card][data-selectable]') !== null;
        w.__restartTimeline.push({ at: Date.now(), label, offered });
      }, 100);
    });
    const before = serverLog(stack).length;
    const restartedAt = Date.now();
    await stack.restart();
    const serverBackMs = Date.now() - restartedAt;

    await expect.poll(() => offeredNamed(b, 'Lightning Bolt', 'hand'), { timeout: LIVE_AGAIN_MS, message: "bob's Bolt is offered again after the restart" }).not.toBeUndefined();
    const timeline = await b.evaluate(() => (window as unknown as { __restartTimeline: { at: number; label: string | null; offered: boolean }[] }).__restartTimeline);
    const after = timeline.filter((s) => s.at >= restartedAt);
    const firstDark = after.find((s) => !s.offered);
    const liveAgain = after.find((s) => firstDark !== undefined && s.at > firstDark.at && s.offered);
    const labels: { ms: number; label: string | null }[] = [];
    for (const s of after) if (labels.at(-1)?.label !== s.label) labels.push({ ms: s.at - restartedAt, label: s.label });
    const report = {
      serverBackMs,
      offerGoneMs: firstDark === undefined ? null : firstDark.at - restartedAt,
      offeredAgainMs: liveAgain === undefined ? null : liveAgain.at - restartedAt,
      frozenMs: firstDark === undefined || liveAgain === undefined ? null : liveAgain.at - firstDark.at,
      labels,
    };
    console.log(`[restart-frozen-board] ${JSON.stringify(report)}`);
    test.info().annotations.push({ type: 'restart-frozen-board', description: JSON.stringify(report) });

    expect(report.offeredAgainMs, 'bob was offered a play again, seen from his page').not.toBeNull();
    expect(report.offeredAgainMs!).toBeLessThan(LIVE_AGAIN_MS);
    expect(
      serverLog(stack)
        .slice(before)
        .filter((l) => l.evt === 'act-unanswered' || l.evt === 'match-failed'),
      'nothing went unanswered or failed across the restart',
    ).toEqual([]);
  } finally {
    await stack.stop();
  }
});
