/**
 * Cardtable's own rooms' chat is served by cardtable, not watchparty.
 * `RoomShell.tsx` passes `RoomChrome` a `chatOrigin`
 * (`@wolffm/watchparty-ui` 0.45.62) pointing at this app's own origin;
 * `apps/server/src/room/chat.ts` mounts `@wolffm/rooms-server/chat`'s
 * `serveRoomChat` on a `/chat` namespace of this same server, admitting a
 * socket only when it is a MEMBER of the room it names (not merely a
 * signed-in friend — `docs/requests/watchparty-chat-membership.md`'s own
 * finding about watchparty's equivalent check, closed for cardtable's rooms
 * by this move).
 *
 * `serverOrigin` (presence, roster, identity) is unchanged and still points
 * at watchparty, which this harness runs none of (`e2e/w90a-chat-before-join.ts`'s
 * own finding) — so that socket never connects here, on purpose. The CHAT
 * socket is the one proven live in this spec, because `chatOrigin` is THIS
 * server, already running for every other spec in this suite.
 *
 * ## Proving the request host
 *
 * Every request this harness's `openFriend` lets through already stays on
 * `127.0.0.1` (its own `context.route` blocks anything else) — watchparty and
 * cardtable share a host here, differing only by PATH PREFIX, the same way
 * `base-path.ts` says a production deploy's edge tells them apart. So "the
 * request host" is read off each websocket's PATH: `/cardtable/socket.io/`
 * (this app, `PREFIX`) for the chat socket, never `/watchparty/...`.
 */
import { expect, test, type Page, type WebSocket } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { openFriend } from './play/browser.ts';
import { submitCreateRoom } from './play/rooms.ts';

test.describe.configure({ mode: 'serial' });

const UI_TIMEOUT = 20_000;
const CHAT_INPUT = 'Send a message';

/** One entry per websocket frame this friend's page sent or received, tagged with the socket's own URL. */
interface ChatFrame {
	url: string;
	dir: 'in' | 'out';
	text: string;
}

/** Every websocket this friend's page opens, from here on — call before anything that might open one. */
function captureSockets(page: Page): ChatFrame[] {
	const frames: ChatFrame[] = [];
	page.on('websocket', (ws: WebSocket) => {
		ws.on('framereceived', (f) => frames.push({ url: ws.url(), dir: 'in', text: String(f.payload) }));
		ws.on('framesent', (f) => frames.push({ url: ws.url(), dir: 'out', text: String(f.payload) }));
	});
	return frames;
}

const isChatFrame = (f: ChatFrame): boolean => f.text.includes('chat_history') || f.text.includes('chat_broadcast') || f.text.includes('chat_send');

test('two members chat in a cardtable room over cardtable’s own origin; a non-member of a locked room gets no chat socket at all', async ({ browser }) => {
	test.setTimeout(90_000);
	const alice = await openFriend(browser, 'alice');
	const bob = await openFriend(browser, 'bob');
	const carol = await openFriend(browser, 'carol');
	try {
		/* ── alice and bob: both members of an open room, chat rides cardtable's origin ── */
		const aliceFrames = captureSockets(alice.page);
		const bobFrames = captureSockets(bob.page);

		await alice.page.goto(`${PREFIX}/`);
		await submitCreateRoom(alice.page, { name: `e2e w97c ${Date.now()}` });
		await alice.page.waitForURL(/\/room\/[a-z0-9-]+$/, { timeout: UI_TIMEOUT });
		const roomUrl = alice.page.url();

		await bob.page.goto(roomUrl);
		await expect(bob.page.locator('.room-shell'), 'bob is a member of the room alice made').toBeVisible({ timeout: UI_TIMEOUT });

		// Both chat composers are up — proof `RoomChrome` mounted and its (separate) chat socket joined.
		for (const f of [alice, bob]) await expect(f.page.getByPlaceholder(CHAT_INPUT), `${f.name}'s chat input`).toBeVisible({ timeout: UI_TIMEOUT });

		const text = `hello from alice ${Date.now()}`;
		await alice.page.getByPlaceholder(CHAT_INPUT).fill(text);
		await alice.page.getByPlaceholder(CHAT_INPUT).press('Enter');

		// bob receives it — the chat round-trip actually works, not just "a socket opened".
		await expect.poll(() => bobFrames.some((f) => isChatFrame(f) && f.dir === 'in' && f.text.includes(text)), {
			message: `bob received alice's chat_broadcast: ${JSON.stringify(bobFrames.filter(isChatFrame).map((f) => f.text.slice(0, 200)))}`,
			timeout: UI_TIMEOUT,
		}).toBe(true);

		// The request host: every chat frame either of them sent or received rode a websocket whose
		// PATH is this app's own `/cardtable/socket.io/`, never watchparty's `/watchparty/...` — the
		// SAME path the draft and match sockets already use (`socket-options.ts`'s `socketPath`),
		// because the chat namespace is mounted on this same server.
		for (const [who, frames] of [['alice', aliceFrames], ['bob', bobFrames]] as const) {
			const chatUrls = [...new Set(frames.filter(isChatFrame).map((f) => f.url))];
			expect(chatUrls.length, `${who}: at least one chat frame, on exactly one socket URL`).toBeGreaterThan(0);
			for (const url of chatUrls) {
				expect(new URL(url).pathname, `${who}'s chat socket path`).toContain(`${PREFIX}/socket.io/`);
				expect(url, `${who}'s chat socket never watchparty's`).not.toContain('/watchparty/');
			}
		}

		/* ── carol, not a member of a LOCKED room, gets no chat socket at all ── */
		const carolFrames = captureSockets(carol.page);
		await alice.page.goto(`${PREFIX}/`);
		await submitCreateRoom(alice.page, { name: `e2e w97c locked ${Date.now()}`, password: 'hunter2' });
		await alice.page.waitForURL(/\/room\/[a-z0-9-]+$/, { timeout: UI_TIMEOUT });
		const lockedUrl = alice.page.url();

		await carol.page.goto(lockedUrl);
		await expect(carol.page.getByTestId('room-locked'), 'carol is asked for the password, never let in').toBeVisible({ timeout: UI_TIMEOUT });
		// Long enough for a chat socket to have opened and joined if it was going to.
		await carol.page.waitForTimeout(1_000);
		expect(carolFrames.filter(isChatFrame), 'carol never opened a chat socket at all — RoomChrome itself does not mount for a non-member').toEqual([]);
		await expect(carol.page.getByPlaceholder(CHAT_INPUT), 'no chat composer either').toHaveCount(0);
	} finally {
		await alice.context.close();
		await bob.context.close();
		await carol.context.close();
	}
});
