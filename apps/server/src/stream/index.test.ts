/*
 * The stream route's refusals.
 *
 * This is production code with a proxy in it, which is exactly the
 * combination that earns a test rather than a promise. Three properties
 * matter: it does not exist unless the STREAMS file names containers, its
 * websocket half applies the tier floor by hand (because `upgrade` runs no
 * express middleware, so nothing else will apply it for us), and its HTTP
 * half is mounted above the SPA fallback.
 */
import { connect } from 'node:net';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';

import { createRoomStreams, type RoomStreams } from './alloc.ts';
import { attachStream, attachStreamRoutes, roomStreamPathOf, streamIndexOf, streamLayout } from './index.ts';

const deps = { minTier: 'friend', streamBasePort: 6080, streamCount: 2 };

// The layout seam is injectable so these assertions do not depend on whether
// THIS host has containers up — the first run of the bench this route grew
// out of failed for exactly that reason.
const open: Array<Server | { close(): void }> = [];
function close(...servers: Array<Server | { close(): void }>): void {
	for (const s of servers) s.close();
}
afterEach(() => {
	close(...open);
	open.length = 0;
});

describe('the route does not exist unless containers are named', () => {
	it('attaches nothing at all when the count is zero', () => {
		const server = createServer();
		open.push(server);
		const before = server.listenerCount('upgrade');
		expect(attachStream(server, { ...deps, streamCount: 0 })).toBeNull();
		// The real assertion: no upgrade listener, so a websocket cannot reach
		// it even if something guessed the path.
		expect(server.listenerCount('upgrade')).toBe(before);
	});
});

describe('which container a path names', () => {
	it('reads the index out of a stream path', () => {
		expect(streamIndexOf('/stream/0/websockify', 2)).toBe(0);
		expect(streamIndexOf('/stream/1', 2)).toBe(1);
		expect(streamIndexOf('/stream/1?path=x', 2)).toBe(1);
	});

	it('refuses an index outside the containers that exist', () => {
		// The live hazard: /stream/9/ must not reach port 6089, where
		// something unrelated may be listening on this host.
		expect(streamIndexOf('/stream/2/websockify', 2)).toBeNull();
		expect(streamIndexOf('/stream/99/websockify', 2)).toBeNull();
		expect(streamIndexOf('/stream/-1/websockify', 2)).toBeNull();
	});

	it('is not a stream path at all', () => {
		expect(streamIndexOf('/socket.io/?EIO=4', 2)).toBeNull();
		expect(streamIndexOf('/play/ws', 2)).toBeNull();
		expect(streamIndexOf(undefined, 2)).toBeNull();
		// Adjacent but not ours — must fall through so socket.io still gets it.
		expect(streamIndexOf('/streaming/0', 2)).toBeNull();
	});
});

describe('how many containers, read off the disk', () => {
	it('exposes nothing when nothing is named', () => {
		expect(streamLayout(() => false, () => '0')).toEqual({ streamCount: 0 });
	});

	it('a malformed container count is ZERO containers, not a guess', () => {
		// Each container is a proxy to a port. Guessing here is a port scan.
		for (const bad of ['', 'two', '-1', '1.5', 'NaN', '99']) {
			expect(streamLayout(() => true, () => bad).streamCount, `STREAMS=${bad}`).toBe(0);
		}
	});

	it('is bounded at 8 even if the file says more', () => {
		expect(streamLayout(() => true, () => '8').streamCount).toBe(8);
		expect(streamLayout(() => true, () => '9').streamCount).toBe(0);
	});

	it('an unreadable STREAMS file exposes no containers', () => {
		expect(
			streamLayout(() => true, () => {
				throw new Error('EACCES');
			}).streamCount,
		).toBe(0);
	});
});

describe('the websocket half applies the floor itself', () => {
	it('refuses an anonymous upgrade with 404, never 403', async () => {
		const server = createServer();
		open.push(server);
		open.push(attachStream(server, { ...deps, streamCount: 1 }) ?? { close() {} });
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const port = (server.address() as { port: number }).port;

		const answer = await rawUpgrade(port, '/stream/0/websockify');
		expect(answer).toMatch(/^HTTP\/1\.1 404 /);
		// 403 would tell an outsider the path is real. See index.ts.
		expect(answer).not.toContain('403');
	});

	it('refuses a non-version-13 upgrade on the stream path with 400', async () => {
		const server = createServer();
		open.push(server);
		open.push(attachStream(server, { ...deps, streamCount: 1 }) ?? { close() {} });
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const port = (server.address() as { port: number }).port;

		// node only routes a request to `upgrade` when it declares one, so the
		// plain GET never reaches this handler at all. The reachable case is
		// an upgrade speaking the wrong version — websockify would not know
		// what to do with it.
		const answer = await rawUpgrade(port, '/stream/0/websockify', '8');
		expect(answer).toMatch(/^HTTP\/1\.1 400 /);
	});
});

/** Speak just enough HTTP by hand to read the refusal line off the wire. */
function rawUpgrade(port: number, path: string, version: string | '13' = '13'): Promise<string> {
	return new Promise((resolve, reject) => {
		const sock = connect(port, '127.0.0.1', () => {
			const headers = [
				`GET ${path} HTTP/1.1`,
				'Host: 127.0.0.1',
				'Connection: Upgrade',
				'Upgrade: websocket',
				`Sec-WebSocket-Version: ${version}`,
				'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
			];
			sock.write(`${headers.join('\r\n')}\r\n\r\n`);
		});
		let seen = '';
		sock.on('data', (b: Buffer) => {
			seen += b.toString('latin1');
			// The refusal line is all we need; the socket is destroyed after.
			if (seen.includes('\r\n')) {
				sock.destroy();
				resolve(seen.split('\r\n')[0] ?? seen);
			}
		});
		sock.on('error', reject);
		sock.on('close', () => resolve(seen.split('\r\n')[0] ?? seen));
	});
}

describe('the route must be reachable, which is a question about ORDER', () => {
	/*
	 * The bug this exists for, 2026-09-21: this route's bench predecessor was
	 * mounted next to `attachBrowserBridge`, near the bottom of index.ts.
	 * That is safe for the bridge because an `upgrade` bypasses express
	 * routing entirely — but a stream route has real HTTP routes, and below
	 * the SPA fallback every one of them was answered with index.html. The
	 * stream link rendered the cardtable app, which looked exactly like two
	 * browsers joining one room.
	 */
	it('answers its own path when registered BEFORE a catch-all', async () => {
		const app = express();
		attachStreamRoutes(app, { ...deps, streamCount: 1 });
		app.use((_req, res) => res.status(200).type('html').send('<html>THE SPA FALLBACK</html>'));

		const server = app.listen(0);
		open.push(server);
		const port = (server.address() as { port: number }).port;
		const res = await fetch(`http://127.0.0.1:${String(port)}/stream/0/vnc.html`);
		const body = await res.text();

		// It may 502 — there is no container in a unit test — but it must NOT
		// be the fallback's HTML. A 200 of index.html here is the whole bug.
		expect(body).not.toContain('THE SPA FALLBACK');
	});

	it('CATCHES THE BUG: a catch-all registered first swallows the route', async () => {
		// The mutation, as a test. This is what a bottom-of-file mount does.
		const app = express();
		app.use((_req, res) => res.status(200).type('html').send('<html>THE SPA FALLBACK</html>'));
		attachStreamRoutes(app, { ...deps, streamCount: 1 });

		const server = app.listen(0);
		open.push(server);
		const port = (server.address() as { port: number }).port;
		const body = await (await fetch(`http://127.0.0.1:${String(port)}/stream/0/vnc.html`)).text();

		expect(body).toContain('THE SPA FALLBACK');
	});
});

/*
 * ── The room-keyed form: /stream/<roomKey>/<seat>/ ──────────────────────────
 *
 * Same file, same two gates, on purpose. The static half above is the friend
 * demo's link and must keep working byte for byte; the tests above are what
 * pins that. What follows pins the second form against the same properties.
 */

/** A RoomStreams with the given rooms already up. No docker, no allocator. */
function fakeRooms(ports: Record<string, number[]>, dead: string[] = []): RoomStreams & { attaches: string[] } {
	const attaches: string[] = [];
	return {
		attaches,
		allocate: () => Promise.resolve({ ok: false, reason: 'no-ports', detail: 'fake' } as const),
		find: (k) => (k in ports ? ({ roomKey: k } as never) : undefined),
		portOf: (k, seat) => ports[k]?.[seat] ?? null,
		statusOf: (k) =>
			k in ports
				? { roomKey: k, state: 'live', seats: ports[k]?.length ?? 0 }
				: dead.includes(k)
					? { roomKey: k, state: 'dead', seats: 0, reason: 'idle' }
					: { roomKey: k, state: 'none', seats: 0 },
		list: () => [],
		noteAttach: (k) => attaches.push(`+${k}`),
		noteDetach: (k) => attaches.push(`-${k}`),
		release: () => Promise.resolve(),
		sweep: () => Promise.resolve({ reclaimed: [] }),
		sweepOrphans: () => Promise.resolve({ reclaimed: [] }),
	};
}

describe('which room and seat a path names', () => {
	it('reads a room key and a seat out of a room stream path', () => {
		expect(roomStreamPathOf('/stream/kitchen-table/1/websockify')).toEqual({
			roomKey: 'kitchen-table',
			seat: 1,
			rest: '/websockify',
		});
		expect(roomStreamPathOf('/stream/abc/0')).toEqual({ roomKey: 'abc', seat: 0, rest: '/' });
		expect(roomStreamPathOf('/stream/abc/0/?token=x')).toEqual({ roomKey: 'abc', seat: 0, rest: '/?token=x' });
	});

	it('NEVER reads a static stream index as a room key, in either direction', () => {
		// The one collision that matters: /stream/3/ is the bench's container 3,
		// and a room called `3` would make /stream/3/0/ mean two things. Room
		// keys that are all digits are refused at allocation (alloc.ts), and
		// this parser refuses them too, so neither side can drift alone.
		expect(roomStreamPathOf('/stream/3/0/websockify')).toBeNull();
		expect(roomStreamPathOf('/stream/0/vnc.html')).toBeNull();
		// ...and the static parser still does not see a room key.
		expect(streamIndexOf('/stream/kitchen-table/0/websockify', 2)).toBeNull();
		expect(streamIndexOf('/stream/0/websockify', 2)).toBe(0);
	});

	it('is not a room stream path at all', () => {
		expect(roomStreamPathOf('/socket.io/?EIO=4')).toBeNull();
		expect(roomStreamPathOf('/stream/Room/0/')).toBeNull(); // the lobby mints lower case only
		expect(roomStreamPathOf('/stream/abc')).toBeNull(); // no seat
		expect(roomStreamPathOf('/stream/abc/x/')).toBeNull();
		expect(roomStreamPathOf(undefined)).toBeNull();
	});
});

describe("a room's websocket half applies the SAME floor", () => {
	it('refuses an anonymous upgrade to a LIVE room stream with 404, never 403', async () => {
		const server = createServer();
		open.push(server);
		const rooms = fakeRooms({ 'kitchen-table': [6100, 6101] });
		open.push(attachStream(server, { ...deps, streamCount: 0, rooms }) ?? { close() {} });
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const port = (server.address() as { port: number }).port;

		const answer = await rawUpgrade(port, '/stream/kitchen-table/0/websockify');
		expect(answer).toMatch(/^HTTP\/1\.1 404 /);
		// 403 would tell an outsider the room is real. See index.ts.
		expect(answer).not.toContain('403');
		// And it never reached the container: no attach was recorded.
		expect(rooms.attaches).toEqual([]);
	});

	it('refuses an anonymous upgrade to a room that does not exist with the SAME 404', async () => {
		// Same answer for "no such room" and "you may not" — the distinction is
		// what a scanner reads off the wire.
		const server = createServer();
		open.push(server);
		open.push(attachStream(server, { ...deps, streamCount: 0, rooms: fakeRooms({}) }) ?? { close() {} });
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const port = (server.address() as { port: number }).port;

		expect(await rawUpgrade(port, '/stream/no-such-room/0/websockify')).toMatch(/^HTTP\/1\.1 404 /);
	});

	it('refuses a non-version-13 upgrade on a room path with 400', async () => {
		const server = createServer();
		open.push(server);
		open.push(attachStream(server, { ...deps, streamCount: 0, rooms: fakeRooms({ abc: [6100] }) }) ?? { close() {} });
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const port = (server.address() as { port: number }).port;

		expect(await rawUpgrade(port, '/stream/abc/0/websockify', '8')).toMatch(/^HTTP\/1\.1 400 /);
	});

	it('attaches nothing when there is neither a bench nor a room allocator', () => {
		const server = createServer();
		open.push(server);
		const before = server.listenerCount('upgrade');
		expect(attachStream(server, { ...deps, streamCount: 0, rooms: null })).toBeNull();
		expect(server.listenerCount('upgrade')).toBe(before);
	});

	it('still leaves other upgrades alone', async () => {
		// socket.io and /play/ws share this server. A stream attach that
		// answered their upgrades would take the whole app down with it.
		const server = createServer();
		open.push(server);
		let sawOther = '';
		server.on('upgrade', (req, socket) => {
			sawOther = req.url ?? '';
			socket.destroy();
		});
		open.push(attachStream(server, { ...deps, streamCount: 1, rooms: fakeRooms({ abc: [6100] }) }) ?? { close() {} });
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const port = (server.address() as { port: number }).port;

		await rawUpgrade(port, '/socket.io/?EIO=4');
		expect(sawOther).toBe('/socket.io/?EIO=4');
	});
});

describe("a room's HTTP half is honest about containers that are not there", () => {
	async function get(app: express.Express, path: string): Promise<{ status: number; body: string }> {
		const server = app.listen(0);
		open.push(server);
		const port = (server.address() as { port: number }).port;
		const res = await fetch(`http://127.0.0.1:${String(port)}${path}`);
		return { status: res.status, body: await res.text() };
	}

	it('says the streams were reclaimed instead of 502ing behind a live-looking link', async () => {
		const app = express();
		attachStreamRoutes(app, { ...deps, streamCount: 0, rooms: fakeRooms({}, ['old-room']) });
		app.use((_req, res) => res.status(200).type('html').send('<html>THE SPA FALLBACK</html>'));

		const answer = await get(app, '/stream/old-room/0/vnc.html');
		expect(answer.status).toBe(410);
		expect(answer.body).toMatch(/reclaimed/);
		expect(answer.body).not.toContain('THE SPA FALLBACK');
	});

	it('asks for the room to be provisioned, and says it is not up yet', async () => {
		const asked: string[] = [];
		const app = express();
		attachStreamRoutes(app, {
			...deps,
			streamCount: 0,
			rooms: fakeRooms({}),
			ensureRoom: (k) => asked.push(k),
		});
		app.use((_req, res) => res.status(200).type('html').send('<html>THE SPA FALLBACK</html>'));

		const answer = await get(app, '/stream/new-room/0/vnc.html');
		expect(answer.status).toBe(503);
		expect(answer.body).not.toContain('THE SPA FALLBACK');
		expect(asked).toEqual(['new-room']);
	});

	it('leaves a path that is neither form to the SPA fallback', async () => {
		const app = express();
		attachStreamRoutes(app, { ...deps, streamCount: 1, rooms: fakeRooms({}) });
		app.use((_req, res) => res.status(200).type('html').send('<html>THE SPA FALLBACK</html>'));

		expect((await get(app, '/stream/not-a-seat')).body).toContain('THE SPA FALLBACK');
	});

	it('THE FRIEND DEMO: the static form still answers with the room form mounted', async () => {
		// /stream/0/ is the link the operator handed out. The room-keyed
		// middleware is registered after the static routes and must never see
		// a static path, whatever else is attached.
		const app = express();
		attachStreamRoutes(app, { ...deps, streamCount: 2, rooms: fakeRooms({ 'kitchen-table': [6100] }) });
		app.use((_req, res) => res.status(200).type('html').send('<html>THE SPA FALLBACK</html>'));

		// 502 (no container in a unit test) is fine; the fallback is not.
		expect((await get(app, '/stream/0/vnc.html')).body).not.toContain('THE SPA FALLBACK');
		expect((await get(app, '/stream/1/vnc.html')).body).not.toContain('THE SPA FALLBACK');
	});
});

describe('the allocator and the route agree on what a room key is', () => {
	it('a key the allocator refuses is a key the route will not route', async () => {
		const rooms = createRoomStreams({
			roomExists: () => true,
			script: {
				up: () => Promise.resolve(),
				down: () => Promise.resolve(),
				list: () => Promise.resolve([]),
				netDown: () => Promise.resolve(),
			},
		});
		expect((await rooms.allocate('7', 2)).ok).toBe(false);
		expect(roomStreamPathOf('/stream/7/0/')).toBeNull();
	});
});
