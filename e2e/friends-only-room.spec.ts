/**
 * A friends-only room (the operator, 2026-11-22: "restricting their game to be friendtier+ only …
 * a toggle in the UI that is only visible to friendtier+ users"). Friend tier means the fleet's own
 * friend tier and above, as the edge names it: a verified member is not a friend here, though
 * cardtable treats one as a friend everywhere else.
 *
 * dana (friend) makes two rooms through the real create form, one open and one with Friends only on.
 * erin (member) and alice (guest) are offered no Friends only switch; erin's list shows the open
 * room (the control that rooms are listed to her at all) and never the friends-only one, and the
 * server answers 404 to her reading or joining it.
 *
 * `[friends-only]` lines are the evidence.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

import { FRIENDS, PREFIX } from './identities.ts';
import { roomIdFromAddress } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { openCreateRoom } from './play/rooms.ts';
import { pickRadio } from './click-trail.ts';

/**
 * A browser signed in as `name`, its fleet whoami answering with that identity's own tier: the e2e
 * edge serves no `/session/whoami` (every spec that needs one answers it itself), and the switch
 * is drawn off that answer, as the real edge's.
 */
async function signedIn(browser: Browser, name: string): Promise<Awaited<ReturnType<typeof openFriend>>> {
  const f = await openFriend(browser, name);
  const me = FRIENDS[name]!;
  await f.context.route('**/session/whoami', (route) =>
    route.fulfill({ json: { valid: true, userId: me.userId, userType: me.tier ?? 'guest', name: me.name } }),
  );
  return f;
}

const roomNames = (page: Page) => page.getByTestId('room-list').getByTestId('room-name');

async function makeRoom(page: Page, name: string, friendsOnly: boolean): Promise<string> {
  await page.goto(`${PREFIX}/`);
  await openCreateRoom(page);
  await page.getByTestId('room-create-name').fill(name);
  await page.getByTestId('room-create-type-constructed-1v1').check();
  await page.getByTestId('room-create-constructed-mode-classic').check();
  await pickRadio(page, `room-create-friends-only-${friendsOnly ? 'on' : 'off'}`, 'the app took the choice');
  await page.getByTestId('room-create-submit').click();
  return roomIdFromAddress(page);
}

/** The server's own answer to `page`'s caller for a room, from the page's own origin. */
async function statusOf(page: Page, method: 'GET' | 'POST', path: string): Promise<number> {
  return page.evaluate(
    async ({ method, path }) => {
      const res = await fetch(`${window.location.pathname.replace(/(\/room\/[^/]+)?\/?$/, '/')}api/rooms${path}`, {
        method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      return res.status;
    },
    { method, path },
  );
}

test('a friend makes a friends-only room; a member and a guest are offered no switch and never see the room', async ({ browser }) => {
  const dana = await signedIn(browser, 'dana');
  const erin = await signedIn(browser, 'erin');
  const alice = await signedIn(browser, 'alice');
  try {
    const stamp = Date.now();
    const openName = `e2e friends-only control ${stamp}`;
    const friendsName = `e2e friends-only ${stamp}`;
    const openId = await makeRoom(dana.page, openName, false);
    const friendsId = await makeRoom(dana.page, friendsName, true);
    console.log(`[friends-only] dana made ${openId} (open) and ${friendsId} (friends only)`);

    for (const [who, page] of [['erin (member)', erin.page], ['alice (guest)', alice.page]] as const) {
      await page.goto(`${PREFIX}/`);
      await openCreateRoom(page);
      await expect(page.getByTestId('room-create-password'), `${who}: the create form is drawn`).toBeVisible();
      await expect(page.getByTestId('room-create-friends-only'), `${who}: no Friends only switch`).toHaveCount(0);
      await page.keyboard.press('Escape');
    }

    await erin.page.goto(`${PREFIX}/`);
    await expect(roomNames(erin.page).filter({ hasText: openName }), 'erin sees the open room').toHaveCount(1, { timeout: 15_000 });
    await expect(roomNames(erin.page).filter({ hasText: friendsName }), 'erin never sees the friends-only room').toHaveCount(0);
    const read = await statusOf(erin.page, 'GET', `/${friendsId}`);
    const join = await statusOf(erin.page, 'POST', `/${friendsId}/join`);
    console.log(`[friends-only] erin: GET ${read}, join ${join}`);
    expect([read, join], 'the server answers erin as if the room did not exist').toEqual([404, 404]);

    await dana.page.goto(`${PREFIX}/`);
    await expect(roomNames(dana.page).filter({ hasText: friendsName }), 'dana sees her friends-only room').toHaveCount(1, { timeout: 15_000 });
  } finally {
    for (const f of [dana, erin, alice]) await f.context.close();
  }
});
