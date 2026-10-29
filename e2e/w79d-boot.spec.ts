/**
 * The operator, reviewing the trailer (2026-10-28): *"5. theres a brief transition between sitting
 * down and playing that looks ugly? seems like a loading screen. this is probably a site defect."*
 *
 * Measured from the footage (session e1): after both Ready, the page showed a blank "Connecting…"
 * view for about a second, then the coin toss on an empty board, then the hand and Keep/Mulligan.
 *
 * Two real browsers, a real Forge match, production's pacing (Fast Mode off). Both seat a deck in
 * a room; from bob's Ready on, every animation frame and every DOM change on each page is recorded:
 * whether the room is drawn, whether the board is drawn, and the status line. The walk from Ready
 * to the board may show the room, then the board, and nothing in between — no frame that is
 * neither.
 *
 * `[w79d-boot]` lines are the evidence: each page's timeline, one entry per change.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { confirmYes } from './play/confirm.ts';
import { seatBoth } from './play/enter.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { setPlayFastModeDefault } from './prefsLocal.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Seen {
  at: number;
  room: boolean;
  board: boolean;
  status: string | null;
  route: string;
  /** What is mounted where the board goes: the match screen (`match`), its live root (`live`), neither (`-`). */
  shell: string;
}

/** Records, on every page this context opens, each change in what the page is showing. */
async function record(f: Friend): Promise<void> {
  await f.context.addInitScript(() => {
    type Seen = { at: number; room: boolean; board: boolean; status: string | null; route: string; shell: string };
    const w = window as unknown as { __boot: Seen[] };
    w.__boot = [];
    let last = '';
    const look = (): void => {
      const seen: Seen = {
        at: Math.round(performance.now()),
        room: document.querySelector('[data-testid="constructed"], [data-testid="table-page"]') !== null,
        board: document.querySelector('[aria-label="Game board"]') !== null,
        status: document.querySelector('[data-testid="live-status"]')?.getAttribute('data-status') ?? null,
        route: location.hash.replace(/[0-9a-f]{12}/, '…'),
        shell: document.querySelector('.live') !== null ? 'live' : document.querySelector('[data-testid="match"]') !== null ? 'match' : '-',
      };
      const key = `${seen.room}|${seen.board}|${seen.status}|${seen.route}|${seen.shell}`;
      if (key === last) return;
      last = key;
      w.__boot.push(seen);
    };
    const frame = (): void => {
      look();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}

const timeline = (page: Page): Promise<Seen[]> => page.evaluate(() => (window as unknown as { __boot: Seen[] }).__boot);

const line = (list: Seen[]): string =>
  list.map((s) => `${s.at}ms:${s.route}[${s.shell}]${s.room ? '+room' : ''}${s.board ? '+board' : ''}${s.status === null ? '' : `(${s.status})`}`).join(' ');

test(titled('from both Ready to the board, no frame shows neither the room nor the board'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    for (const f of [alice, bob]) {
      await setPlayFastModeDefault(f.context, false);
      await record(f);
    }
    await seatBoth(alice, bob, stack.origin);
    const from = await Promise.all([alice, bob].map((f) => f.page.evaluate(() => Math.round(performance.now()))));
    await bob.page.getByTestId('ready-toggle').click();

    // The walk ends at the opening decision: the coin winner's Play/Draw, then Keep/Mulligan.
    await expect
      .poll(async () => (await alice.page.getByTestId('live-play-or-draw-play').count()) + (await bob.page.getByTestId('live-play-or-draw-play').count()), {
        timeout: 60_000,
        message: 'the coin winner is asked to play or draw',
      })
      .toBe(1);
    const winner = (await alice.page.getByTestId('live-play-or-draw-play').count()) > 0 ? alice : bob;
    await winner.page.getByTestId('live-play-or-draw-play').click();
    await expect
      .poll(async () => (await confirmYes(alice.page).count()) + (await confirmYes(bob.page).count()), { timeout: 30_000, message: 'Keep/Mulligan is open' })
      .toBeGreaterThan(0);

    const failures: string[] = [];
    for (const [i, f] of [alice, bob].entries()) {
      const all = await timeline(f.page);
      // What was on the screen at the press, and every change after it.
      const before = all.filter((s) => s.at < from[i]!).at(-1);
      const list = [...(before === undefined ? [] : [before]), ...all.filter((s) => s.at >= from[i]!)];
      console.log(`[w79d-boot] ${f.name}: ${line(list)}`);
      const neither = list.filter((s) => !s.room && !s.board);
      if (neither.length > 0) failures.push(`${f.name}: ${line(neither)}`);
      expect(list.some((s) => s.board), `${f.name} reached the board`).toBe(true);
    }
    expect(failures, 'frames between Ready and the board that show neither the room nor the board').toEqual([]);
  } finally {
    await stack.stop();
  }
});
