/**
 * A player who loses to their draw is told it was the draw, against real Forge.
 *
 * The operator, 2026-10-14, after his Dredge deck lost: *"'Hadoku — an empty library' but my draw step
 * was replaced by dredge. i dont undersatnd why i lost this game."* The match log (m-98e9ea85d1bf): the
 * opponent's Brain Freeze and its storm copies milled his whole library; at his next draw step Forge
 * offered no dredge — Dredge N needs at least N cards in the library — so the draw happened from an
 * empty library and lost him the game. The result screen guessed the reason from the board and named a
 * zone ("an empty library") rather than what happened.
 *
 * `af63-decked.state`: alice has no library and Golgari Thug (Dredge 4) in her graveyard, at bob's
 * main phase. Both seats pass; bob's turn ends and alice's draw step loses her the game. Her screen and bob's must:
 * - say the reason Forge decided (`PlayerOutcome.lossState` = `Milled`): she had to draw from an empty library;
 * - and Forge must not have offered her the dredge (it cannot: her library has fewer than 4 cards).
 *
 * `[af63]` lines are the evidence: each screen's result text, and the game-over line the server logged.
 */
import { expect, test } from '@playwright/test';

import { enabledOk, makeTitled, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled("a draw from an empty library: both result screens say Alice had to draw from an empty library, and Forge offered no dredge"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'af63-decked');
    const { alice, bob } = seated;
    const aliceResult = alice.page.getByTestId('game-result');
    const bobResult = bob.page.getByTestId('game-result');

    // Both seats pass whatever they are asked until the draw step ends the game.
    await expect
      .poll(
        async () => {
          if (await aliceResult.isVisible()) return true;
          for (const page of [alice.page, bob.page]) {
            const ok = enabledOk(page);
            if ((await ok.count()) > 0) await ok.click().catch(() => undefined);
          }
          return false;
        },
        { timeout: 90_000, message: "alice's draw step ends the game" },
      )
      .toBe(true);

    await expect(aliceResult).toHaveAttribute('data-result', 'defeat');
    await expect(bobResult).toBeVisible({ timeout: 30_000 });
    await expect(bobResult).toHaveAttribute('data-result', 'victory');
    const aliceText = (await aliceResult.locator('.live__result-ending').textContent()) ?? '';
    const bobText = (await bobResult.locator('.live__result-ending').textContent()) ?? '';
    const over = serverLog(stack).find((l) => l.evt === 'game-over');
    const asked = serverLog(stack).filter((l) => l.evt === 'prompt-forwarded' || l.evt === 'ask-answered' || l.evt === 'ask-auto-answered');
    console.log(`[af63] alice="${aliceText}" bob="${bobText}" game-over=${JSON.stringify(over)} asks=${JSON.stringify(asked.map((l) => [l.seat, l.kind ?? l.method, l.rule ?? l.why]))}`);

    expect(aliceText, "alice's screen says what lost her the game: the draw").toBe('Alice — had to draw from an empty library');
    expect(bobText, "bob's screen says the same").toBe('Alice — had to draw from an empty library');
    expect(
      asked.filter((l) => l.seat === 0 && l.kind === 'other'),
      'Forge asked alice no replacement question: dredge needs 4 cards in her library',
    ).toEqual([]);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
