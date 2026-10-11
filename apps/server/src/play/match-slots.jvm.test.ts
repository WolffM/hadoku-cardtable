/**
 * The server's match slots, against REAL Forge (2026-10-11): a rematch was refused "already running
 * 2 matches". One slot was held by a frozen match both players had left — `seat-departing` for each
 * seat, then nothing, for ~2 h — and one by a match whose game had already ended.
 *
 *  1. Both seats leave a running match: it stops once the rejoin grace runs out, its JVM exits, and
 *     the slot takes a new match.
 *  2. A game ends: a new match starts at once, with the finished one still in the only slot.
 *
 * `maxMatches: 1` stands in for production's ceiling (2 then, 10 since): the rule is the same at
 * any ceiling, and one JVM at a time is what a claw has room for.
 *
 * Skips visibly without a Forge build, like every `*.jvm.test.ts`:
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/match-slots.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import express from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { ClientFrameSchema } from '@hadoku/forge-wire';

import { jvmHostConfig, jvmHostFactory, liveJvmCount } from './host.js';

const EDGE_SECRET = 'test-edge-auth-secret';
const available = jvmHostConfig();
const title = available.ok ? 'match slots, against real Forge' : `match slots, against real Forge — SKIPPED: ${available.reason}`;

let socketMod: typeof import('./socket.ts');
let edgeMod: typeof import('../edge-auth.ts');

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	process.env.CARDTABLE_PLAY_SEED = '7';
	vi.resetModules();
	socketMod = await import('./socket.ts');
	edgeMod = await import('../edge-auth.ts');
});

const sockets: ClientSocket[] = [];
let closeServer: (() => Promise<void>) | null = null;

afterEach(async () => {
	for (const s of sockets.splice(0)) s.disconnect();
	await closeServer?.();
	closeServer = null;
});

const edge = (user: string): Record<string, string> => ({
	'x-edge-auth': EDGE_SECRET,
	'x-hadoku-tier': 'friend',
	'x-user-id': `user-${user}`,
	'x-user-key': `friend-key-${user}`,
});

interface Frame {
	kind: string;
	method: string;
	[k: string]: unknown;
}

interface Peer {
	socket: ClientSocket;
	frames: Frame[];
}

async function peer(port: number, user: string, matchId: string): Promise<Peer> {
	const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['polling'], extraHeaders: edge(user), forceNew: true, reconnection: false });
	sockets.push(socket);
	await new Promise<void>((done, fail) => {
		socket.on('connect', () => done());
		socket.on('connect_error', fail);
	});
	const frames: Frame[] = [];
	socket.on('forge:s2c', (p: { frame: Frame }) => frames.push(p.frame));
	const ack = (await socket.timeout(20_000).emitWithAck('forge:join', { matchId })) as { frames: Frame[] };
	frames.unshift(...ack.frames);
	return { socket, frames };
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

function deck(name: string): string {
	return `[metadata]\nName=${name}\n[main]\n30 Mountain\n30 Memnite\n`;
}

const last = (frames: Frame[], method: string): Frame | undefined => [...frames].reverse().find((f) => f.method === method);

/** One server, one slot, real Forge behind it. */
async function server(options: { disconnectGraceMs: number; rejoinGraceMs: number }) {
	if (!available.ok) throw new Error(available.reason);
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	app.use('/api', api);
	const http: HttpServer = createServer(app);
	const io = new SocketIOServer(http, { serveClient: false });
	const logs: Record<string, unknown>[] = [];
	const handle = socketMod.attachPlay(io, api, {
		minTier: 'friend',
		host: jvmHostFactory(available.config, { spare: false }),
		log: (e) => logs.push(e),
		startTimeoutMs: 120_000,
		joinWaitMs: 60_000,
		askTimeoutMs: 120_000,
		maxMatches: 1,
		...options,
	});
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	closeServer = async () => {
		handle.close();
		io.close();
		await new Promise<void>((done) => http.close(() => done()));
		await waitUntil(() => liveJvmCount() === 0, 'every JVM to exit', 30_000);
	};
	const port = (http.address() as AddressInfo).port;
	const start = () =>
		fetch(`http://127.0.0.1:${port}/api/play/matches`, {
			method: 'POST',
			headers: { ...edge('alice'), 'content-type': 'application/json' },
			body: JSON.stringify({ opponent: 'human', decks: [deck('R A'), deck('R B')] }),
		});
	return { port, handle, logs, start };
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'a running match both seats have left stops after the rejoin grace, its JVM exits, and the slot takes a new match',
		async () => {
			const s = await server({ disconnectGraceMs: 1000, rejoinGraceMs: 5000 });
			const res = await s.start();
			expect(res.status).toBe(201);
			const matchId = ((await res.json()) as { matchId: string }).matchId;
			const peers = [await peer(s.port, 'alice', matchId), await peer(s.port, 'bob', matchId)];
			await waitUntil(() => peers.every((p) => last(p.frames, 'showPromptMessage') !== undefined), 'both seats to be prompted', 60_000);
			const refused = await s.start();
			console.log(`[bb-slots] occupied: second start answered ${refused.status} ${await refused.text()}`);
			expect(refused.status).toBe(503);

			const left = Date.now();
			for (const p of peers) p.socket.disconnect();
			await waitUntil(() => s.handle.matches.get(matchId)?.status === 'stopped', 'the match nobody is at to stop', 30_000);
			await waitUntil(() => liveJvmCount() === 0, 'its JVM to exit', 30_000);
			console.log(`[bb-slots] abandoned: stopped ${Date.now() - left} ms after both seats left; ${JSON.stringify(s.logs.find((l) => l.evt === 'match-not-rejoined'))}`);

			const next = await s.start();
			console.log(`[bb-slots] abandoned: next start answered ${next.status}`);
			expect(next.status).toBe(201);
		},
		300_000,
	);

	it(
		'a finished game holds no slot: a new match starts at once beside it',
		async () => {
			const s = await server({ disconnectGraceMs: 30_000, rejoinGraceMs: 5 * 60_000 });
			const res = await s.start();
			expect(res.status).toBe(201);
			const matchId = ((await res.json()) as { matchId: string }).matchId;
			const peers = [await peer(s.port, 'alice', matchId), await peer(s.port, 'bob', matchId)];
			const act = (seat: number, frame: Record<string, unknown>): void => {
				peers[seat]!.socket.emit('forge:c2s', { matchId, frame: ClientFrameSchema.parse(frame) });
			};

			// Both keep: press every live OK until the game proper has a priority prompt.
			const pressed = [-1, -1];
			await waitUntil(
				() => {
					for (const seat of [0, 1]) {
						const p = peers[seat]!;
						const buttons = last(p.frames, 'updateButtons');
						const at = p.frames.lastIndexOf(buttons as Frame);
						if (buttons?.enable1 === true && at !== pressed[seat]) {
							pressed[seat] = at;
							act(seat, { kind: 'act', method: 'selectButtonOk' });
						}
					}
					return peers.some((p) => /^Priority:/.test(String(last(p.frames, 'showPromptMessage')?.message ?? '')));
				},
				'the game proper to start',
				90_000,
			);

			act(1, { kind: 'act', method: 'concede' });
			await waitUntil(() => s.handle.matches.get(matchId)?.status === 'over', 'the game to end', 60_000);

			const rematch = await s.start();
			console.log(`[bb-slots] over: rematch start answered ${rematch.status}; the finished match is ${s.handle.matches.get(matchId)?.status}`);
			expect(rematch.status).toBe(201);
			expect(s.handle.matches.get(matchId)?.status, 'the finished match is still readable').toBe('over');
		},
		300_000,
	);
});
