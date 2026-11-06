/**
 * A deploy's restart, as two players at a real Forge match feel it.
 *
 * The operator, 2026-11-05, after a release dropped their match into "Reconnecting":
 * *"surely with multiple active claws my game should be playable even during releases?"*
 *
 * Turn 1, Alice's main phase, both screens live. The server restarts as a deploy restarts it
 * (the edge stand-in stays up). From the moment the new server answers its health check, each
 * screen must be live again within `BACK_WITHIN_MS`. socket.io's default backoff (1 s doubling
 * to 5 s) let a screen sit out up to five seconds after the server was already back; the sockets
 * now retry every quarter second, at most a second apart (`apps/ui/src/draft/socket.ts`). Then
 * the match goes on: Alice plays a land and Bob sees it.
 *
 * `[wzd]` lines are the evidence: each screen's lag from the server's health to its live board.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test
 * SKIPS and its title says why. Serves the prebuilt `apps/ui/dist`: rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, handCardNamed, makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The longest reconnect delay (1 s) plus a handshake and a rejoin on a loaded claw. */
const BACK_WITHIN_MS = 2_500;

const battlefieldLands = (page: Page, whose: 'mine' | 'theirs') =>
  page.locator(`.seat${whose === 'mine' ? '[data-viewer]' : ':not([data-viewer])'} [data-zone="battlefield"] [data-board-card]`);

/** Wall-clock time this page's status line last went away, polled from inside the page. */
async function watchBack(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __wzdBack: number | null; __wzdGone: boolean };
    w.__wzdBack = null;
    w.__wzdGone = false;
    const look = (): void => {
      const shown = document.querySelector('[data-testid="live-status"]') !== null;
      if (shown) {
        w.__wzdGone = true;
        w.__wzdBack = null;
      } else if (w.__wzdGone && w.__wzdBack === null) {
        w.__wzdBack = Date.now();
      }
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true });
  });
}

const backAt = (page: Page): Promise<{ dropped: boolean; back: number | null }> =>
  page.evaluate(() => {
    const w = window as unknown as { __wzdBack: number | null; __wzdGone: boolean };
    return { dropped: w.__wzdGone, back: w.__wzdBack };
  });

test(titled('a restart mid-turn: both screens are live within 2.5 s of the server answering, and the turn goes on'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'rt-restart-turn');
    for (const page of [alice.page, bob.page]) {
      await expect(page.getByTestId('live-status'), 'live before the restart').toHaveCount(0, { timeout: 30_000 });
      await watchBack(page);
    }

    await stack.restart();
    const healthyAt = Date.now();

    for (const [name, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      await expect.poll(async () => (await backAt(page)).back, { timeout: 30_000, message: `${name} is live again after the restart` }).not.toBeNull();
      const { dropped, back } = await backAt(page);
      const lag = back! - healthyAt;
      console.log(`[wzd] ${name}: dropped=${dropped} live ${lag} ms after the new server's health`);
      expect(dropped, `${name}: the restart dropped the socket`).toBe(true);
      expect(lag, `${name}: live within ${BACK_WITHIN_MS} ms of the server answering`).toBeLessThanOrEqual(BACK_WITHIN_MS);
    }

    // The match goes on: Alice's turn, her land, on both screens.
    const forest = await handCardNamed(alice.page, 'Forest');
    expect(forest, 'Alice still holds her Forest').toBeDefined();
    await clickHandCard(alice.page, forest!);
    await expect(battlefieldLands(alice.page, 'mine'), 'the Forest on her battlefield').toHaveCount(1, { timeout: 15_000 });
    await expect(battlefieldLands(bob.page, 'theirs'), "and on Bob's screen").toHaveCount(1, { timeout: 15_000 });
  } finally {
    await stack.stop();
  }
});
