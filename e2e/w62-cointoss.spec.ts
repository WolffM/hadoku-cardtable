/*
 * AE17 — the operator, three times (R2, W1, 2026-10-08): "both players should
 * see the coinflip". Forge tosses and asks only the winner; the server tells
 * both seats (`forge:seats`' `coinToss`), and both screens draw the coin
 * landing on the winner's face — the loser instead of "Waiting for {name}…",
 * the winner beside their own Play/Draw question. Two real browsers, a real
 * Forge match, the same second.
 */
import { expect, test, type Page } from '@playwright/test';

import { enterMatch, makeTitled } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { confirmYes } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const coin = (p: Page) => p.getByTestId('coin-toss');
const waitingPop = (p: Page) => p.getByTestId('live-waiting-pop');
const playOrDraw = (p: Page) => p.getByTestId('live-play-or-draw-play');

test(titled('the coin toss lands on the winner’s face on BOTH screens, the same second, before any choice'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice: Friend = await openFriend(browser, 'alice');
    const bob: Friend = await openFriend(browser, 'bob');
    await enterMatch(alice, bob, stack.origin);

    // Both screens show the coin — record when each first saw it.
    const seen: Record<string, number> = {};
    await expect
      .poll(
        async () => {
          for (const f of [alice, bob]) {
            if (seen[f.name] === undefined && (await coin(f.page).count()) > 0) seen[f.name] = Date.now();
          }
          return Object.keys(seen).length;
        },
        { timeout: 45_000, message: 'both screens draw the coin toss' },
      )
      .toBe(2);
    const winnerA = await coin(alice.page).getAttribute('data-winner');
    const winnerB = await coin(bob.page).getAttribute('data-winner');
    expect(winnerA, 'both screens name the same winner').toBe(winnerB);
    const gap = Math.abs((seen['alice'] ?? 0) - (seen['bob'] ?? 0));
    console.log(`[cointoss] alice t=${seen['alice']} bob t=${seen['bob']} winner=${winnerA} gap=${gap}ms`);
    expect(gap, 'the same second on both screens').toBeLessThan(1000);

    const winner = (await playOrDraw(alice.page).count()) > 0 ? alice : bob;
    const loser = winner === alice ? bob : alice;
    await expect(playOrDraw(winner.page), `${winner.name}: the Play/Draw question, beside the coin`).toBeVisible();
    // The loser sees the coin, never the sentence, while it is up.
    await expect(waitingPop(loser.page), `${loser.name}: no "Waiting for…" while the coin is up`).toHaveCount(0);
    const name = await coin(loser.page).locator('.coin-toss__name').textContent();
    console.log(`[cointoss] ${loser.name} sees the coin landed on "${name}"`);
    // The board's display name ("e2e-alice") carries the friend's short name.
    expect(name, 'the coin carries the winner’s name').toContain(winner.name);
    // The flip settles.
    await expect(coin(loser.page), 'the coin lands').not.toHaveAttribute('data-flipping', '', { timeout: 5_000 });
    // Landed: the loser reads whose choice it waits on; the winner, who is choosing, never does.
    const wait = loser.page.getByTestId('coin-toss-wait');
    await expect(wait, `${loser.name}: the winner is choosing`).toBeVisible();
    await expect(wait).toContainText(winner.name);
    await expect(wait).toContainText('is choosing to play or draw');
    await expect(winner.page.getByTestId('coin-toss-wait'), `${winner.name}: never told to wait on themself`).toHaveCount(0);
    console.log(`[cointoss] ${loser.name} reads "${await wait.textContent()}"`);

    await playOrDraw(winner.page).click();
    // Withdrawn on both screens once the winner answers; the match goes on to the opening mulligan.
    await expect(coin(winner.page)).toHaveCount(0, { timeout: 10_000 });
    await expect(coin(loser.page)).toHaveCount(0, { timeout: 10_000 });
    await expect
      .poll(async () => (await confirmYes(winner.page).count()) + (await confirmYes(loser.page).count()), {
        timeout: 30_000,
        message: 'the opening Keep/Mulligan follows',
      })
      .toBeGreaterThan(0);
  } finally {
    await stack.stop();
  }
});
