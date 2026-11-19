/**
 * A tournament table between games, against the seeded rooms (`room/testing-rooms.ts`), on the plain
 * harness (nothing here starts a game). The operator, 2026-11-19, of a room where all they saw was two
 * faces and a score: *"whats happening in this room? who is it waiting on? what phase are they in?"*
 * — and *"build some new testing rooms for me so i can see different situations like going back to a
 * room during sideboarding phase"*.
 *
 * - Watching a series between games: the table says it is sideboarding before game 2, waits on its
 *   player, who has no screen open (away), lists game 1, and counts the round's matches.
 * - A "your series" room: the first admin in takes the seeded seat, 1–0 up, and stays on the room's
 *   page, their own table lit, its way on Sideboard; the table's page says the same, and the step is
 *   its own full screen. Going away and coming back lands on the room's page again, the card still lit.
 */
import { expect, test, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX } from './identities.ts';
import { door, litCard, ROOM_PAGE, sideboardFromTablePage, toMyTable } from './play/board.ts';
import { openFriend } from './play/browser.ts';

const UI_TIMEOUT = 30_000;
const WAITING = 'Testing: Tournament — watching a series between games';
const SIDEBOARDING = 'Testing: Tournament — your series, sideboarding after game 1';

async function openSeeded(page: Page, name: string): Promise<void> {
  await page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
  const row = page.getByTestId('room-row').filter({ has: page.getByTestId('room-name').getByText(name, { exact: true }) });
  await expect(row, `${name} is listed for an admin`).toBeVisible({ timeout: UI_TIMEOUT });
  await row.getByTestId('room-enter').click();
  await page.waitForURL(/\/room\/r-[0-9a-f]{12}/, { timeout: UI_TIMEOUT });
}

test('watching a series between games: the step, who it waits on and that they are away, the games, the round', async ({ browser }) => {
  const admin = await openFriend(browser, 'admin');
  try {
    await openSeeded(admin.page, WAITING);
    await admin.page.getByTestId('pod-tables-watch').click();
    await expect(admin.page.getByTestId('table-page')).toBeVisible({ timeout: UI_TIMEOUT });
    const step = admin.page.getByTestId('table-status-step');
    await expect(step).toContainText('Sideboarding before game 2', { timeout: UI_TIMEOUT });
    await expect(admin.page.getByTestId('table-status-waiting')).toHaveCount(1);
    await expect(admin.page.getByTestId('table-status-waiting')).toContainText('Testing');
    // The seed never opens a screen: away, with no time, since this server has never seen it.
    await expect(admin.page.getByTestId('table-status-away')).toHaveText('away');
    await expect(admin.page.getByTestId('table-status-games')).toHaveText('Game 1 Testing won');
    await expect(admin.page.getByTestId('table-status-round')).toHaveText('Round 1 · 0 of 1 matches done');
    await expect(admin.page.getByTestId('table-sideboard')).toHaveCount(0);
    await expect(door(admin.page), 'no game is up: a watcher has no way in').toHaveCount(0);
  } finally {
    await admin.context.close();
  }
});

test('a "your series" room hands the admin the seat mid-sideboard: the room’s page lights their table as Sideboard, its table page offers the same, a screen of its own, and coming back lands on the room’s page again', async ({ browser }) => {
  const admin = await openFriend(browser, 'admin');
  try {
    // A paired player is carried nowhere, as a real entrant coming in is not: the room's page, their own table lit.
    await openSeeded(admin.page, SIDEBOARDING);
    const lit = litCard(admin.page);
    await expect(lit, 'the admin’s own table is lit').toHaveCount(1, { timeout: UI_TIMEOUT });
    await expect(lit.locator('a[data-door="sideboard"]'), 'between games its way on is Sideboard').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(admin.page, 'on the room’s page, not moved to the table').toHaveURL(ROOM_PAGE);
    const roomUrl = admin.page.url();
    const roomId = /\/room\/(r-[0-9a-f]{12})/.exec(roomUrl)![1]!;
    // The player's own table page between games offers Sideboard too, and the step is its own full screen.
    await admin.page.goto(`${EDGE_ORIGIN}${PREFIX}/#/room/${roomId}/table/${await lit.getAttribute('data-table-id')}`);
    await sideboardFromTablePage(admin.page, UI_TIMEOUT);
    // The seat, the lead and the 1–0 are the admin's now.
    const room = await admin.page.evaluate(async (path) => {
      const res = await fetch(path, { credentials: 'same-origin' });
      return (await res.json()) as { you: { id: string; leader: boolean }; tables: { players: { memberId: string }[]; series: { wins: number[]; phase: string } }[] };
    }, `${PREFIX}/api/rooms/${roomId}`);
    expect(room.you.leader).toBe(true);
    const mine = room.tables.find((t) => t.players.some((p) => p.memberId === room.you.id));
    expect(mine?.series).toMatchObject({ wins: [1, 0], phase: 'sideboarding' });

    // Away and back: the front page, then the room again.
    await admin.page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
    await openSeeded(admin.page, SIDEBOARDING);
    await expect(admin.page, 'back on the room’s page').toHaveURL(roomUrl, { timeout: UI_TIMEOUT });
    expect(await toMyTable(admin.page, UI_TIMEOUT), 'the lit card is the sideboard step itself').toBe('sideboard');
    await expect(admin.page.getByTestId('table-sideboard-page').getByTestId('table-sideboard'), 'the sideboard step, on its own screen').toBeVisible({ timeout: UI_TIMEOUT });
  } finally {
    await admin.context.close();
  }
});
