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

import { attachStream, attachStreamRoutes, streamIndexOf, streamLayout } from './index.ts';

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
