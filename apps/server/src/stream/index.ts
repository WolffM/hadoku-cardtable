/*
 * `/stream/**` — Forge's own desktop UI, streamed from a container.
 *
 * ## What this is
 *
 * The product keeps two game frontends: our React board, and Forge's own UI
 * for whoever wants the full client (operator decision, 2026-09-20: the old
 * UI stays an option). This route is the second frontend in its interim
 * form: a fixed set of containers on this host, each running one Forge
 * desktop with websockify on `STREAM_BASE_PORT + n`, proxied through the app
 * so it sits behind the same edge and the same friend gate as everything
 * else. The noVNC page itself is served by websockify inside the container —
 * nothing here is vendored, and no image bytes pass through this repo.
 *
 * What is interim about it, on purpose (the stream track replaces it):
 * one container is ONE Forge session, shared by everyone who opens its link;
 * a two-player match is started by hand through Forge's own Online lobby;
 * the containers are run and restarted by the operator, not by this app.
 *
 * ## The switch is a file, and it is on this host
 *
 * `STREAM_DIR/STREAMS` names how many containers are up. Absent, unreadable
 * or malformed → zero containers → this attaches nothing: no route, no
 * listener, no proxy. The PM2 wrapper forwards a fixed env set, so a file on
 * disk is the switch an operator can actually flip — and the one an auditor
 * can see in a directory listing.
 *
 * ## The gate
 *
 * The HTTP half is mounted below `requireMinTier`. The websocket half
 * re-applies the floor itself — `sanitizeHeaders` then `tierOf`, refusing
 * with 404 — because an `upgrade` event runs no express middleware. That is
 * the same two steps in the same order as `play/browser/index.ts`,
 * deliberately: a second pattern for the same check is how one of them drifts.
 *
 * **404, never 403.** A different answer for "exists but you may not" tells
 * an outsider which paths are real, and this app answers that way everywhere
 * else.
 */

import type { IncomingMessage, Server } from 'node:http';
import type { Request, Router } from 'express';
import type { Duplex } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import express from 'express';

import { rankOf, sanitizeHeaders, tierOf } from '../edge-auth.js';

export interface StreamDeps {
	/** The tier floor. `CONFIG.minTier` — never lower, never a new tier. */
	minTier: string;
	/** Container n's noVNC port is `streamBasePort + n`. */
	streamBasePort: number;
	/** How many stream containers to expose. 0 → attach nothing. */
	streamCount: number;
	log?: (entry: Record<string, unknown>) => void;
}

export interface StreamHandle {
	close(): void;
}

/** Container n's noVNC port. The containers publish 127.0.0.1:6080+n. */
export const STREAM_BASE_PORT = Number(process.env.CARDTABLE_STREAM_PORT ?? 6080);

/** `/stream/3/websockify` → 3, or null when the path is not a stream path. */
export function streamIndexOf(url: string | undefined, count: number): number | null {
	if (url === undefined) return null;
	const m = /^\/stream\/(\d+)(?:\/|$)/.exec(url.split('?')[0] ?? '');
	if (m === null) return null;
	const n = Number(m[1]);
	return Number.isInteger(n) && n >= 0 && n < count ? n : null;
}

export const STREAM_DIR = join(homedir(), '.local', 'share', 'cardtable', 'stream');
export const STREAMS_FILE = join(STREAM_DIR, 'STREAMS');

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

function refuse(socket: Duplex, code: number, why: string): void {
	socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`);
	socket.destroy();
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
	if (deps.streamCount < 1) return false;
	const log = deps.log ?? (() => {});
	const stream = express.Router();

	for (let n = 0; n < deps.streamCount; n += 1) {
		const port = deps.streamBasePort + n;
		stream.use(`/${String(n)}`, (req, res) => {
			const upstream = connect({ host: '127.0.0.1', port }, () => {
				const path = req.url === '' ? '/' : req.url;
				upstream.write(`${req.method ?? 'GET'} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nConnection: close\r\n\r\n`);
			});
			upstream.on('error', () => {
				if (!res.headersSent) res.status(502).type('text').send(`no stream container on ${String(port)}`);
			});
			upstream.pipe(res.socket ?? res);
			res.socket?.on('close', () => upstream.destroy());
		});
	}

	app.use('/stream', stream);
	log({ evt: 'stream-routes', streams: deps.streamCount });
	return true;
}

/**
 * The websocket half: noVNC talks RFB over a websocket to websockify.
 * express never sees an `upgrade`, so the tier floor is re-applied here by
 * hand, exactly as `attachBrowserBridge` does.
 */
export function attachStream(server: Server, deps: StreamDeps): StreamHandle | null {
	if (deps.streamCount < 1) return null;
	const log = deps.log ?? (() => {});

	const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
		const n = streamIndexOf(req.url, deps.streamCount);
		if (n === null) return; // not ours — socket.io and play/browser get their turn
		if (!isWebSocketUpgrade(req)) {
			refuse(socket, 400, 'expected a version-13 websocket upgrade');
			return;
		}

		sanitizeHeaders(req.headers as Record<string, unknown>);
		const tier = tierOf({ headers: req.headers } as unknown as Request);
		if (rankOf(tier) < rankOf(deps.minTier)) {
			log({ evt: 'stream-refused', reason: 'below the tier floor', tier });
			refuse(socket, 404, 'not found');
			return;
		}

		const port = deps.streamBasePort + n;
		const upstream: Socket = connect({ host: '127.0.0.1', port }, () => {
			// Replay the handshake verbatim; websockify does its own accept.
			const lines = [`GET ${req.url ?? '/'} HTTP/1.1`];
			for (const [k, v] of Object.entries(req.headers)) {
				for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) lines.push(`${k}: ${one}`);
			}
			upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
			if (head.length > 0) upstream.write(head);
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		upstream.on('error', () => refuse(socket, 502, 'no stream container'));
		socket.on('error', () => upstream.destroy());
		log({ evt: 'stream-open', container: n, tier });
	};

	server.on('upgrade', onUpgrade);
	log({ evt: 'stream-attached', streams: deps.streamCount });

	return {
		close(): void {
			server.off('upgrade', onUpgrade);
		},
	};
}
