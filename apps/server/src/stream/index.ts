/*
 * `/stream/**` — Forge's own desktop UI, streamed from a container.
 *
 * ## What this is
 *
 * The product keeps two game frontends: our React board, and Forge's own UI
 * for whoever wants the full client (operator decision, 2026-09-20: the old
 * UI stays an option). This route serves that second frontend from containers
 * on this host, each running one Forge desktop with websockify, proxied
 * through the app so it sits behind the same edge and the same friend gate as
 * everything else. The noVNC page itself is served by websockify inside the
 * container — nothing here is vendored, and no image bytes pass through this
 * repo.
 *
 * ## Two forms, deliberately disjoint
 *
 * - **`/stream/<n>/`** — the static bench. A fixed set of containers an
 *   operator starts by hand; `n` is an index into them. This is the friend
 *   demo's link and it keeps working exactly as it did.
 * - **`/stream/<roomKey>/<seat>/`** — a room's own containers, one per seat,
 *   provisioned and reclaimed by `alloc.ts` (D19: the client is the ROOM's
 *   choice, made at create).
 *
 * The two namespaces cannot collide: a static index is all digits and a room
 * key that is all digits is refused at allocation (`isStaticIndexLike`), so
 * `streamIndexOf` never has to guess and never swallows a room key.
 *
 * ## The switch for the static half is a file, and it is on this host
 *
 * `STREAM_DIR/STREAMS` names how many containers are up. Absent, unreadable
 * or malformed → zero containers → the static half attaches nothing. The PM2
 * wrapper forwards a fixed env set, so a file on disk is the switch an
 * operator can actually flip — and the one an auditor can see in a directory
 * listing. Room-keyed streams do not read it: a room's containers are the
 * room's, and their switch is the room's own mode.
 *
 * ## The gate
 *
 * The HTTP half is mounted below `requireMinTier`. The websocket half
 * re-applies the floor itself — `sanitizeHeaders` then `tierOf`, refusing
 * with 404 — because an `upgrade` event runs no express middleware. That is
 * the same two steps in the same order as `play/browser/index.ts`,
 * deliberately: a second pattern for the same check is how one of them drifts.
 * **Both forms run the same `passesFloor`**, one function, for the same
 * reason.
 *
 * **404, never 403.** A different answer for "exists but you may not" tells
 * an outsider which paths are real, and this app answers that way everywhere
 * else. A room whose containers were reclaimed answers 410 — but only AFTER
 * the floor, so it tells a friend the truth and an outsider nothing.
 */

import type { IncomingMessage, Server } from 'node:http';
import type { Request, Response, Router } from 'express';
import type { Duplex } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import { request as httpRequest } from 'node:http';
import express from 'express';

import { rankOf, sanitizeHeaders, tierOf } from '../edge-auth.js';
import { ROOM_ID_RE } from '@hadoku/shared';
import { isStaticIndexLike, type RoomStreams } from './alloc.js';

export interface StreamDeps {
	/** The tier floor. `CONFIG.minTier` — never lower, never a new tier. */
	minTier: string;
	/** Container n's noVNC port is `streamBasePort + n`. */
	streamBasePort: number;
	/** How many STATIC stream containers to expose. 0 → attach none of them. */
	streamCount: number;
	/** Room-keyed streams. Absent → only the static form exists. */
	rooms?: RoomStreams | null;
	/**
	 * Called when a room-keyed path names a room with no live containers.
	 * Fire-and-forget: provisioning is ~18 s of cold boot, so the request that
	 * triggered it is answered honestly ("not up yet") rather than held open.
	 * Wired in `index.ts`, where the lobby is in scope.
	 */
	ensureRoom?: (roomKey: string) => void;
	log?: (entry: Record<string, unknown>) => void;
}

export interface StreamHandle {
	close(): void;
}

/** `/stream/3/websockify` → 3, or null when the path is not a stream path. */
export function streamIndexOf(url: string | undefined, count: number): number | null {
	if (url === undefined) return null;
	const m = /^\/stream\/(\d+)(?:\/|$)/.exec(url.split('?')[0] ?? '');
	if (m === null) return null;
	const n = Number(m[1]);
	return Number.isInteger(n) && n >= 0 && n < count ? n : null;
}

export interface RoomStreamPath {
	roomKey: string;
	seat: number;
	/** What is left for the container: `/vnc.html`, `/websockify`, `/`. */
	rest: string;
}

/**
 * `/stream/kitchen-table/1/vnc.html` → that room's seat 1.
 *
 * Null for anything else — including a key that is all digits, which belongs
 * to the static form and is refused at allocation for exactly this reason.
 * The seat is bounded to two digits because a room has at most eight.
 */
export function roomStreamPathOf(url: string | undefined): RoomStreamPath | null {
	if (url === undefined) return null;
	const [path = '', query] = url.split('?');
	const m = /^\/stream\/([^/]+)\/(\d{1,2})(\/.*)?$/.exec(path);
	if (m === null) return null;
	const roomKey = m[1] ?? '';
	if (!ROOM_ID_RE.test(roomKey) || isStaticIndexLike(roomKey)) return null;
	const rest = m[3] ?? '/';
	return { roomKey, seat: Number(m[2]), rest: query === undefined ? rest : `${rest}?${query}` };
}

const STREAM_DIR = join(homedir(), '.local', 'share', 'cardtable', 'stream');
const STREAMS_FILE = join(STREAM_DIR, 'STREAMS');

/**
 * How many containers to expose, read from `STREAMS` on disk.
 *
 * A malformed count is zero containers, not a guess — each container is a
 * proxy to a port, and guessing here is a port scan. Bounded because an
 * unbounded count is the same scan with more steps.
 */
export function streamLayout(
	exists: (p: string) => boolean = existsSync,
	read: (p: string) => string = (f) => readFileSync(f, 'utf8'),
): { streamCount: number } {
	try {
		const raw = exists(STREAMS_FILE) ? read(STREAMS_FILE).trim() : '0';
		const n = Number(raw);
		return { streamCount: Number.isInteger(n) && n >= 0 && n <= 8 ? n : 0 };
	} catch {
		// An unreadable count is not an on switch. Failing closed is the only
		// safe direction for a thing that opens a proxy.
		return { streamCount: 0 };
	}
}

/** True only for a version-13 websocket upgrade, as `play/browser` requires. */
function isWebSocketUpgrade(req: IncomingMessage): boolean {
	return (
		String(req.headers.upgrade ?? '').toLowerCase() === 'websocket' &&
		String(req.headers['sec-websocket-version'] ?? '') === '13'
	);
}

/**
 * The tier floor, applied by hand.
 *
 * ONE function, called by both stream forms, because two copies of a check is
 * how one of them drifts. Mutating it is how this file's guard is
 * mutation-tested: revert the comparison and every 404 test must go red.
 */
function passesFloor(req: IncomingMessage, minTier: string): { ok: boolean; tier: string } {
	sanitizeHeaders(req.headers as Record<string, unknown>);
	const tier = tierOf({ headers: req.headers } as unknown as Request);
	return { ok: rankOf(tier) >= rankOf(minTier), tier };
}

function refuse(socket: Duplex, code: number, why: string): void {
	socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`);
	socket.destroy();
}

/**
 * One HTTP hop into a container's websockify. Both forms proxy identically.
 *
 * **A parsed hop, not a socket splice.** This wrote the request by hand and
 * piped the upstream SOCKET into `res.socket` — raw status line and headers
 * straight onto the wire, around express. That survives one request on a fresh
 * connection, which is how the static bench is used and why it looked fine.
 * A browser loading noVNC does not do that: it opens keep-alive connections
 * and pulls `app/ui.js`, `core/*.js` and a dozen assets in parallel, and a
 * spliced response leaves express believing the response is still pending, so
 * the next request on that connection is answered with garbage. The visible
 * result was a noVNC page whose JavaScript 502'd, on a container that was
 * healthy — a black seat with no error a player could act on. Found by
 * `e2e/streamed-live.spec.ts`, 2026-09-24.
 *
 * Parsing the upstream response and copying status + headers onto `res` keeps
 * node's own connection handling in charge of both sides, which is what makes
 * concurrent asset loads work.
 */
function proxyHttp(req: Request, res: Response, port: number, path: string): void {
	const upstream = httpRequest(
		{
			host: '127.0.0.1',
			port,
			method: req.method ?? 'GET',
			path,
			// The container answers on loopback and does not virtual-host, but a
			// correct Host keeps websockify's own logging honest.
			headers: { ...req.headers, host: `127.0.0.1:${String(port)}` },
		},
		(up) => {
			res.status(up.statusCode ?? 502);
			for (const [k, v] of Object.entries(up.headers)) {
				// node re-computes framing headers for our own response; copying
				// them would describe the upstream's body, not ours.
				if (v === undefined || k === 'connection' || k === 'transfer-encoding') continue;
				res.setHeader(k, v);
			}
			up.pipe(res);
		},
	);
	upstream.on('error', () => {
		if (!res.headersSent) res.status(502).type('text').send(`no stream container on ${String(port)}`);
	});
	res.on('close', () => upstream.destroy());
	req.pipe(upstream);
}

/**
 * The HTTP half: noVNC's pages and assets, straight out of websockify.
 *
 * **Must be registered BEFORE the SPA fallback.** Below it, the fallback
 * answers `/stream/0/vnc.html` with index.html and the link renders the
 * cardtable app instead of noVNC — which is exactly what happened to this
 * route's bench predecessor on 2026-09-21, and read like two browsers
 * joining one room.
 */
export function attachStreamRoutes(app: Router, deps: StreamDeps): boolean {
	const rooms = deps.rooms ?? null;
	if (deps.streamCount < 1 && rooms === null) return false;
	const log = deps.log ?? ((): void => {});
	const stream = express.Router();

	// The static bench, first: these paths terminate, so the room-keyed
	// middleware below never sees them.
	for (let n = 0; n < deps.streamCount; n += 1) {
		const port = deps.streamBasePort + n;
		stream.use(`/${String(n)}`, (req, res) => {
			proxyHttp(req, res, port, req.url === '' ? '/' : req.url);
		});
	}

	if (rooms !== null) {
		stream.use((req, res, next) => {
			// `stream` is mounted at /stream, so req.url arrives without it;
			// one parser serves both halves, so put it back.
			const target = roomStreamPathOf(`/stream${req.url}`);
			if (target === null) {
				next();
				return;
			}
			const port = rooms.portOf(target.roomKey, target.seat);
			if (port === null) {
				const status = rooms.statusOf(target.roomKey);
				deps.ensureRoom?.(target.roomKey);
				// Honest, and never a live-looking 502: a reclaimed room says it
				// was reclaimed, a room still booting says it is not up yet.
				if (status.state === 'dead') {
					res
						.status(410)
						.type('text')
						.send(`this room's streams were reclaimed (${status.reason ?? 'unknown'}) — start the room again`);
				} else {
					res.status(503).type('text').send('no stream for this seat yet');
				}
				return;
			}
			proxyHttp(req, res, port, target.rest);
		});
	}

	app.use('/stream', stream);
	log({ evt: 'stream-routes', streams: deps.streamCount, rooms: rooms !== null });
	return true;
}

/**
 * The websocket half: noVNC talks RFB over a websocket to websockify.
 * express never sees an `upgrade`, so the tier floor is re-applied here by
 * hand, exactly as `attachBrowserBridge` does.
 */
export function attachStream(server: Server, deps: StreamDeps): StreamHandle | null {
	const rooms = deps.rooms ?? null;
	if (deps.streamCount < 1 && rooms === null) return null;
	const log = deps.log ?? ((): void => {});

	const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
		const n = streamIndexOf(req.url, deps.streamCount);
		const roomPath = n === null && rooms !== null ? roomStreamPathOf(req.url) : null;
		if (n === null && roomPath === null) return; // not ours — socket.io and play/browser get their turn
		if (!isWebSocketUpgrade(req)) {
			refuse(socket, 400, 'expected a version-13 websocket upgrade');
			return;
		}

		const floor = passesFloor(req, deps.minTier);
		if (!floor.ok) {
			log({ evt: 'stream-refused', reason: 'below the tier floor', tier: floor.tier });
			refuse(socket, 404, 'not found');
			return;
		}

		let port: number;
		let roomKey: string | null = null;
		if (roomPath !== null && rooms !== null) {
			const found = rooms.portOf(roomPath.roomKey, roomPath.seat);
			if (found === null) {
				const status = rooms.statusOf(roomPath.roomKey);
				deps.ensureRoom?.(roomPath.roomKey);
				// Post-floor, so this tells a friend the truth and an outsider
				// nothing: they were refused with 404 above.
				refuse(socket, status.state === 'dead' ? 410 : 503, status.state === 'dead' ? 'gone' : 'no stream yet');
				return;
			}
			port = found;
			roomKey = roomPath.roomKey;
		} else {
			port = deps.streamBasePort + (n ?? 0);
		}

		const upstream: Socket = connect({ host: '127.0.0.1', port }, () => {
			// Replay the handshake verbatim; websockify does its own accept.
			const lines = [`GET ${roomPath === null ? (req.url ?? '/') : roomPath.rest} HTTP/1.1`];
			for (const [k, v] of Object.entries(req.headers)) {
				for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) lines.push(`${k}: ${one}`);
			}
			upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
			if (head.length > 0) upstream.write(head);
			upstream.pipe(socket);
			socket.pipe(upstream);
			if (roomKey !== null && rooms !== null) {
				// Somebody is watching: the idle window is not running.
				rooms.noteAttach(roomKey);
				const key = roomKey;
				socket.once('close', () => rooms.noteDetach(key));
			}
		});
		upstream.on('error', () => refuse(socket, 502, 'no stream container'));
		socket.on('error', () => upstream.destroy());
		log({ evt: 'stream-open', container: n, room: roomKey, seat: roomPath?.seat, tier: floor.tier });
	};

	server.on('upgrade', onUpgrade);
	log({ evt: 'stream-attached', streams: deps.streamCount, rooms: rooms !== null });

	return {
		close(): void {
			server.off('upgrade', onUpgrade);
		},
	};
}
