/**
 * Wave 35 §S follow-up, item 1 regression chase, continued — `two-mana-pass.jvm.test.ts`
 * proves a 2-mana Auto-payment window auto-pays and both seats auto-pass over
 * the bare `Match.fromClient` harness. This drives the SAME cast over the
 * REAL socket path (`attachPlay`, real `socket.io-client` peers, a real jar)
 * instead, the same gap `socket-thoughtseize.jvm.test.ts` found for R4 — to
 * rule in or out a socket-path-only difference as the cause of
 * `play.spec.ts`'s still-failing "a spell resolves unattended".
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w35-s/work \
 *   pnpm exec vitest run apps/server/src/play/socket-two-mana-pass.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import express from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

import { jvmHostConfig, jvmHostFactory } from './host.js';
import { scenarioText } from './scenario.js';
import { foldFrames, keyOf, TYPE } from './visibility.js';

const EDGE_SECRET = 'test-edge-auth-secret';
const available = jvmHostConfig({ ...process.env, CARDTABLE_PLAY_WARM_SPARE: '0' });
const title = available.ok
	? 'a 2-mana cast with lands left over, over the real socket path, against real Forge'
	: `a 2-mana cast with lands left over, over the real socket path, against real Forge — SKIPPED: ${available.reason}`;

let socketMod: typeof import('./socket.ts');
let edgeMod: typeof import('../edge-auth.ts');

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	socketMod = await import('./socket.ts');
	edgeMod = await import('../edge-auth.ts');
});

interface Harness {
	port: number;
	handle: import('./socket.ts').PlayHandle;
	logs: Record<string, unknown>[];
	close: () => Promise<void>;
}

const openPeers: ClientSocket[] = [];
let harness: Harness | null = null;

afterEach(async () => {
	for (const p of openPeers.splice(0)) p.disconnect();
	if (harness !== null) await harness.close();
	harness = null;
});

async function boot(): Promise<Harness> {
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
		joinWaitMs: 8000,
		probe: true,
	});
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	const port = (http.address() as AddressInfo).port;
	harness = {
		port,
		handle,
		logs,
		close: async () => {
			handle.close();
			io.close();
			await new Promise<void>((done) => http.close(() => done()));
		},
	};
	return harness;
}

function edgeHeaders(user: string): Record<string, string> {
	return {
		'x-edge-auth': EDGE_SECRET,
		'x-hadoku-tier': 'friend',
		'x-user-id': `user-${user}`,
		'x-user-key': `friend-key-${user}`,
	};
}

interface Peer {
	socket: ClientSocket;
	frames: unknown[];
	answered: Set<string>;
	request(event: 'forge:join' | 'forge:resync', payload: unknown): Promise<unknown>;
	send(payload: unknown): void;
}

function connect(port: number, headers: Record<string, string>): Promise<Peer> {
	return new Promise((done, fail) => {
		const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['polling'], extraHeaders: headers, forceNew: true, reconnection: false });
		openPeers.push(socket);
		const peer: Peer = {
			socket,
			frames: [],
			answered: new Set(),
			request: async (event, payload) => socket.timeout(5000).emitWithAck(event, payload),
			send: (payload) => socket.emit('forge:c2s', payload),
		};
		socket.on('forge:s2c', (payload: unknown) => peer.frames.push(payload));
		socket.on('connect', () => done(peer));
		socket.on('connect_error', (err) => fail(err));
	});
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

/** Answer every GENERIC ask plainly (same defaults as `scenario.ts`'s `answerAsks`) — never a `selectCard`/`selectButtonOk` act of our own. */
function answerAsks(peer: Peer, matchId: string): void {
	for (const f of peer.frames) {
		const frame = (f as { frame?: Record<string, unknown> }).frame;
		if (frame === undefined || frame.kind !== 'ask') continue;
		const callId = frame.callId as string;
		if (peer.answered.has(callId)) continue;
		peer.answered.add(callId);
		let result: unknown;
		switch (frame.method) {
			case 'confirm':
			case 'showConfirmDialog':
				result = true;
				break;
			case 'openZones':
				result = [];
				break;
			case 'getAbilityToPlay':
				result = (frame.abilities as unknown[])[0] ?? null;
				break;
			case 'getChoices': {
				const keys = (frame.choices as { key: string }[]).map((c) => c.key);
				result = (frame.min as number) > 0 && keys[0] !== undefined ? [keys[0]] : [];
				break;
			}
			default:
				result = null;
		}
		peer.send({ matchId, frame: { kind: 'reply', callId, method: frame.method, result } });
	}
}

/** Press OK on every mulligan / keep-hand prompt for both peers, never on a live priority window. */
function keepHands(peers: Peer[], matchId: string, handled: Set<unknown>): void {
	for (const peer of peers) {
		const last = peer.frames.at(-1);
		if (last === undefined || handled.has(last)) continue;
		const promptFrame = [...peer.frames].reverse().find((f) => (f as { frame?: Record<string, unknown> }).frame?.method === 'showPromptMessage') as
			| { frame: { message: string } }
			| undefined;
		const buttonFrame = [...peer.frames].reverse().find((f) => (f as { frame?: Record<string, unknown> }).frame?.method === 'updateButtons') as
			| { frame: { enable1: boolean } }
			| undefined;
		if (promptFrame === undefined || buttonFrame === undefined) continue;
		if (promptFrame.frame.message.startsWith('Priority:')) continue;
		if (buttonFrame.frame.enable1 !== true) continue;
		handled.add(last);
		peer.send({ matchId, frame: { kind: 'act', method: 'selectButtonOk' } });
	}
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'Goblin Piker resolves over the real socket, both seats having pressed nothing since the cast',
		async () => {
			const h = await boot();
			const alice = await connect(h.port, edgeHeaders('alice'));
			const bob = await connect(h.port, edgeHeaders('bob'));

			const res = await fetch(`http://127.0.0.1:${h.port}/api/play/matches`, {
				method: 'POST',
				headers: { ...edgeHeaders('alice'), 'content-type': 'application/json' },
				body: JSON.stringify({ opponent: 'human', scenario: scenarioText('two-mana-pass') }),
			});
			expect(res.status).toBe(201);
			const { matchId } = (await res.json()) as { matchId: string };
			const aJoin = (await alice.request('forge:join', { matchId })) as { seat: number };
			await bob.request('forge:join', { matchId });
			const casterSeat = aJoin.seat;
			expect(casterSeat).toBe(0);

			const handled = new Set<unknown>();
			await waitUntil(
				() => {
					keepHands([alice, bob], matchId, handled);
					answerAsks(alice, matchId);
					answerAsks(bob, matchId);
					const p = [...alice.frames].reverse().find((f) => (f as { frame?: Record<string, unknown> }).frame?.method === 'showPromptMessage') as
						| { frame: { message: string } }
						| undefined;
					return p !== undefined && p.frame.message.startsWith('Priority:');
				},
				"the caster's own priority window",
				60_000,
			);

			const state = () =>
				foldFrames(
					alice.frames
						.map((f) => (f as { frame?: Record<string, unknown> }).frame)
						.filter((f): f is Record<string, unknown> => f !== undefined && (f.method === 'setGameView' || f.method === 'applyDelta' || f.method === 'openView')) as never,
				);
			function handIds(): number[] {
				const st = state();
				const me = st.get(keyOf(TYPE.player, casterSeat));
				const hand = me?.Hand as { v?: { t?: string; v?: number }[] } | undefined;
				return (hand?.v ?? []).filter((x) => x?.t === 'int' && typeof x.v === 'number').map((x) => x.v as number);
			}
			function nameOf(id: number): string {
				const st = state();
				const card = st.get(keyOf(TYPE.card, id));
				const current = card?.CurrentState as { v?: number } | undefined;
				const face = st.get(keyOf(TYPE.cardState, id * 16 + (current?.v ?? 0)));
				return (face?.Name as { v?: string } | undefined)?.v ?? `#${id}`;
			}
			function battlefieldIds(seat: number): number[] {
				const st = state();
				const p = st.get(keyOf(TYPE.player, seat));
				const bf = p?.Battlefield as { v?: { t?: string; v?: number }[] } | undefined;
				return (bf?.v ?? []).filter((x) => x?.t === 'int' && typeof x.v === 'number').map((x) => x.v as number);
			}
			const piker = handIds().find((id) => nameOf(id) === 'Goblin Piker');
			expect(piker, `caster's hand: ${JSON.stringify(handIds().map(nameOf))}`).toBeDefined();

			alice.send({ matchId, frame: { kind: 'act', method: 'selectCard', card: { kind: 'card', id: piker }, otherCardViewsToSelect: [], triggerEvent: null } });

			try {
				await waitUntil(
					() => {
						keepHands([alice, bob], matchId, handled);
						answerAsks(alice, matchId);
						answerAsks(bob, matchId);
						return battlefieldIds(0).some((id) => nameOf(id) === 'Goblin Piker');
					},
					'Goblin Piker to resolve onto the battlefield untouched',
					45_000,
				);
			} catch (e) {
				const dump = (peer: Peer, label: string) =>
					console.log(
						`[diag] ${label} frames:\n` +
							peer.frames
								.map((f) => (f as { frame?: Record<string, unknown> }).frame)
								.filter((f): f is Record<string, unknown> => f !== undefined)
								.map((f) => {
									const m = String(f.method ?? f.kind);
									if (m === 'showPromptMessage') return `PROMPT ${JSON.stringify(f.message)}`;
									if (m === 'updateButtons') return `BUTTONS [${String(f.label1)}${f.enable1 === true ? '' : '-'}] [${String(f.label2)}${f.enable2 === true ? '' : '-'}]`;
									if (f.kind === 'ask') return `ASK ${String(f.method)}`;
									if (m === 'applyDelta' || m === 'setGameView') return m;
									return m;
								})
								.join('\n'),
					);
				dump(alice, 'alice');
				dump(bob, 'bob');
				console.log('[diag] auto-passed/auto-paid logs:', JSON.stringify(h.logs.filter((l) => l.evt === 'auto-passed' || l.evt === 'auto-paid')));
				throw e;
			}

			console.log('[diag] success. auto-passed/auto-paid logs:', JSON.stringify(h.logs.filter((l) => l.evt === 'auto-passed' || l.evt === 'auto-paid')));
			expect(battlefieldIds(0).some((id) => nameOf(id) === 'Goblin Piker')).toBe(true);
		},
		120_000,
	);
});
