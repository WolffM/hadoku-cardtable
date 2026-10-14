/**
 * The operator, 2026-10-13: *"'Connecting...' when making a mulligan decision?
 * seems a bit weird."*
 *
 * The production log of that game (m-dc2c38ce76c0, 2026-10-14 00:25Z): seat 0
 * was asked Keep/Mulligan at 00:25:56, a deploy restarted the server at
 * 00:25:58 (the match was handed over and resumed), and the two sockets came
 * back at 00:26:07 and 00:26:09. For those ten seconds the board — already
 * drawn, a decision open on it — said "Connecting…": the word for a page that
 * has never reached the server, on a page that had and had lost it.
 *
 * Two real browsers, a real Forge match, production's pacing (Fast Mode off,
 * the default every player has). While the first Keep/Mulligan is open the
 * server restarts, as that deploy did. From the room page on, every change to
 * each page is recorded: the status line (`live-status`, its `data-status` and
 * words) and which opening decision is on the screen. Then both players keep.
 *
 * Once a board is drawn no screen may say "Connecting…"; the only line beside
 * an opening decision is the dropped connection's own, and the decision is
 * still answered once the socket is back.
 *
 * `[af27]` lines are the evidence: each page's status timeline.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { confirmYes } from './play/confirm.ts';
import { enterMatch } from './play/enter.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { setPlayFastModeDefault } from './prefsLocal.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Seen {
  at: number;
  status: string | null;
  text: string | null;
  board: boolean;
  decision: string | null;
}

/** Records, on every page this context opens, each change in the status line and the opening decision. */
async function record(f: Friend): Promise<void> {
  await f.context.addInitScript(() => {
    const w = window as unknown as { __af27: Seen[] };
    type Seen = { at: number; status: string | null; text: string | null; board: boolean; decision: string | null };
    w.__af27 = [];
    let last = '';
    const look = (): void => {
      const line = document.querySelector('[data-testid="live-status"]');
      const decision = document.querySelector('[data-testid="prompt-confirm-yes"]')
        ? 'keep-or-mulligan'
        : document.querySelector('[data-testid="live-play-or-draw-play"]')
          ? 'play-or-draw'
          : document.querySelector('[data-testid="coin-toss"]')
            ? 'coin'
            : null;
      const seen: Seen = {
        at: Math.round(performance.now()),
        status: line?.getAttribute('data-status') ?? null,
        text: line?.textContent ?? null,
        board: document.querySelector('[aria-label="Game board"]') !== null,
        decision,
      };
      const key = `${seen.status}|${seen.text}|${seen.board}|${seen.decision}`;
      if (key === last) return;
      last = key;
      w.__af27.push(seen);
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}

const timeline = (page: Page): Promise<Seen[]> => page.evaluate(() => (window as unknown as { __af27: Seen[] }).__af27);

const line = (list: Seen[]): string =>
  list.map((s) => `${s.at}ms:${s.status ?? '-'}${s.text === null ? '' : `("${s.text}")`}${s.board ? '+board' : ''}${s.decision === null ? '' : `+${s.decision}`}`).join(' ');

test(titled('no "Connecting…" while the opening Keep/Mulligan (or any opening decision) is on the screen'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    for (const f of [alice, bob]) {
      // Production's default: frames paced, as the operator plays.
      await setPlayFastModeDefault(f.context, false);
      await record(f);
    }
    await enterMatch(alice, bob, stack.origin);

    // The winner chooses; then both are asked Keep/Mulligan and both keep.
    await expect
      .poll(async () => (await alice.page.getByTestId('live-play-or-draw-play').count()) + (await bob.page.getByTestId('live-play-or-draw-play').count()), {
        timeout: 45_000,
        message: 'the coin winner is asked to play or draw',
      })
      .toBe(1);
    const winner = (await alice.page.getByTestId('live-play-or-draw-play').count()) > 0 ? alice : bob;
    await winner.page.getByTestId('live-play-or-draw-play').click();
    await expect
      .poll(async () => (await confirmYes(alice.page).count()) + (await confirmYes(bob.page).count()), {
        timeout: 30_000,
        message: 'the first Keep/Mulligan is open',
      })
      .toBeGreaterThan(0);
    // The deploy, while the question is open.
    await stack.restart();
    console.log('[af27] server restarted while Keep/Mulligan was open');
    for (const f of [alice, bob]) {
      await expect(f.page.getByTestId('live-status'), `${f.name} is back in the match after the restart`).toHaveCount(0, { timeout: 60_000 });
    }
    const kept = new Set<string>();
    await expect
      .poll(
        async () => {
          for (const f of [alice, bob]) {
            if (kept.has(f.name) || (await confirmYes(f.page).count()) === 0) continue;
            // A person reads the hand before answering.
            await f.page.waitForTimeout(1_500);
            await confirmYes(f.page).click({ timeout: 2_000 }).catch(() => undefined);
            if ((await confirmYes(f.page).count()) === 0) kept.add(f.name);
          }
          return kept.size;
        },
        { timeout: 60_000, message: 'both players are asked Keep/Mulligan and keep' },
      )
      .toBe(2);
    await alice.page.waitForTimeout(1_000);

    for (const f of [alice, bob]) {
      const list = await timeline(f.page);
      console.log(`[af27] ${f.name}: ${line(list)}`);
      const connectingOnBoard = list.filter((s) => s.board && s.status === 'connecting');
      const besideDecision = list.filter((s) => s.decision !== null && s.status !== null && s.status !== 'reconnecting');
      expect(connectingOnBoard.map((s) => `${s.at}ms:${s.text}`), `${f.name}: never "Connecting…" once the board is drawn`).toEqual([]);
      expect(besideDecision.map((s) => `${s.decision}:${s.text}`), `${f.name}: beside an opening decision, only the dropped connection's own line`).toEqual([]);
      expect(list.some((s) => s.board && s.status === 'reconnecting'), `${f.name}: the restart dropped the socket, and the board said so`).toBe(true);
    }
  } finally {
    await stack.stop();
  }
});
