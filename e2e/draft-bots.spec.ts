/**
 * The draft room's bots selector, two members, the real UI against the real
 * built server: the leader picks what the bots draft with, the room keeps it
 * (a reload reads it back), and a member who is not the leader reads it,
 * disabled.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';
import { roomIdFromAddress } from './play/board.ts';
import { openCreateRoom, submitCreateRoom } from './play/rooms.ts';

const UI_TIMEOUT = 30_000;

async function join(browser: Browser, name: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  return { context, page: await context.newPage() };
}

test('the leader picks the draft bots, the room keeps it, and everyone else reads it disabled', async ({ browser }) => {
  const alice = await join(browser, 'alice');
  const bob = await join(browser, 'bob');
  try {
    await alice.page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
    await openCreateRoom(alice.page);
    await submitCreateRoom(alice.page, { name: `e2e bots ${Date.now()}`, gameType: 'draft' });
    const roomId = await roomIdFromAddress(alice.page);
    await bob.page.goto(`${EDGE_ORIGIN}${PREFIX}/#/room/${roomId}`);

    const choice = (page: Page, value: string) => page.getByTestId(`draft-bots-${value}`);
    // Bots is a room setting: each player opens Room settings to read or move it.
    const openSettings = (page: Page) => page.getByTestId('match-rules').click({ timeout: UI_TIMEOUT });
    await openSettings(alice.page);
    await openSettings(bob.page);
    await expect(choice(alice.page, 'model')).toBeChecked({ timeout: UI_TIMEOUT });
    await choice(alice.page, 'pick-order').click({ force: true });
    await expect(choice(alice.page, 'pick-order')).toBeChecked({ timeout: UI_TIMEOUT });

    await expect(choice(bob.page, 'pick-order')).toBeChecked({ timeout: UI_TIMEOUT });
    for (const value of ['model', 'pick-order', 'split']) await expect(choice(bob.page, value)).toBeDisabled();

    await alice.page.reload();
    await openSettings(alice.page);
    await expect(choice(alice.page, 'pick-order')).toBeChecked({ timeout: UI_TIMEOUT });
    await choice(alice.page, 'split').click({ force: true });
    await expect(choice(bob.page, 'split')).toBeChecked({ timeout: UI_TIMEOUT });
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});
