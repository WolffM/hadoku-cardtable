/**
 * The operator, 2026-10-11: *"1. i set one side to full control. 2. otherside presses end turn.
 * 3. on full control side i see 'Waiting for Hadoku to decide…' but on Hadoku's side, there is
 * nothing since they clicked end turn? so whats going on?"*
 *
 * Two real browsers, `own-spell`: alice's own Main 1. Bob takes Full Control, alice presses End
 * Turn. Forge shows alice its yield ("Yielding until end of turn. …", Cancel live) — nothing for her
 * to decide, so her screen draws nothing — and hands bob priority at every step left in her turn.
 * Bob holds a live bar of his own the whole time: he is never told to wait for alice.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const nextPhase = (page: Page) => page.getByTestId('live-button-next-phase');
const waitingPop = (page: Page) => page.getByTestId('live-waiting-pop');
const decisionPop = (page: Page) => page.getByTestId('live-decision-host');

test(titled('alice ends her turn while bob holds full control: bob holds his own bar and is never told to wait for her; alice sees nothing'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'own-spell');
    await bob.page.getByTestId('live-full-control').click();
    await expect(bob.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');

    const endTurn = alice.page.getByTestId('live-button-end-turn');
    await expect(endTurn, "alice's own End Turn, at her Main 1").toBeEnabled({ timeout: 60_000 });
    await endTurn.click();

    // Forge hands bob priority in alice's Main 1: his bar is live, and for as long as it is (sampled
    // well past the server's 150 ms grace on a waiting fact) bob reads no waiting sentence and alice
    // no pop-up of any kind.
    await expect(nextPhase(bob.page), 'bob holds priority in alice’s turn').toBeEnabled({ timeout: 20_000 });
    for (let i = 0; i < 30; i++) {
      const bobPop = (await waitingPop(bob.page).count()) > 0 ? await waitingPop(bob.page).textContent() : null;
      const alicePop = (await waitingPop(alice.page).count()) > 0 ? await waitingPop(alice.page).textContent() : null;
      const aliceDecision = await decisionPop(alice.page).count();
      const bobLive = await nextPhase(bob.page).isEnabled();
      if (i === 0 || i === 29 || bobPop !== null || alicePop !== null || aliceDecision > 0) {
        console.log(`[fc-yield] sample ${i}: bob bar live ${bobLive}, bob waiting-pop ${JSON.stringify(bobPop)}, alice waiting-pop ${JSON.stringify(alicePop)}, alice decision ${aliceDecision}`);
      }
      expect(bobLive, 'bob still holds his own live bar').toBe(true);
      expect(bobPop, 'bob holds his own live bar — he is never told to wait for alice').toBeNull();
      expect(alicePop, 'alice yielded: nothing to wait on').toBeNull();
      expect(aliceDecision, 'alice yielded: no pop-up of her own').toBe(0);
      await bob.page.waitForTimeout(100);
    }
  } finally {
    await stack.stop();
  }
});
