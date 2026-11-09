/*
 * A Challenge, end to end against real Forge: Create room → Challenge makes the room with the
 * event's field already seated, each AI named for its real player and none of them movable, the
 * creator's seat holding its player's own list, and the creator's Ready locks it and opens round 1
 * — the event's own quarterfinal — as a live match against the real player it paired. Which list
 * that AI plays is pinned over HTTP with the real PodChecks (`apps/server/src/http/rooms.test.ts`);
 * this proves the page and the match.
 */
import { expect, test } from '@playwright/test';

import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { openCreateRoom } from './play/rooms.ts';
import { ready } from './play/tournament.ts';

const forge = forgeAvailability();
const titled = (t: string) => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);
const PREFIX = '/cardtable';
const UI_TIMEOUT = 30_000;

test(titled('a Challenge made from Create room seats the real top 8, and Ready opens round 1 against the real player it paired'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const page = alice.page;
    await page.goto(`${stack.origin}${PREFIX}/`);
    await openCreateRoom(page);
    await page.getByTestId('room-create-type-challenge').click();
    await expect(page.getByTestId('room-create-challenge')).toHaveValue('tournament-legacy-2026-02-07', { timeout: UI_TIMEOUT });
    await expect(page.getByTestId('room-create-player')).toHaveValue('Ozymandias17');
    await expect(page.getByTestId('room-create-name'), 'a Challenge is named for its event').toHaveCount(0);
    await page.getByTestId('room-create-submit').click();

    // Born whole: Ozymandias17's quarterfinal opponent across the table, every AI its real player.
    await expect(page.getByTestId('pod-seat-0'), 'seat 0 is TeaW1thRum, who met Ozymandias17 in the quarterfinals').toContainText('TeaW1thRum', { timeout: UI_TIMEOUT });
    await expect(page.getByTestId('pod-seats')).toContainText('wonderPreaux');
    await expect(page.getByTestId('pod-seat-4')).toHaveAttribute('data-mine', '');
    await expect(page.getByTestId('pod-seat-ai-remove'), 'no AI can be taken out of the field').toHaveCount(0);
    await expect(page.getByTestId('pod-seat-ai')).toHaveCount(0);
    await expect(page.getByTestId('pod-seat-close')).toHaveCount(0);
    await expect(page.getByTestId('pod-seat-8'), 'a full fixed field grows no seat').toHaveCount(0);

    // Playing as Ozymandias17 is playing their list: the chooser holds it alone, chosen, and Ready needs nothing else.
    const offered = page.getByTestId('deck-mine').getByTestId('deck-option');
    await expect(offered, 'only the seat’s own list').toHaveCount(1, { timeout: UI_TIMEOUT });
    await expect(offered).toContainText('Ozymandias17');
    await expect(page.getByTestId('ready-toggle')).toBeEnabled({ timeout: UI_TIMEOUT });
    await ready(alice);
    await expect(page.getByTestId('match'), 'round 1 is a live match against the real player').toContainText('TeaW1thRum', { timeout: 2 * UI_TIMEOUT });
  } finally {
    await stack.stop();
  }
});
