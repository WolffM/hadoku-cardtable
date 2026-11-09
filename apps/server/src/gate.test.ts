/**
 * The one handshake gate, proved against the four surfaces that install it:
 * HTTP's `requireMinTier`, the room socket, the play socket, and the stream's
 * raw upgrade. One table, run against a real instance of each — a real
 * `express` app behind `requireMinTier`, a real `socket.io` server behind
 * `attachDraftSocket` and `attachPlay`, and a real `attachStream` upgrade
 * listener — because the claim under test is "every surface's gate call is
 * live", and a stub transport cannot prove a gate call is missing from
 * production wiring.
 *
 * Each surface is asked the same three questions:
 *   1. does it refuse one tier below the floor, and admit at it;
 *   2. does it refuse a caller the edge never vouched for, and one carrying a
 *      forged seal;
 *   3. does it report `seal-refused` exactly once, with today's fields.
 *
 * "Admitted" means different things per transport (a 200, a connected socket,
 * a non-404 upgrade answer), so each surface brings its own `admitted`
 * predicate and the table drives all four through the same three questions.
 */

import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

const EDGE_SECRET = 'test-edge-auth-secret-gate';

/*
 * `config.ts` reads the environment once, at module load — see
 * `room/socket.test.ts`'s own header for why the modules under test are
 * imported dynamically, after the environment is set.
 */
let edgeMod: typeof import('./edge-auth.ts');
let roomSocketMod: typeof import('./room/socket.ts');
let playSocketMod: typeof import('./play/socket.ts');
let streamMod: typeof import('./stream/index.ts');
let lobbyMod: typeof import('./room/lobby.ts');
let telemetryMod: typeof import('./telemetry.ts');

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	edgeMod = await import('./edge-auth.ts');
	roomSocketMod = await import('./room/socket.ts');
	playSocketMod = await import('./play/socket.ts');
	streamMod = await import('./stream/index.ts');
	lobbyMod = await import('./room/lobby.ts');
	telemetryMod = await import('./telemetry.ts');
});

/** Every `report()` call since the last reset. */
let events: Array<[string, Record<string, unknown>]> = [];
beforeEach(() => {
	events = [];
	telemetryMod.installTelemetry((event, context) => events.push([event, context]));
});
afterEach(() => telemetryMod.installTelemetry(() => {}));

function sealRefusals(): Array<Record<string, unknown>> {
	return events.filter(([e]) => e === 'seal-refused').map(([, ctx]) => ctx);
}

/** Headers the edge would stamp for a caller at `tier`. */
function edgeHeaders(tier: string): Record<string, string> {
	return { 'x-edge-auth': EDGE_SECRET, 'x-hadoku-tier': tier, 'x-user-id': 'user-gate-test', 'x-user-key': 'gate-key' };
}

/* ── Harnesses: one real instance of each surface ──────────────────────── */

interface Reachable {
	close(): Promise<void>;
	/** True when `headers` reached whatever is behind the gate. */
	admitted(headers: Record<string, string>): Promise<boolean>;
}

async function bootHttp(): Promise<Reachable> {
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	app.get('/x', (_req, res) => res.status(200).send('ok'));
	const http: HttpServer = createServer(app);
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	const port = (http.address() as AddressInfo).port;
	return {
		close: () => new Promise<void>((done) => http.close(() => done())),
		admitted: async (headers) => {
			const res = await fetch(`http://127.0.0.1:${port}/x`, { headers });
			return res.status === 200;
		},
	};
}

const openSockets: ClientSocket[] = [];

function connectSocket(port: number, headers: Record<string, string>): Promise<ClientSocket> {
	return new Promise((done, fail) => {
		// Polling only: `extraHeaders` is applied to the handshake request, which
		// is the request the gate sanitizes. See `room/socket.test.ts`.
		const socket = ioClient(`http://127.0.0.1:${port}`, {
			transports: ['polling'],
			extraHeaders: headers,
			forceNew: true,
			reconnection: false,
		});
		openSockets.push(socket);
		socket.on('connect', () => done(socket));
		socket.on('connect_error', (err) => fail(err));
	});
}

async function admittedSocket(port: number, headers: Record<string, string>): Promise<boolean> {
	try {
		const socket = await connectSocket(port, headers);
		socket.disconnect();
		return true;
	} catch {
		return false;
	}
}

const lobbyDirs: string[] = [];

async function bootDraftSocket(): Promise<Reachable> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-gate-test-'));
	lobbyDirs.push(dir);
	const lobby = await lobbyMod.openLobby({ dir });
	const http = createServer();
	const io = new SocketIOServer(http, { serveClient: false });
	// No cube pool: this gate test never joins a draft, only the handshake.
	// No disconnect grace exercised here either — a throwaway tracker, never the real `state.seatPresence`.
	const presence = roomSocketMod.createSeatPresence({ seatReleaseMs: roomSocketMod.SEAT_RELEASE_MS, draftGraceOf: () => 0 });
	const handle = roomSocketMod.attachDraftSocket(io, { rooms: null, lobby, minTier: 'friend', log: () => {}, presence });
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	const port = (http.address() as AddressInfo).port;
	return {
		close: async () => {
			handle.close();
			presence.dispose();
			io.close();
			await new Promise<void>((done) => http.close(() => done()));
		},
		admitted: (headers) => admittedSocket(port, headers),
	};
}

async function bootPlaySocket(): Promise<Reachable> {
	const app = express();
	const api = express.Router();
	app.use('/api', api);
	const http = createServer(app);
	const io = new SocketIOServer(http, { serveClient: false });
	// No Forge host: this gate test never starts a match, only the handshake.
	const handle = playSocketMod.attachPlay(io, api, { minTier: 'friend', host: null, log: () => {} });
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	const port = (http.address() as AddressInfo).port;
	return {
		close: async () => {
			handle.close();
			io.close();
			await new Promise<void>((done) => http.close(() => done()));
		},
		admitted: (headers) => admittedSocket(port, headers),
	};
}

/** Speak just enough HTTP by hand to read the upgrade's first answer line off the wire. */
function rawUpgrade(port: number, path: string, headers: Record<string, string>): Promise<string> {
	return new Promise((resolve, reject) => {
		const sock = netConnect(port, '127.0.0.1', () => {
			const lines = [
				`GET ${path} HTTP/1.1`,
				'Host: 127.0.0.1',
				'Connection: Upgrade',
				'Upgrade: websocket',
				'Sec-WebSocket-Version: 13',
				'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
				...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
			];
			sock.write(`${lines.join('\r\n')}\r\n\r\n`);
		});
		let seen = '';
		sock.on('data', (b: Buffer) => {
			seen += b.toString('latin1');
			if (seen.includes('\r\n')) {
				sock.destroy();
				resolve(seen.split('\r\n')[0] ?? seen);
			}
		});
		sock.on('error', reject);
		sock.on('close', () => resolve(seen.split('\r\n')[0] ?? seen));
	});
}

async function bootStream(): Promise<Reachable> {
	const http = createServer();
	const handle = streamMod.attachStream(http, { minTier: 'friend', streamBasePort: 16080, streamCount: 1 });
	if (handle === null) throw new Error('attachStream refused to attach with streamCount: 1');
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	const port = (http.address() as AddressInfo).port;
	return {
		close: async () => {
			handle.close();
			await new Promise<void>((done) => http.close(() => done()));
		},
		// No container is listening on the backing port, so an admitted upgrade
		// never completes — it gets past the gate and then fails upstream (502).
		// A refused one never reaches the upstream dial at all (404). Distinguishing
		// those two is exactly what proves the gate ran.
		admitted: async (headers) => {
			const answer = await rawUpgrade(port, '/stream/0/websockify', headers);
			return !answer.includes(' 404 ');
		},
	};
}

/* ── The table ───────────────────────────────────────────────────────── */

let httpH: Reachable;
let draftH: Reachable;
let playH: Reachable;
let streamH: Reachable;

beforeEach(async () => {
	[httpH, draftH, playH, streamH] = await Promise.all([bootHttp(), bootDraftSocket(), bootPlaySocket(), bootStream()]);
});

afterEach(async () => {
	for (const socket of openSockets.splice(0)) socket.disconnect();
	await Promise.all([httpH.close(), draftH.close(), playH.close(), streamH.close()]);
});

afterAll(async () => {
	for (const dir of lobbyDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** `surface` is `reportSealRefused`'s own label for each — see `edge-auth.ts` and `gate.ts`. */
function surfaces(): Array<[surface: 'http' | 'draft-socket' | 'play-socket' | 'stream', path: string | null, h: () => Reachable]> {
	return [
		['http', '/x', () => httpH],
		['draft-socket', null, () => draftH],
		['play-socket', null, () => playH],
		['stream', '/stream/0/websockify', () => streamH],
	];
}

describe('the one gate: every surface refuses below the floor and admits at it', () => {
	it.each(surfaces())('%s refuses one tier below the floor (member), and admits at it (friend)', async (_surface, _path, h) => {
		expect(await h().admitted(edgeHeaders('member'))).toBe(false);
		expect(await h().admitted(edgeHeaders('friend'))).toBe(true);
	});

	it.each(surfaces())('%s refuses a caller the edge never vouched for, and one carrying a forged seal', async (_surface, _path, h) => {
		// No X-Edge-Auth at all, claiming admin: sanitizeHeaders overwrites the
		// tier with public regardless of what is claimed.
		expect(await h().admitted({ 'x-hadoku-tier': 'admin', 'x-user-key': 'forged' })).toBe(false);
		// The wrong seal: same result as no seal.
		expect(await h().admitted({ 'x-edge-auth': 'not-the-secret', 'x-hadoku-tier': 'friend' })).toBe(false);
	});

	it.each(surfaces())('%s reports seal-refused exactly once, with today\'s fields', async (surface, path, h) => {
		await h().admitted(edgeHeaders('member'));
		const refusals = sealRefusals();
		expect(refusals, JSON.stringify(refusals)).toHaveLength(1);
		expect(refusals[0]).toMatchObject({ surface, path, tier: 'member', userId: 'user-gate-test' });
	});

	it.each(surfaces())('%s reports nothing on an admitted handshake', async (_surface, _path, h) => {
		await h().admitted(edgeHeaders('friend'));
		expect(sealRefusals()).toHaveLength(0);
	});
});
