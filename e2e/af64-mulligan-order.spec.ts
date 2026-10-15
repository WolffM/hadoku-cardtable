/**
 * The London mulligan's bottom cards are ordered by their owner, against real Forge.
 *
 * The operator, 2026-10-14: *"choose order for cards at the bottom when mulliganing"*. Rule 103.5 puts
 * them on the bottom "in any order", but Forge's `PlayerControllerHuman.tuckCardsViaMulligan` took the
 * order of the clicks and never asked. With the fork's change it asks the same `order` question every
 * other move of several cards into a library asks ("Choose order of cards to put into the library",
 * closest to top first), and the board draws it with the ordinary ordering window.
 *
 * Alice mulligans twice and keeps, so she puts two cards back; she picks them on her hand, presses
 * OK, and the ordering window opens with exactly those two cards. She submits it and the match goes
 * on. Which card ends where is `apps/server/src/play/mulligan.jvm.test.ts`'s claim, read off the wire.
 *
 * The match is started like `startScenarioMatch` starts one, minus its keep-every-hand step: the
 * mulligan runs on the dealt hand before the scenario applies, which is all this needs.
 *
 * `[af64]` lines are the evidence. Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test, type Page } from '@playwright/test';

import { enabledOk, makeTitled, says } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { confirmNo, confirmYes } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { matchUrl, readScenario } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const PREFIX = '/cardtable';
const orderWindow = (page: Page) => page.locator('section[data-prompt="order"]');
const handCards = (page: Page) => page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]');

test(titled('a London mulligan that puts two cards back asks their order, in the ordinary ordering window'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  const alice = await openFriend(browser, 'alice');
  const bob = await openFriend(browser, 'bob');
  try {
    const res = await alice.context.request.post(`${stack.origin}${PREFIX}/api/play/matches`, {
      data: { opponent: 'human', decks: [null, null], names: ['Alice', 'Bob'], scenario: readScenario('order-drag-ponder') },
    });
    expect(res.status()).toBe(201);
    const { matchId } = (await res.json()) as { matchId: string };
    await alice.page.goto(matchUrl(stack.origin, matchId));
    await expect(alice.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 30_000 });
    await bob.page.goto(matchUrl(stack.origin, matchId));
    await expect(bob.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 30_000 });

    // Play first on whichever page is asked; bob keeps; alice mulligans twice, then keeps.
    let mulligans = 0;
    const answered = new Map<Page, string>();
    await expect
      .poll(
        async () => {
          for (const page of [alice.page, bob.page]) {
            const text = await says(page);
            const play = page.getByTestId('live-play-or-draw-play');
            if ((await play.count()) > 0) {
              await play.click().catch(() => undefined);
              continue;
            }
            if ((await confirmYes(page).count()) === 0 || !/keep your hand/i.test(text)) continue;
            // One answer per hand: a mulligan changes the hand, so key on it.
            const hand = (await handCards(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-board-card')))).join();
            if (answered.get(page) === hand) continue;
            answered.set(page, hand);
            if (page === alice.page && mulligans < 2) {
              mulligans++;
              await confirmNo(page).click().catch(() => undefined);
            } else {
              await confirmYes(page).click().catch(() => undefined);
            }
          }
          return (await alice.page.getByText(/return 2 card/i).count()) > 0;
        },
        { timeout: 90_000, intervals: [250], message: 'alice reaches the bottom pick for two cards' },
      )
      .toBe(true);

    const picked = await handCards(alice.page).evaluateAll((els) => els.slice(0, 2).map((e) => Number(e.getAttribute('data-board-card'))));
    for (const id of picked) await alice.page.locator(`[data-zone="hand"][data-owner="you"] [data-board-card="${id}"]`).click();
    await expect(enabledOk(alice.page), 'two picked: OK is live').toHaveCount(1, { timeout: 10_000 });
    await enabledOk(alice.page).click();

    const win = orderWindow(alice.page);
    await expect(win, 'the bottom cards are ordered by their owner').toBeVisible({ timeout: 20_000 });
    const rows = await win.locator('li[data-card-id]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card-id'))));
    console.log(`[af64] picked ${JSON.stringify(picked)} window ${JSON.stringify({ title: await win.locator('.prompt__title').textContent(), rows })}`);
    expect([...rows].sort(), 'the window holds exactly the two cards put back').toEqual([...picked].sort());
    await expect(orderWindow(bob.page), "bob is never asked alice's order").toHaveCount(0);

    // The window starts with both cards unplaced; a click places one (closest to top first), and
    // OK is live once every card is placed, as in every library-order window (`order-drag.spec.ts`).
    for (const id of rows) await win.locator(`[data-testid="order-source"] li[data-card-id="${id}"]`).click();
    await expect
      .poll(() => win.locator('[data-testid="order-dest"] li[data-card-id]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card-id')))))
      .toEqual(rows);
    await alice.page.getByTestId('prompt-submit').click();
    await expect(win, 'the answered window closes').toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => says(alice.page), { timeout: 60_000, message: 'the match goes on past the mulligan' }).not.toMatch(/return \d card|keep your hand/i);
  } finally {
    await alice.context.close();
    await bob.context.close();
    await stack.stop();
  }
});
