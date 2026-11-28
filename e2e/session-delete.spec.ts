/**
 * A session the page ends itself is not a lost one: Delete account goes to hadoku.me's home, and
 * leaves nothing that signs in.
 *
 * 2026-11-27 (hadoku_site's `deletion.spec.ts` on cardtable-ppe): the header's Delete for good posts
 * `/session/account/delete`, which ends the session at once and answers more than a second later.
 * Meanwhile the page's requests met the edge's 401, the session watch (`packages/ui-shell/src/session`)
 * confirmed it with its probe and reloaded the page, the reload cut the delete off before the header
 * could go to `/`, and the sign-in wall made the browser a brand-new guest.
 *
 * The guest here is the stand-in wall's own (a named identity is every spec's, and cannot be deleted),
 * and the stand-in's delete answers late the way the real one does (`ACCOUNT_DELETE_ANSWER_MS`).
 */
import { expect, test } from '@playwright/test';

import { EDGE_GATE_COOKIE, EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

// The stand-in's delete drops every gated browser's sockets: never beside another gated spec.
test.describe.configure({ mode: 'serial' });

test('Delete account on an open cardtable page lands on hadoku.me’s home, and no new guest is made', async ({ browser }) => {
  test.setTimeout(2 * 60_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await context.addCookies([{ name: EDGE_GATE_COOKIE, value: '1', domain: '127.0.0.1', path: '/' }]);
    await keepPrefsLocal(context, EDGE_ORIGIN);
    // The fleet's own whoami, which this edge does not serve: the header offers Delete account to a guest.
    await context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: 'e2e-deleting-guest', userType: 'guest', name: 'Player Deleting' } }));
    const page = await context.newPage();
    // The visit's first load meets the wall, which makes this browser a guest and sends it on.
    await page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
    await expect(page.getByTestId('lobby')).toBeVisible({ timeout: 30_000 });
    const guest = (await context.cookies()).find((c) => c.name === SESSION_COOKIE)?.value;
    expect(guest, 'the wall made this browser a guest').toMatch(/^guest-\d+$/);

    const after: string[] = [];
    page.on('request', (req) => {
      const { pathname } = new URL(req.url());
      if (req.isNavigationRequest() || pathname === '/session/create' || pathname === `${PREFIX}/api/whoami`) after.push(`${req.method()} ${pathname}`);
    });

    await page.getByRole('button', { name: /^User settings/ }).first().click();
    await page.getByRole('tab', { name: 'Account' }).click();
    await page.getByRole('button', { name: 'Delete account', exact: true }).click();
    await page.getByRole('button', { name: 'Delete for good', exact: true }).click();

    await page.waitForURL(`${EDGE_ORIGIN}/`, { timeout: 30_000 });
    await expect(page.getByTestId('hadoku-home')).toBeVisible();
    // Long enough for a reload the watch started to have shown itself.
    await page.waitForTimeout(3_000);
    console.log(`[session-delete] after Delete for good: ${after.join(', ')}`);
    expect(after.filter((r) => r.startsWith('GET ') && r.slice(4).startsWith(`${PREFIX}`) && !r.includes('/api/')), 'the page never reloaded cardtable').toEqual([]);
    expect(after.filter((r) => r.endsWith('/session/create')), 'no new guest was made').toEqual([]);
    expect(page.url()).toBe(`${EDGE_ORIGIN}/`);
    expect((await context.cookies()).find((c) => c.name === SESSION_COOKIE), 'nothing that signs in is left').toBeUndefined();
  } finally {
    await context.close();
  }
});
