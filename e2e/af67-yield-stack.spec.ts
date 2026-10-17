/**
 * The operator, 2026-10-14: *"auto-yield should work even for things already on the stack."*
 *
 * Auto Yield passes every priority window on the opponent's turn — including the one already
 * open over their spell when it is pressed — and it does so under Full Control too: pressing it is
 * the seat saying so for this turn. The operator's match: Full Control on, a stack item held, Auto
 * Yield pressed, and every later window of that turn still came to the bar.
 *
 * Two real browsers, `w63-yield.state`: bob's Main 1 with two Lightning Bolts and two Mountains;
 * alice holds Counterspell with two Islands and turns Full Control on. Bob bolts her; she holds
 * priority over the Bolt, presses Auto Yield, and never presses OK: the Bolt resolves, and bob's
 * second Bolt never reaches her bar.
 *
 * Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { castUntilOnStack, makeTitled, offeredNamed, serverLog, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const endTurnSlot = (page: Page): Locator => page.getByTestId('live-button-end-turn');
const opponentFace = (page: Page): Locator => page.locator('[data-player-face]:not([data-viewer])');
const ownLife = (page: Page): Locator => page.locator('.seat[data-viewer] [data-testid="life"]');
const decisionOk = (page: Page): Locator => page.locator('[data-testid="live-decision-ok"]:enabled');

/** Bob bolts alice: the offered Bolt, then her face, until it is cast. */
async function bobBolts(bob: Page, stack: { serverLogFile: string }): Promise<void> {
  let bolt: number | undefined;
  await expect.poll(async () => (bolt = await offeredNamed(bob, 'Lightning Bolt')), { timeout: 45_000, message: 'bob is offered Lightning Bolt' }).not.toBeUndefined();
  await castUntilOnStack(bob, stack, bolt!, [opponentFace(bob)]);
}

test(titled("under Full Control, Auto Yield pressed over bob's Bolt passes that window and every later one in his turn"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w63-yield');
    const a = alice.page;
    await a.getByTestId('live-full-control').click();
    await expect(a.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    await expect(endTurnSlot(a), "it is bob's turn: the slot reads Auto Yield").toHaveText('Auto Yield');

    // Bob's first Bolt: alice, in Full Control, holds priority over it.
    await bobBolts(bob.page, stack);
    await expect
      .poll(async () => (await stackCount(a)) === 1 && (await decisionOk(a).count()) === 1, { timeout: 30_000, message: "alice holds priority over bob's Bolt" })
      .toBe(true);

    const logFrom = serverLog(stack).length;
    await endTurnSlot(a).click();
    await expect(endTurnSlot(a), 'Cancel Yield').toHaveText('Cancel Yield');
    // Nobody presses alice's OK from here.
    await expect(ownLife(a), 'the Bolt already on the stack resolved with no OK from alice').toHaveText('17', { timeout: 20_000 });

    // Bob's second Bolt, same turn: never on alice's bar.
    const hit = async (): Promise<boolean> => (await ownLife(a).textContent()) === '14';
    await bobBolts(bob.page, stack);
    let aliceBarLive = false;
    const resolvedBy = Date.now() + 30_000;
    while (!(await hit()) && Date.now() < resolvedBy) {
      if ((await decisionOk(a).count()) > 0) aliceBarLive = true;
      await a.waitForTimeout(40);
    }
    const after = serverLog(stack).slice(logFrom).filter((r) => r.seat === 0);
    const yielded = after.filter((r) => r.evt === 'auto-passed' && r.why === 'auto-yield').map((r) => String(r.phase));
    const forwarded = after.filter((r) => r.evt === 'prompt-forwarded').map((r) => `${String(r.kind)} ${String(r.rule)}`);
    console.log(`[af67] yielded [${yielded.join(', ')}]; forwarded after the press [${forwarded.join(', ')}]; bar live on the 2nd Bolt ${aliceBarLive}`);
    expect(aliceBarLive, "alice's bar never enabled for bob's second Bolt").toBe(false);
    await expect(ownLife(a), 'and it hit alice').toHaveText('14', { timeout: 15_000 });
    expect(yielded.length, 'the windows were passed for the yield, the open one included').toBeGreaterThanOrEqual(2);
    expect(forwarded.filter((f) => f.startsWith('priority')), 'no priority window reached alice while she yields').toEqual([]);
  } finally {
    await stack.stop();
  }
});
