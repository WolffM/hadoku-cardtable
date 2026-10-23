/**
 * The operator, 2026-10-13: *"need a back to room button in addition to the
 * rematch and main menu buttons."*
 *
 * Two real browsers, a real Forge match. Bob concedes; alice's result screen
 * offers Rematch, Back to room and Main menu. Back to room takes her to the
 * room the match came from — still a member, still seated with the deck she
 * played, not ready — and starts nothing. Bob, still on his result screen,
 * still has her to rematch with: he presses Rematch, she readies in the room,
 * and one new match starts for both.
 *
 * `[af33]` lines are the evidence: each screen's URL and how many matches the
 * server has started.
 */
import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { makeTitled, readyFromSideboard } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { enterMatch } from './play/enter.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const MATCH_URL = /#\/match\/(m-[0-9a-f]{12})$/;

const result = (f: Friend) => f.page.getByTestId('game-result');

function matchesStarted(stack: PlayStack): number {
  return readFileSync(stack.serverLogFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"evt":"room-match-started"')).length;
}

test(titled('the result screen has Rematch, Back to room and Main menu; Back to room returns to the room, seated, and starts nothing'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { matchId, roomUrl } = await enterMatch(alice, bob, stack.origin);

    await bob.page.getByTestId('live-concede').click();
    await bob.page.getByTestId('live-concede-yes').click();
    for (const f of [alice, bob]) await expect(result(f), `${f.name}'s result screen`).toBeVisible({ timeout: 45_000 });

    const labels = await result(alice).locator('.confirm__actions button').allTextContents();
    console.log(`[af33] alice's result actions: ${JSON.stringify(labels)}`);
    expect(labels.map((l) => l.trim()), 'Rematch, Back to room, Main menu').toEqual(['Rematch', 'Back to room', 'Main menu']);
    const started = matchesStarted(stack);

    await result(alice).getByTestId('game-result-room').click();
    await expect(alice.page, 'alice is in the room the match came from').toHaveURL(roomUrl, { timeout: 15_000 });
    await expect(alice.page.getByTestId('constructed')).toBeVisible({ timeout: 15_000 });
    await expect(alice.page.getByTestId('ready-toggle'), 'alice is seated with her deck, and not ready').toBeEnabled({ timeout: 15_000 });
    await expect(alice.page.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'false');
    // Long enough for a stray start to show up on the server.
    await alice.page.waitForTimeout(3_000);
    console.log(`[af33] alice back in the room: alice ${alice.page.url().split('#')[1]} bob ${bob.page.url().split('#')[1]} matches started=${matchesStarted(stack)}`);
    expect(matchesStarted(stack), 'Back to room starts nothing').toBe(started);
    expect(alice.page.url(), 'alice stayed in the room').toBe(roomUrl);
    expect(MATCH_URL.exec(bob.page.url())?.[1], 'bob is still on his result screen').toBe(matchId);
    await expect(bob.page.getByTestId('game-result-rematch'), 'alice is still at the table: bob can rematch her').toBeEnabled({ timeout: 10_000 });

    // Bob asks for a rematch from his result screen; alice readies in the room, then sideboards at her table.
    await bob.page.getByTestId('game-result-rematch').click();
    await alice.page.getByTestId('ready-toggle').click();
    // Between games the room offers the way back to her table, whose page holds her sideboard step
    // (the operator, 2026-10-23: "a small box that lets me return").
    await alice.page.getByTestId('room-table-link').click();
    for (const f of [alice, bob]) await readyFromSideboard(f.page);
    for (const f of [alice, bob]) {
      await expect.poll(() => MATCH_URL.exec(f.page.url())?.[1], { message: `${f.name} reaches a new match`, timeout: 120_000 }).not.toBe(matchId);
      await expect(f.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 60_000 });
    }
    const a = MATCH_URL.exec(alice.page.url())?.[1];
    const b = MATCH_URL.exec(bob.page.url())?.[1];
    console.log(`[af33] rematch from the room: alice ${a} bob ${b} matches started=${matchesStarted(stack)}`);
    expect(b, 'the same new match on both screens').toBe(a);
    expect(matchesStarted(stack), 'exactly one new match').toBe(started + 1);
  } finally {
    await stack.stop();
  }
});
