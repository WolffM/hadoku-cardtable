/**
 * A Gauntlet ban pressed twice: one act, and the room does not grow a scroll bar.
 *
 * The operator, 2026-11-09: *"scroll bar appears after banning 1 in gauntlet mode."* The server log
 * of that room has the player's first ban answered 200 and a second `gauntlet/act` from the same
 * player 63 ms later answered 409: the tile was still pressable until the first answer redrew the
 * board, so a double click sent the ban twice. The room drew the refusal ("it is not your turn") as
 * its error line above the board, which made the screen taller than the window, and it stayed there.
 *
 * This double-clicks a ban at a window the room fits, then proves the room sent one act (nothing
 * refused, no error line) and its screen is no taller than before.
 *
 * `[gauntlet-double-press]` lines are the evidence.
 */
import { expect, test } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

const ERA = 'modern-2012-07-13';

test('a ban double-clicked is one act: no refusal, no error line, the room no taller', async ({ browser }) => {
  test.setTimeout(2 * 60_000);
  // Tall enough that the room fits the window before the ban: the report is a scroll bar appearing.
  const context = await browser.newContext({ viewport: { width: 1920, height: 1220 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: 'alice', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  const page = await context.newPage();
  const acts: number[] = [];
  page.on('response', (res) => {
    if (res.request().method() === 'POST' && res.url().endsWith('/gauntlet/act')) acts.push(res.status());
  });
  try {
    await page.goto(`${PREFIX}/`);
    const api = (path: string, data: unknown) => context.request.post(`${EDGE_ORIGIN}${PREFIX}/api${path}`, { data });
    const created = await api('/rooms', { name: `e2e gauntlet double press ${Date.now()}`, gameType: 'constructed-1v1', mode: 'gauntlet', modeOptions: { family: 'modern', era: ERA } });
    expect(created.status()).toBe(201);
    const roomId = ((await created.json()) as { id: string }).id;
    await page.goto(`${PREFIX}/#/room/${roomId}`);
    await expect(page.getByTestId('constructed')).toBeVisible({ timeout: 15_000 });
    expect((await api(`/tables/rooms/${roomId}/sit`, {})).status()).toBe(200);
    expect((await api(`/tables/rooms/${roomId}/gauntlet/ready`, { ready: true, ai: true })).status()).toBe(200);

    const banner = page.getByTestId('gauntlet-turn');
    await expect(page.getByTestId('gauntlet')).not.toHaveAttribute('data-revealing', /.*/, { timeout: 20_000 });
    await expect(banner).toHaveAttribute('data-you', 'true', { timeout: 20_000 });
    await expect(banner).toContainText('Ban');

    const extent = () =>
      page.evaluate(() => {
        const shell = document.querySelector<HTMLElement>('.shell')!;
        // The room's own height, slack or none: what a scroll bar appears for.
        const room = shell.querySelector<HTMLElement>('.lobby--room')!;
        return { room: room.offsetHeight, scrollHeight: shell.scrollHeight, clientHeight: shell.clientHeight };
      });
    const before = await extent();
    console.log(`[gauntlet-double-press] before: ${JSON.stringify(before)}`);
    expect(before.scrollHeight, 'the room fits the window before the ban').toBeLessThanOrEqual(before.clientHeight);

    const tile = page.getByTestId('gauntlet-pool').locator('[data-testid="gauntlet-deck"][data-status="open"]:enabled').first();
    const id = await tile.getAttribute('data-deck-id');
    await tile.dblclick();
    await expect(page.locator(`[data-deck-id="${id}"]`)).toHaveAttribute('data-status', 'banned');
    // The first answer, then long enough for a second one to have landed too.
    await expect.poll(() => acts.length, { timeout: 10_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(1_500);

    const after = await extent();
    console.log(`[gauntlet-double-press] acts answered: ${JSON.stringify(acts)}; after: ${JSON.stringify(after)}`);
    expect(acts, 'the double click sent one act, and it was taken').toEqual([200]);
    await expect(page.getByTestId('table-error'), 'no refusal is drawn').toHaveCount(0);
    expect(after.room, 'the room is no taller than before the ban').toBe(before.room);
    expect(after.scrollHeight, 'and still fits the window').toBeLessThanOrEqual(after.clientHeight);
  } finally {
    await context.close();
  }
});
