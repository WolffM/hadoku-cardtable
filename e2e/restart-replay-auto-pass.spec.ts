/**
 * A restart spec the suite lacked: a server restart while a REPLAYED line would trigger an
 * auto-answer. A mutant that has `ForgeSession` keep its own always-false `replaying` flag,
 * instead of reading the shell's real one, survived every restart spec that existed before this
 * one, because none of them had an auto-passed window anywhere in their stream — ordinary
 * two-click gameplay never auto-passes. This one deliberately builds one (Full Control + Auto
 * Yield, `af67-yield-stack.spec.ts`'s own mechanism) before restarting, so the new server's replay
 * re-reads an ask line whose auto-answer the OLD server already sent once. Under that mutant,
 * `ForgeSession.command`'s replay gag reads its own (always-false) copy instead of the shell's
 * real one, and the auto-decider — re-run as the ask line replays — sends that same answer to
 * Forge a SECOND time, live, mid-replay.
 *
 * Modelled on `wzd-deploy-reconnect.spec.ts` (the restart itself) and `af67-yield-stack.spec.ts`
 * (the auto-pass). `w63-yield.state`: bob's Main 1, two Lightning Bolts and two Mountains; alice
 * holds Counterspell and two Islands.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test SKIPS
 * and its title says why. Serves the prebuilt `apps/ui/dist`: rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { castUntilOnStack, lifeOf, makeTitled, offeredNamed, serverLog, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { pressInMenu } from './play/phone.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The longest reconnect delay (1 s) plus a handshake and a rejoin on a loaded claw — `wzd-deploy-reconnect.spec.ts`'s own figure. */
const BACK_WITHIN_MS = 2_500;

const endTurnSlot = (page: Page) => page.getByTestId('live-button-end-turn');
const ownLife = (page: Page) => lifeOf(page, 'me');
const decisionOk = (page: Page) => page.locator('[data-testid="live-decision-ok"]:enabled');

/** Bob bolts alice: the offered Bolt, cast onto the stack targeting her face. */
async function bobBolts(bob: Page, stack: { serverLogFile: string }): Promise<void> {
  let bolt: number | undefined;
  await expect.poll(async () => (bolt = await offeredNamed(bob, 'Lightning Bolt')), { timeout: 45_000, message: 'bob is offered Lightning Bolt' }).not.toBeUndefined();
  await castUntilOnStack(bob, stack, bolt!, [bob.locator('[data-player-face]:not([data-viewer])')]);
}

/** Wall-clock time this page's status line last went away — `wzd-deploy-reconnect.spec.ts`'s own helper, unchanged. */
async function watchBack(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __rBack: number | null; __rGone: boolean };
    w.__rBack = null;
    w.__rGone = false;
    const look = (): void => {
      const shown = document.querySelector('[data-testid="live-status"]') !== null;
      if (shown) {
        w.__rGone = true;
        w.__rBack = null;
      } else if (w.__rGone && w.__rBack === null) {
        w.__rBack = Date.now();
      }
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true });
  });
}

const backAt = (page: Page): Promise<number | null> =>
  page.evaluate(() => (window as unknown as { __rBack: number | null }).__rBack);

test(titled('a restart replays an already-auto-passed window without sending Forge a second answer for it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w63-yield');
    const a = alice.page;

    /* ── build the auto-pass: Full Control, hold priority over bob's first Bolt, Auto Yield ── */
    await pressInMenu(a, 'live-full-control');
    await expect(a.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    await expect(endTurnSlot(a), "it is bob's turn: the slot reads Auto Yield").toHaveText('Auto Yield');

    await bobBolts(bob.page, stack);
    await expect
      .poll(async () => (await stackCount(a)) === 1 && (await decisionOk(a).count()) === 1, { timeout: 30_000, message: "alice holds priority over bob's Bolt" })
      .toBe(true);

    const logFrom = serverLog(stack).length;
    await pressInMenu(a, 'live-button-end-turn');
    await expect(endTurnSlot(a), 'Cancel Yield').toHaveText('Cancel Yield');
    // The Bolt already on the stack resolves with no OK from alice — the server auto-passed her
    // open window the instant Auto Yield was pressed. This IS the ask+auto-answer pair the restart
    // below will make the new server replay.
    await expect(ownLife(a), 'the Bolt already on the stack resolved with no OK from alice').toHaveText('17', { timeout: 20_000 });
    const beforeRestart = serverLog(stack).slice(logFrom);
    const autoPassed = beforeRestart.filter((l) => l.evt === 'auto-passed' && l.seat === 0);
    expect(autoPassed.length, 'the precondition: at least one auto-passed window is now in the stream to replay').toBeGreaterThan(0);

    /* ── the restart itself (`wzd-deploy-reconnect.spec.ts`'s own shape) ── */
    for (const page of [a, bob.page]) await watchBack(page);
    await stack.restart();
    const healthyAt = Date.now();
    for (const [name, page] of [['alice', a], ['bob', bob.page]] as const) {
      await expect.poll(async () => backAt(page), { timeout: 30_000, message: `${name} is live again after the restart` }).not.toBeNull();
      const lag = (await backAt(page))! - healthyAt;
      console.log(`[restart-auto-pass] ${name}: live ${lag} ms after the new server's health`);
      expect(lag, `${name}: live within ${BACK_WITHIN_MS} ms of the server answering`).toBeLessThanOrEqual(BACK_WITHIN_MS);
    }

    /* ── the claim: the replay sent no duplicate answer, and nothing about it failed ── */
    // Auto Yield's own setting is not carried by a plain restart (`MatchRecord` has no field for
    // it, unlike a snapshot-based `MatchRegistry.restore`), so this does not assume Bob's SECOND
    // Bolt is still auto-passed after reconnecting — only that the replay of the FIRST one, and
    // its already-sent auto-answer, caused nothing to go wrong on the way back up.
    const afterRestart = serverLog(stack);
    expect(afterRestart.find((l) => l.evt === 'match-failed'), 'the match never failed across the restart').toBeUndefined();
    expect(afterRestart.find((l) => l.evt === 'game-over-ignored'), 'no stray game-over from a duplicated line').toBeUndefined();
    expect(afterRestart.find((l) => l.evt === 'bridge-rejected'), "Forge never refused a command — exactly what a duplicated live send during replay would draw").toBeUndefined();

    // And the board itself, read back after reconnecting, is exactly as it was before the restart:
    // the Bolt resolved, nothing replayed it a second time.
    await expect(ownLife(a), "alice's life is still 17 — the Bolt was not somehow applied twice").toHaveText('17', { timeout: 15_000 });
    await expect(stackCount(a)).resolves.toBe(0);
  } finally {
    await stack.stop();
  }
});
