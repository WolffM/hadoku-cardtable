/**
 * Wave 31 §S, P10 — a reload with a SELECTION open is no longer a soft-lock,
 * proved over REAL sockets against a REAL Forge match.
 *
 * The operator's second 2026-09-30 play test: the London bottom pick is a
 * decision Forge publishes as `setHighlighted` (`InputLondonMulligan`), and a
 * reload dropped it — the new page held the prompt and the OK/Auto bar but no
 * mark, and Forge was still waiting. `Match.resendAfterSnapshot` now re-sends
 * the open selection, the marks and the actionable set; this drives the same
 * thing end to end: reach a step where Forge has an open input the seat has
 * already acted on, drop the socket, rejoin, and assert the new socket is sent
 * the same marks.
 *
 * The step is found by prompt text, not by position, so it holds whichever
 * order the fork's mulligan uses (lane F moves the bottom pick to after Keep).
 *
 * Skips visibly without a Forge build, like every `*.jvm.test.ts`:
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/reload.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import express from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { ClientFrameSchema, deltaKey, DELTA_TYPE } from '@hadoku/forge-wire';

import { jvmHostConfig, jvmHostFactory, liveJvmCount } from './host.js';
import { foldFrames, type StateFrame } from './visibility.js';

const EDGE_SECRET = 'test-edge-auth-secret';
const available = jvmHostConfig();
const title = available.ok
	? 'a reload with a selection open, against real Forge'
	: `a reload with a selection open, against real Forge — SKIPPED: ${available.reason}`;

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
	/** Every frame, in arrival order. */
	frames: Frame[];
	playerId: number;
	ack: unknown;
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
	const ack = (await socket.timeout(20_000).emitWithAck('forge:join', { matchId })) as { playerId: number; frames: Frame[] };
	frames.unshift(...ack.frames);
	return { socket, frames, playerId: ack.playerId, ack };
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

/** The ids in this seat's hand, folded from the state frames it was sent. */
function handOf(p: Peer): number[] {
	const state = foldFrames(
		p.frames.filter((f) => f.kind === 'notify').filter((f) => ['setGameView', 'applyDelta', 'openView'].includes(f.method)) as unknown as StateFrame[],
	);
	const me = state.get(deltaKey(DELTA_TYPE.player, p.playerId)) as unknown as Record<string, { v?: { v: number }[] }> | undefined;
	return (me?.['Hand']?.v ?? []).map((c) => c.v);
}

describe.skipIf(!available.ok)(title, () => {
	it(
		're-sends the marks Forge holds open to a socket that rejoins, and the same card is still clickable',
		async () => {
			if (!available.ok) return;
			const app = express();
			app.use(edgeMod.edgeProvenance);
			app.use(edgeMod.requireMinTier);
			const api = express.Router();
			app.use('/api', api);
			const http: HttpServer = createServer(app);
			const io = new SocketIOServer(http, { serveClient: false });
			const jvm = jvmHostFactory(available.config, { spare: false });
			const handle = socketMod.attachPlay(io, api, {
				minTier: 'friend',
				host: jvm,
				startTimeoutMs: 120_000,
				joinWaitMs: 60_000,
				disconnectGraceMs: 60_000,
			});
			await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
			closeServer = async () => {
				handle.close();
				io.close();
				await new Promise<void>((done) => http.close(() => done()));
				await waitUntil(() => liveJvmCount() === 0, 'the JVM to exit', 20_000);
			};
			const port = (http.address() as AddressInfo).port;

			const res = await fetch(`http://127.0.0.1:${port}/api/play/matches`, {
				method: 'POST',
				headers: { ...edge('alice'), 'content-type': 'application/json' },
				body: JSON.stringify({ opponent: 'human', decks: [deck('R A'), deck('R B')] }),
			});
			expect(res.status).toBe(201);
			const matchId = ((await res.json()) as { matchId: string }).matchId;
			const peers = [await peer(port, 'alice', matchId), await peer(port, 'bob', matchId)];
			const act = (seat: number, frame: Record<string, unknown>): void => {
				peers[seat]!.socket.emit('forge:c2s', { matchId, frame: ClientFrameSchema.parse(frame) });
			};

			// Play the opening like the mulligan test: seat 0 mulligans while it can, both
			// press OK otherwise, until one seat is asked to put a card on the bottom.
			const handled = [0, 0];
			let london = -1;
			const deadline = Date.now() + 60_000;
			while (london < 0 && Date.now() < deadline) {
				for (const seat of [0, 1]) {
					const p = peers[seat]!;
					const prompt = last(p.frames, 'showPromptMessage');
					const buttons = last(p.frames, 'updateButtons');
					const key = p.frames.indexOf(prompt as Frame);
					if (prompt === undefined || key === handled[seat]) continue;
					handled[seat] = key;
					const message = String(prompt.message);
					if (/bottom of your library/i.test(message)) {
						london = seat;
						break;
					}
					if (/keep your hand|mulligan/i.test(message) && buttons?.enable2 === true && seat === 0) {
						act(seat, { kind: 'act', method: 'selectButtonCancel' });
					} else if (buttons?.enable1 === true) {
						act(seat, { kind: 'act', method: 'selectButtonOk' });
					}
				}
				await new Promise((r) => setTimeout(r, 200));
			}
			expect(london, 'never reached a step asking for a card on the bottom').toBeGreaterThanOrEqual(0);
			const before = peers[london]!;

			// Forge's input is open: click a card of the hand and wait for the mark.
			const card = handOf(before)[0];
			expect(card, 'the seat holds a hand').toBeDefined();
			act(london, { kind: 'act', method: 'selectCard', card: { kind: 'card', id: card }, otherCardViewsToSelect: [], triggerEvent: null });
			await waitUntil(
				() => before.frames.some((f) => f.method === 'setHighlighted' && JSON.stringify(f.entities).includes(`"id":${String(card)}`)),
				'Forge to mark the clicked card',
				20_000,
			);

			// The reload: the old page goes, a new one joins and is handed a snapshot.
			before.socket.disconnect();
			await waitUntil(() => handle.matches.get(matchId)?.seats[london]?.departure != null, 'the old socket to leave', 5_000);
			const after = await peer(port, london === 0 ? 'alice' : 'bob', matchId);
			await waitUntil(() => after.frames.some((f) => f.method === 'setHighlighted'), 'the marks to be re-sent on rejoin', 20_000);

			const resent = last(after.frames.filter((f) => f.method === 'setHighlighted'), 'setHighlighted') as Frame;
			expect(resent.on).toBe(true);
			expect(resent.entities).toContainEqual({ kind: 'card', id: card });
			// And what the page needs around it came too: Forge's prompt and bar.
			expect(last(after.frames, 'showPromptMessage')).toBeDefined();
			expect(last(after.frames, 'updateButtons')).toBeDefined();
			// The seat was NOT left on a dead page: this is still its own input.
			expect(handle.matches.get(matchId)?.status).toBe('running');
		},
		300_000,
	);
});
