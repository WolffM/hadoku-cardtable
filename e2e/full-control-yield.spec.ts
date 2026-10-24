/*
 * Bob holds Full Control in alice's own Main 1 (`own-spell`): what each screen says about waiting.
 *
 * Her spell. The operator, 2026-10-09: "if i'm waiting on my opponent to respond to 'Resolve Cranial
 * Plating?' then there should at least be some kind of waiting indicator for me. all i see is my card
 * flashing". Bob holds priority over alice's Memnite on the stack: alice's screen says she is waiting
 * on his response, and stops saying it the moment he passes. A priority hold with an EMPTY stack stays
 * quiet (the operator, 2026-10-08: not "simply when waiting on them").
 *
 * Her End Turn. The operator, 2026-10-11: *"1. i set one side to full control. 2. otherside presses
 * end turn. 3. on full control side i see 'Waiting for Hadoku to decide…' but on Hadoku's side, there
 * is nothing since they clicked end turn? so whats going on?"* Forge shows alice its yield ("Yielding
 * until end of turn. …", Cancel live) — nothing for her to decide, so her screen draws nothing — and
 * hands bob priority at every step left in her turn. Bob holds a live bar of his own the whole time:
 * he is never told to wait for alice.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, makeTitled, nextPhaseLive, offeredNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const nextPhase = (page: Page) => nextPhaseLive(page);
const waitingPop = (page: Page) => page.getByTestId('live-waiting-pop');
const decisionPop = (page: Page) => page.getByTestId('live-decision-host');

test(titled('bob holds full control: while he holds priority over her spell alice reads that she waits on his response, not before, not after; when she ends her turn he holds his own bar and is never told to wait for her, and she sees nothing'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'own-spell');
    await bob.page.getByTestId('live-full-control').click();
    await expect(bob.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    const pop = waitingPop(alice.page);

    let memnite: number | undefined;
    await expect.poll(async () => (memnite = await offeredNamed(alice.page, 'Memnite')), { timeout: 60_000, message: 'alice is offered Memnite' }).not.toBeUndefined();
    await expect(pop, 'nothing to wait on before the cast').toHaveCount(0);
    await clickHandCard(alice.page, memnite!);

    // Bob holds: Memnite is on the stack and his bar is live.
    const bobOk = bob.page.locator('[data-testid="live-decision-ok"]:enabled');
    await expect(bobOk, 'bob holds priority over Memnite').toHaveCount(1, { timeout: 30_000 });
    await expect(pop, 'alice is told she waits on his response').toBeVisible({ timeout: 5_000 });
    const sentence = (await pop.textContent()) ?? '';
    console.log(`[respond-wait] alice reads "${sentence}"`);
    expect(sentence).toMatch(/respond/i);
    expect(sentence).toContain('Memnite');

    await bobOk.click();
    await expect(pop, 'gone once he passes').toHaveCount(0, { timeout: 10_000 });

    const endTurn = alice.page.getByTestId('live-button-end-turn');
    await expect(endTurn, "alice's own End Turn, back at her Main 1").toBeEnabled({ timeout: 60_000 });
    await endTurn.click();

    // Forge hands bob priority in alice's Main 1: his bar is live, and for as long as it is (sampled
    // well past the server's 150 ms grace on a waiting fact) bob reads no waiting sentence and alice
    // no pop-up of any kind.
    await expect(nextPhase(bob.page), 'bob holds priority in alice’s turn').toHaveCount(1, { timeout: 20_000 });
    for (let i = 0; i < 30; i++) {
      const bobPop = (await waitingPop(bob.page).count()) > 0 ? await waitingPop(bob.page).textContent() : null;
      const alicePop = (await waitingPop(alice.page).count()) > 0 ? await waitingPop(alice.page).textContent() : null;
      const aliceDecision = await decisionPop(alice.page).count();
      const bobLive = (await nextPhase(bob.page).count()) > 0;
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
