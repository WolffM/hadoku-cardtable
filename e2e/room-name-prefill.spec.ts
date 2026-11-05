/*
 * Create room opens with its name filled in as "<the viewer's name>'s <word>", a word from
 * `ROOM_WORDS` drawn each time it opens (the operator, 2026-11-05). The name is a real value, so
 * what the viewer types replaces it and what they leave is the name the room is made with.
 */
import { expect, test } from '@playwright/test';

import { ROOM_WORDS } from '../apps/ui/src/rooms/roomName.ts';
import { EDGE_ORIGIN, FRIENDS, PREFIX, SESSION_COOKIE } from './identities.ts';
import { openCreateRoom } from './play/rooms.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

test("Create room opens prefilled with the viewer's name and a word from the list, and the room keeps it", async ({ browser }) => {
  const me = FRIENDS.alice;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await context.addCookies([{ name: SESSION_COOKIE, value: 'alice', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
    await keepPrefsLocal(context, EDGE_ORIGIN);
    await context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.userId, userType: 'member', name: me.name } }));
    const page = await context.newPage();
    const created: Record<string, unknown>[] = [];
    page.on('request', (req) => {
      const body = req.postData();
      if (req.method() === 'POST' && req.url().endsWith('/api/rooms') && body !== null) created.push(JSON.parse(body) as Record<string, unknown>);
    });
    await page.goto(`${EDGE_ORIGIN}${PREFIX}/`);

    const prefilled = `${me.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'s (${ROOM_WORDS.join('|')})`;
    const field = page.getByTestId('room-create-name');
    const seen = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      await openCreateRoom(page);
      await expect(field, 'the name opens filled in').toHaveValue(new RegExp(`^${prefilled}$`));
      seen.add(await field.inputValue());
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('room-create')).toHaveCount(0);
    }
    expect(seen.size, 'the word is drawn again each time the form opens').toBeGreaterThan(1);

    await openCreateRoom(page);
    await expect(field).toHaveValue(new RegExp(`^${prefilled}$`));
    const name = await field.inputValue();
    await page.getByTestId('room-create-submit').click();
    await expect.poll(() => created.length, { message: 'the room was created' }).toBe(1);
    expect(created[0]?.name, 'the room is made with the prefilled name').toBe(name);
  } finally {
    await context.close();
  }
});
