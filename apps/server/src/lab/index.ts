/*
 * `/lab/**` — a temporary A/B bench for the two browser-Forge routes.
 *
 * ## Why this exists, and when it must go
 *
 * Waves 14-16 measured CheerpJ and streamed Forge on loopback, where RTT is
 * zero. The comparison that decides the route is RTT-dependent — the crossover
 * is at 50 ms of the player's own round trip — so a loopback measurement
 * cannot answer it. This puts both routes behind the SAME tunnel and edge the
 * app already uses, so what the operator feels is what a player would feel.
 *
 * **It is production code for a test, and it is scheduled for deletion in
 * w17 regardless of which route wins.** If you are reading this after that
 * wave, it should not be here.
 *
 * ## Inert unless switched on
 *
 * `attachLab` returns null when `CARDTABLE_LAB` is not `1`. No route, no
 * listener, no proxy. The default production posture is exactly as though this
 * file did not exist, which is the only honest way to ship a bench.
 *
 * ## The gate
 *
 * Both halves sit BELOW `requireMinTier`, and the websocket half re-applies the
 * floor itself — `sanitizeHeaders` then `tierOf`, refusing with 404 — because
 * an `upgrade` event runs no express middleware. That is the same two steps in
 * the same order as `play/browser/index.ts`, deliberately: a second pattern for
 * the same check is how one of them drifts.
 *
 * **404, never 403.** A different answer for "exists but you may not" tells an
 * outsider which paths are real, and this app answers that way everywhere else.
 *
 * ## What is NOT isolated, and the operator has been told
 *
 * One streamed container is ONE Forge session. Two friend-tier callers opening
 * the same `/lab/stream/<n>/` drive the same window. That is acceptable for a
 * two-person bench that is watched while it runs; it is not acceptable to
 * leave running, and it is a second reason this is temporary.
 */

import { createServer as _unusedCreateServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { connect, type Socket } from 'node:net';
import express, { type Request, type Router } from 'express';

import { rankOf, sanitizeHeaders, tierOf } from '../edge-auth.js';

void _unusedCreateServer;

export interface LabDeps {
	/** The tier floor. `CONFIG.minTier` — never lower, never a new tier. */
	minTier: string;
	/** Staged CheerpJ site (index.html, forge.jar, res/…). Absent → that half is off. */
	cheerpjDir: string | null;
	/** Container n's noVNC port is `streamBasePort + n`. */
	streamBasePort: number;
	/** How many stream containers to expose. 0 → that half is off. */
	streamCount: number;
	log?: (entry: Record<string, unknown>) => void;
}

export interface LabHandle {
	close(): void;
}

/** `/lab/stream/3/websockify` → 3, or null when the path is not a stream path. */
export function streamIndexOf(url: string | undefined, count: number): number | null {
	if (url === undefined) return null;
	const m = /^\/lab\/stream\/(\d+)(?:\/|$)/.exec(url.split('?')[0] ?? '');
	if (m === null) return null;
	const n = Number(m[1]);
	return Number.isInteger(n) && n >= 0 && n < count ? n : null;
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

export function attachLab(app: Router, server: Server, deps: LabDeps): LabHandle | null {
	if (process.env.CARDTABLE_LAB !== '1') return null;
	const log = deps.log ?? (() => {});

	const lab = express.Router();

	// ── CheerpJ: static, and that is the whole of it ──────────────────────────
	// The site is a directory of files. It needs no proxy, which is why only the
	// streamed half below is real plumbing.
	if (deps.cheerpjDir !== null) {
		lab.use('/cheerpj', express.static(deps.cheerpjDir, { index: 'index.html', dotfiles: 'ignore' }));
		log({ evt: 'lab-cheerpj', dir: deps.cheerpjDir });
	}

	// ── Streamed Forge: HTTP to noVNC, and the upgrade below ──────────────────
	for (let n = 0; n < deps.streamCount; n += 1) {
		const port = deps.streamBasePort + n;
		lab.use(`/stream/${String(n)}`, (req, res) => {
			const upstream = connect({ host: '127.0.0.1', port }, () => {
				const path = req.url === '' ? '/' : req.url;
				upstream.write(`${req.method ?? 'GET'} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nConnection: close\r\n\r\n`);
			});
			upstream.on('error', () => {
				if (!res.headersSent) res.status(502).type('text').send(`no stream container on ${String(port)}`);
			});
			// Raw pipe: noVNC's own HTML/JS, unmodified.
			upstream.pipe(res.socket ?? res);
			res.socket?.on('close', () => upstream.destroy());
		});
	}

	app.use('/lab', lab);

	// ── The websocket half ────────────────────────────────────────────────────
	// noVNC talks RFB over a websocket to websockify. express never sees an
	// `upgrade`, so the floor is re-applied here by hand.
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
			log({ evt: 'lab-refused', reason: 'below the tier floor', tier });
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
		log({ evt: 'lab-stream-open', container: n, tier });
	};

	server.on('upgrade', onUpgrade);
	log({ evt: 'lab-attached', cheerpj: deps.cheerpjDir !== null, streams: deps.streamCount });

	return {
		close(): void {
			server.off('upgrade', onUpgrade);
		},
	};
}
