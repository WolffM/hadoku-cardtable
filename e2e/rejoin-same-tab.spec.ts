/**
 * A playing tab whose connection is cut without a close is the player again the moment it reconnects.
 *
 * Match m-ca7bad04b715, 2026-10-28: the operator's socket was cut somewhere between browser and
 * server with no close reaching the server. socket.io reconnected 8 s later on a new socket, the
 * server still held the dead one as the seat's controller, and the board said "this seat is being
 * played in another window" for 21 s, until the dead socket's ping timed out and the new one was
 * promoted. A join now names its tab, and the same tab's join takes the seat back at once.
 *
 * The cut is made in the page's own WebSocket route: the page side is closed, and the side facing
 * the server is left open and silent — what the server saw in production. Needs a Forge build like
 * `play.spec.ts`; without one the test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist`: rebuild before running.
 */

import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

import { enterMatch, makeTitled, serverLog } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { confirmYes } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const playOrDraw = (page: Page) => page.getByTestId('live-play-or-draw-play');

/** Every socket.io WebSocket the page opens, passed through until `cut` closes the page's side of the open ones. */
async function cuttable(page: Page): Promise<{ cut: () => number }> {
  const open = new Set<WebSocketRoute>();
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    const server = ws.connectToServer();
    let cut = false;
    open.add(ws);
    ws.onMessage((message) => {
      if (!cut) server.send(message);
    });
    server.onMessage((message) => {
      if (!cut) ws.send(message);
    });
    // Handlers on both closes stop Playwright forwarding one side's close to the other: the
    // server is never told.
    ws.onClose(() => {
      cut = true;
      open.delete(ws);
    });
    server.onClose(() => {
      if (cut) return;
      open.delete(ws);
      void ws.close();
    });
  });
  return {
    cut: () => {
      const n = open.size;
      for (const ws of [...open]) void ws.close({ code: 4000, reason: 'cut' });
      return n;
    },
  };
}

/** Records, in the page, whether the board ever drew itself as a spectator from now on. */
async function watchForSpectator(page: Page): Promise<() => Promise<boolean>> {
  await page.evaluate(() => {
    const w = window as unknown as { __sawSpectator?: boolean };
    w.__sawSpectator = false;
    const look = () => {
      if (document.querySelector('[data-testid="live-spectator"], .live[data-spectator]') !== null) w.__sawSpectator = true;
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-spectator'] });
    look();
  });
  return () => page.evaluate(() => (window as unknown as { __sawSpectator?: boolean }).__sawSpectator === true);
}

/** Alice's own decision is open: the toss's play-or-draw, or her keep. Bob answers his own along the way. */
async function aliceIsAsked(alice: Friend, bob: Friend): Promise<void> {
  await expect
    .poll(
      async () => {
        if ((await playOrDraw(alice.page).count()) > 0 || (await confirmYes(alice.page).count()) > 0) return true;
        if ((await playOrDraw(bob.page).count()) > 0) await playOrDraw(bob.page).click();
        else if ((await confirmYes(bob.page).count()) > 0) await confirmYes(bob.page).click();
        return false;
      },
      { timeout: 60_000, intervals: [250], message: 'alice is asked something of her own' },
    )
    .toBe(true);
}

test(titled('a tab cut off without a close takes its seat straight back on reconnect, never shown as another window'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const link = await cuttable(alice.page);
    const { matchId } = await enterMatch(alice, bob, stack.origin);
    await aliceIsAsked(alice, bob);
    const sawSpectator = await watchForSpectator(alice.page);
    const mark = serverLog(stack).length;

    expect(link.cut(), 'the board’s socket was on a WebSocket to cut').toBeGreaterThan(0);
    const since = () => serverLog(stack).slice(mark).filter((l) => l.matchId === matchId);

    // The reconnect: the same tab, so the server hands the seat over and retires the dead socket.
    await expect
      .poll(() => since().filter((l) => l.evt === 'tab-rejoined').length, { timeout: 30_000, message: 'the server takes the reconnect as the same tab' })
      .toBe(1);
    const rejoined = since().find((l) => l.evt === 'tab-rejoined')!;
    expect(rejoined.role, 'the reconnect controls the seat at once').toBe('player');
    // The client says why it dropped and for how long.
    await expect
      .poll(() => since().filter((l) => l.evt === 'client' && l.kind === 'connection' && l.what === 'rejoined').length, { timeout: 15_000, message: 'the rejoin explains itself' })
      .toBe(1);
    const report = since().find((l) => l.evt === 'client' && l.kind === 'connection')!;
    expect(report.reason, 'socket.io’s reason for the cut').toBe('transport close');
    expect(typeof report.downMs).toBe('number');

    // It can act: alice answers her own question from the same tab.
    if ((await playOrDraw(alice.page).count()) > 0) {
      await playOrDraw(alice.page).click();
      await expect(playOrDraw(alice.page), 'the toss was answered').toHaveCount(0, { timeout: 30_000 });
    } else {
      await confirmYes(alice.page).click();
      await expect(confirmYes(alice.page), 'the keep was answered').toHaveCount(0, { timeout: 30_000 });
    }

    const lines = since();
    expect(lines.filter((l) => l.evt === 'c2s-spectator'), 'nothing alice sent was refused as a spectator’s').toEqual([]);
    expect(lines.filter((l) => l.evt === 'spectator-promoted'), 'no promotion: the seat was handed over, not waited for').toEqual([]);
    const left = lines.filter((l) => l.evt === 'left' && l.seat === rejoined.seat);
    expect(left.map((l) => l.reason), 'the dead socket was retired by the takeover, not by its ping timing out').toEqual(['server namespace disconnect']);
    expect(await sawSpectator(), 'the board never said this seat was played in another window').toBe(false);
  } finally {
    await stack.stop();
  }
});
