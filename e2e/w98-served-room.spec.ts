/**
 * Cardtable's rooms are served by cardtable. `RoomShell.tsx` hands `RoomChrome` a `roomOrigin`
 * (this app's own origin), so the chrome's whole room socket — join, roster, identity, chat — goes
 * to `apps/server/src/room/serve.ts` (`@wolffm/rooms-server/room`'s `serveRoom`, namespace `/room`)
 * and none of it to watchparty. Presence is the server's one tracker, and a member's name comes
 * from their account (`people.ts`), so:
 *
 * - two members chat over cardtable's own `/cardtable/socket.io/`, and see each other on the
 *   roster; nothing of the room goes to watchparty; a non-member of a locked room gets nothing;
 * - one person in two tabs is one person: their Ready counts once;
 * - a rename made in a tab with no room open (the fleet gear's `hadoku:name`) reaches the other
 *   player's room list with nobody rejoining.
 *
 * The request host is read off each websocket's PATH: watchparty and cardtable share a host here,
 * differing only by prefix, as they do behind the edge.
 */
import { expect, test, type Page, type WebSocket } from '@playwright/test';

import { FRIENDS, PREFIX } from './identities.ts';
import { dress } from './looks.ts';
import { openFriend } from './play/browser.ts';
import { submitCreateRoom } from './play/rooms.ts';

test.describe.configure({ mode: 'serial' });

const UI_TIMEOUT = 20_000;
const CHAT_INPUT = 'Send a message';

/** One entry per websocket frame a page sent or received, tagged with the socket's own URL. */
interface Frame {
  url: string;
  dir: 'in' | 'out';
  text: string;
}

/** Every websocket this page opens, from here on — call before anything that might open one. */
function captureSockets(page: Page): Frame[] {
  const frames: Frame[] = [];
  page.on('websocket', (ws: WebSocket) => {
    ws.on('framereceived', (f) => frames.push({ url: ws.url(), dir: 'in', text: String(f.payload) }));
    ws.on('framesent', (f) => frames.push({ url: ws.url(), dir: 'out', text: String(f.payload) }));
  });
  return frames;
}

const isRoomFrame = (f: Frame): boolean => /"(chat_history|chat_broadcast|chat_send|presence|snapshot|identity_update)"/.test(f.text);

test('two members chat and see each other over cardtable’s own origin; nothing goes to watchparty; a non-member of a locked room gets nothing', async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await openFriend(browser, 'alice');
  const bob = await openFriend(browser, 'bob');
  const carol = await openFriend(browser, 'carol');
  try {
    const aliceFrames = captureSockets(alice.page);
    const bobFrames = captureSockets(bob.page);

    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e w98 ${Date.now()}` });
    await alice.page.waitForURL(/\/room\/[a-z0-9-]+$/, { timeout: UI_TIMEOUT });
    const roomUrl = alice.page.url();

    await bob.page.goto(roomUrl);
    await expect(bob.page.locator('.room-shell'), 'bob is a member of the room alice made').toBeVisible({ timeout: UI_TIMEOUT });
    for (const f of [alice, bob]) await expect(f.page.getByPlaceholder(CHAT_INPUT), `${f.name}'s chat input`).toBeVisible({ timeout: UI_TIMEOUT });

    // The roster is the server's: bob's room socket is told about both of them.
    await expect
      .poll(() => bobFrames.filter((f) => f.dir === 'in' && f.text.includes('"presence"')).at(-1)?.text ?? '', { timeout: UI_TIMEOUT, message: 'bob’s roster names both' })
      .toMatch(new RegExp(`${FRIENDS.alice!.name}.*${FRIENDS.bob!.name}|${FRIENDS.bob!.name}.*${FRIENDS.alice!.name}`));

    const text = `hello from alice ${Date.now()}`;
    await alice.page.getByPlaceholder(CHAT_INPUT).fill(text);
    await alice.page.getByPlaceholder(CHAT_INPUT).press('Enter');
    await expect
      .poll(() => bobFrames.some((f) => f.dir === 'in' && f.text.includes('chat_broadcast') && f.text.includes(text)), { timeout: UI_TIMEOUT, message: 'bob received alice’s line' })
      .toBe(true);

    for (const [who, frames] of [['alice', aliceFrames], ['bob', bobFrames]] as const) {
      const roomUrls = [...new Set(frames.filter(isRoomFrame).map((f) => f.url))];
      expect(roomUrls.length, `${who}: room frames, on one socket`).toBe(1);
      expect(new URL(roomUrls[0]!).pathname, `${who}'s room socket path`).toContain(`${PREFIX}/socket.io/`);
      expect(frames.filter((f) => f.url.includes('/watchparty')), `${who}: not one frame to watchparty`).toEqual([]);
    }

    // carol, not a member of a LOCKED room: no room frames at all.
    const carolFrames = captureSockets(carol.page);
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e w98 locked ${Date.now()}`, password: 'hunter2' });
    await alice.page.waitForURL(/\/room\/[a-z0-9-]+$/, { timeout: UI_TIMEOUT });
    await carol.page.goto(alice.page.url());
    await expect(carol.page.getByTestId('room-locked'), 'carol is asked for the password, never let in').toBeVisible({ timeout: UI_TIMEOUT });
    await carol.page.waitForTimeout(1_000);
    expect(carolFrames.filter(isRoomFrame), 'carol hears nothing of the room').toEqual([]);
    await expect(carol.page.getByPlaceholder(CHAT_INPUT), 'no chat composer either').toHaveCount(0);
  } finally {
    await alice.context.close();
    await bob.context.close();
    await carol.context.close();
  }
});

test('one person in two tabs is one person: alice’s Ready counts once at bob’s table', async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await openFriend(browser, 'alice');
  const bob = await openFriend(browser, 'bob');
  try {
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e w98 two tabs ${Date.now()}`, gameType: 'draft' });
    await alice.page.waitForURL(/\/room\/[a-z0-9-]+$/, { timeout: UI_TIMEOUT });
    const roomUrl = alice.page.url();
    const roomId = new URL(roomUrl).pathname.split('/').pop()!;
    const api = async (f: typeof alice, path: string, data: unknown): Promise<void> => {
      const res = await f.context.request.post(`${new URL(roomUrl).origin}${PREFIX}/api${path}`, { data });
      expect(res.status(), `${path}: ${await res.text()}`).toBe(200);
    };
    await bob.page.goto(roomUrl);
    await expect(bob.page.locator('.room-shell')).toBeVisible({ timeout: UI_TIMEOUT });

    // Her second tab of the same room: the same person (it may ask before taking her seat over).
    const second = await alice.context.newPage();
    await second.goto(roomUrl);
    await expect(second.locator('.room-shell').or(second.getByTestId('session-ask')).first()).toBeVisible({ timeout: UI_TIMEOUT });

    await api(alice, `/rooms/${roomId}/pod/sit`, { seat: 0 });
    await api(alice, `/rooms/${roomId}/ready`, { ready: true });
    const rings = bob.page.locator('.pod-seats__avatar[data-ready="true"]');
    await expect(rings, 'one ready ring for alice, however many tabs she has').toHaveCount(1, { timeout: UI_TIMEOUT });
    await second.close();
    await bob.page.waitForTimeout(1_000);
    await expect(rings, 'her other tab closing changes nothing').toHaveCount(1);
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});

test('a rename made in a tab with no room open reaches the other player’s room list, with nobody rejoining', async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await openFriend(browser, 'alice');
  const bob = await openFriend(browser, 'bob');
  const renamed = `e2e-alice-${Date.now() % 100_000}`;
  try {
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e w98 rename ${Date.now()}` });
    await alice.page.waitForURL(/\/room\/[a-z0-9-]+$/, { timeout: UI_TIMEOUT });
    const roomId = new URL(alice.page.url()).pathname.split('/').pop()!;
    await expect(alice.page.getByPlaceholder(CHAT_INPUT), 'alice’s room is open, chrome and all').toBeVisible({ timeout: UI_TIMEOUT });

    await bob.page.goto(`${PREFIX}/`);
    const members = bob.page.locator(`[data-testid="room-row"][data-room-id="${roomId}"]`).getByTestId('room-members');
    await expect(members, 'bob’s list names alice as the edge does').toContainText(FRIENDS.alice!.name, { timeout: UI_TIMEOUT });

    // The registry renames her (the stand-in prefs-api is what the server's account lookup reads),
    // and the fleet gear says so on a page of hers with no room on it.
    await dress(alice.context.request, new URL(alice.page.url()).origin, FRIENDS.alice!.key, { source: 'sprite', name: renamed });
    const roomless = await alice.context.newPage();
    await roomless.goto(`${PREFIX}/`);
    await expect(roomless.getByTestId('room-row').first()).toBeVisible({ timeout: UI_TIMEOUT });
    await roomless.evaluate((name) => window.dispatchEvent(new CustomEvent('hadoku:name', { detail: { name } })), renamed);

    await expect(members, 'bob’s list follows, with no reload and no rejoin').toContainText(renamed, { timeout: UI_TIMEOUT });
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});
