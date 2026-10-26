/**
 * A match whose Forge dies mid-game has to read as ended on both screens
 * (docs/planning/hosting-test-plan.md, finding H1). The server told both seats
 * within a quarter second, but the board drew nothing: each player kept an open
 * decision and a greyed Concede for as long as they waited.
 *
 * Two real browsers, a real Forge match. The match's bridge JVM is killed with
 * SIGKILL (the pid from its own run dir's `jvm.json`, never a pattern). Both
 * screens then show the server's ending notice with no decision left open, and
 * Back to room takes a player to the room, which can start the next match.
 *
 * `[h1]` lines are the evidence: the pid killed, and what each screen shows.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { enterMatch } from './play/enter.ts';
import { forgeAvailability, readJvmRecord, startPlayStack, type PlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The bridge JVM playing `matchId`: a match adopts the warm spare, so its run dir keeps the spare's name. */
function matchPid(stack: PlayStack, matchId: string): number {
  for (const dir of readdirSync(stack.workDir)) {
    const record = readJvmRecord(join(stack.workDir, dir));
    if (record?.matchId === matchId) return record.pid;
  }
  throw new Error(`no jvm.json names ${matchId} under ${stack.workDir}`);
}

const notice = (f: Friend) => f.page.getByTestId('match-ended');
/** Every decision the board can hold open is drawn in a `.live__prompt` host (`movable.tsx`'s `QuestionHost`). */
const openPrompts = (f: Friend) => f.page.locator('.live__prompt');

test(titled('a match whose Forge dies ends on both screens: the server’s words, nothing left open, and the way back to the room'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { matchId, roomUrl } = await enterMatch(alice, bob, stack.origin);

    // The pregame decision (play or draw) is open on one screen and its waiting line on the other.
    await expect
      .poll(async () => (await openPrompts(alice).count()) + (await openPrompts(bob).count()), { message: 'something is open before the kill', timeout: 60_000 })
      .toBeGreaterThan(0);

    const pid = matchPid(stack, matchId);
    console.log(`[h1] killing match ${matchId}'s bridge JVM, pid ${pid}`);
    process.kill(pid, 'SIGKILL');

    for (const f of [alice, bob]) {
      await expect(notice(f), `${f.name} is told the match ended`).toBeVisible({ timeout: 30_000 });
      await expect(notice(f)).toContainText('Forge stopped');
      await expect(openPrompts(f), `${f.name} has nothing left to answer`).toHaveCount(0);
      await expect(f.page.getByTestId('game-result'), `${f.name}: no result for a game that did not finish`).toHaveCount(0);
      const actions = (await notice(f).locator('button').allTextContents()).map((t) => t.trim());
      console.log(`[h1] ${f.name}: ${JSON.stringify((await notice(f).textContent()) ?? '')} actions=${JSON.stringify(actions)}`);
      expect(actions).toEqual(['Back to room', 'Main menu']);
    }

    // Back at the table, the room is usable: seated with her deck, and Ready can be pressed again.
    await notice(alice).getByTestId('game-result-room').click();
    await expect(alice.page, 'alice is in the room the match came from').toHaveURL(roomUrl, { timeout: 15_000 });
    await expect(alice.page.getByTestId('constructed')).toBeVisible({ timeout: 15_000 });
    await expect(alice.page.getByTestId('ready-toggle'), 'alice is seated with her deck').toBeEnabled({ timeout: 15_000 });
    await expect(alice.page.getByTestId('room-match-link'), 'the dead match is not offered as one to play').toHaveCount(0);
  } finally {
    await stack.stop();
  }
});
