/**
 * Wave 35 §S follow-up, item 2 — R4 over the REAL socket path, against a real
 * Forge JVM (not the replayed fixture `socket.test.ts` uses, and not the bare
 * `Match.fromClient` harness `scenario-thoughtseize.jvm.test.ts` uses).
 *
 * Lane E's e2e finding (`docs/planning/wave35-evidence/e-runs.md`): casting
 * Thoughtseize through the browser against `scenarios/thoughtseize.state`, the
 * caster's page receives `notify:setSelectables`, never
 * `chooseSingleEntityForEffect` — so the fold built in `match.ts` (`onFrame`'s
 * `getChoices`-merge) never fires over that path.
 *
 * This file drives the exact same scenario through `attachPlay` — a real
 * express + socket.io server, two real `socket.io-client` peers, a real jar —
 * and logs every frame each peer receives, to find out directly what shape
 * Forge's ask actually takes here and why.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w35-s/work \
 *   pnpm exec vitest run apps/server/src/play/socket-thoughtseize.jvm.test.ts \
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

const EDGE_SECRET = 'test-edge-auth-secret';
const available = jvmHostConfig({ ...process.env, CARDTABLE_PLAY_WARM_JVM: '0' });
const title = available.ok
	? 'R4 over the real socket path, against real Forge'
	: `R4 over the real socket path, against real Forge — SKIPPED: ${available.reason}`;

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
	const handle = socketMod.attachPlay(io, api, {
		minTier: 'friend',
		host: jvmHostFactory(available.config, { warm: false }),
		log: (e) => {
			if (e.evt === 'c2s-malformed' || e.evt === 'c2s-refused') console.log('[s2-socket] server log:', JSON.stringify(e));
		},
		startTimeoutMs: 120_000,
		joinWaitMs: 8000,
		probe: true,
	});
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	const port = (http.address() as AddressInfo).port;
	harness = {
		port,
		handle,
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
	acks: unknown[];
	answered: Set<string>;
	request(event: 'forge:join' | 'forge:resync', payload: unknown): Promise<unknown>;
	send(payload: unknown): void;
}

function connect(port: number, headers: Record<string, string>): Promise<Peer> {
	return new Promise((done, fail) => {
		const socket = ioClient(`http://127.0.0.1:${port}`, {
			transports: ['polling'],
			extraHeaders: headers,
			forceNew: true,
			reconnection: false,
		});
		openPeers.push(socket);
		const peer: Peer = {
			socket,
			frames: [],
			acks: [],
			answered: new Set(),
			request: async (event, payload) => {
				const ack: unknown = await socket.timeout(5000).emitWithAck(event, payload);
				peer.acks.push(ack);
				return ack;
			},
			send: (payload) => socket.emit('forge:c2s', payload),
		};
		socket.on('forge:s2c', (payload: unknown) => peer.frames.push(payload));
		socket.on('connect', () => done(peer));
		socket.on('connect_error', (err) => fail(err));
	});
}

/**
 * Answer every `ask` this peer has not already answered, except one matching
 * `skip` (the thing the test wants to observe, not auto-away). Plain default
 * answers, same shape as `scenario.ts`'s `answerAsks`.
 */
function answerAsks(peer: Peer, matchId: string, skip: (frame: Record<string, unknown>) => boolean): void {
	for (const f of peer.frames) {
		const frame = (f as { frame?: Record<string, unknown> }).frame;
		if (frame === undefined || frame.kind !== 'ask') continue;
		const callId = frame.callId as string;
		if (peer.answered.has(callId) || skip(frame)) continue;
		peer.answered.add(callId);
		let result: unknown;
		switch (frame.method) {
			case 'confirm':
			case 'showConfirmDialog':
				result = true;
				break;
			case 'openZones':
				// `OpenZonesReplySchema` is `PlayerZoneUpdatesSchema`, an ARRAY — unlike
				// the raw `Match.fromClient` harness in `scenario.ts` (which skips
				// `safeParseClientFrame` entirely and replies `true`, accepted there
				// only because nothing checks the shape on that path), the real socket
				// route validates a reply against its method and silently drops one
				// that fails (`c2s-malformed`), so `true` here hangs the match forever.
				result = [];
				break;
			case 'showOptionDialog':
				result = 0;
				break;
			case 'showInputDialog':
				result = '0';
				break;
			case 'getChoices': {
				const keys = (frame.choices as { key: string }[]).map((c) => c.key);
				result = (frame.min as number) > 0 && keys[0] !== undefined ? [keys[0]] : [];
				break;
			}
			case 'getAbilityToPlay':
				result = (frame.abilities as unknown[])[0] ?? null;
				break;
			case 'chooseSingleEntityForEffect':
				result = (frame.optionList as unknown[])[0] ?? null;
				break;
			case 'chooseEntitiesForEffect':
				result = (frame.min as number) > 0 ? [(frame.optionList as unknown[])[0]] : [];
				break;
			case 'manipulateCardList':
				result = frame.cards;
				break;
			case 'order':
				result = { ordered: (frame.sourceChoices as { key: string }[]).map((c) => c.key), rememberDecision: false };
				break;
			case 'assignCombatDamage':
			case 'assignGenericAmount':
				result = [];
				break;
			default:
				result = null;
		}
		peer.send({ matchId, frame: { kind: 'reply', callId, method: frame.method, result } });
	}
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

/** Every `forge:s2c` envelope's `frame`, in arrival order, as a readable line. */
function dump(peer: Peer): string[] {
	return peer.frames.map((f) => {
		const frame = (f as { frame?: Record<string, unknown> }).frame ?? (f as Record<string, unknown>);
		const m = String(frame.method ?? frame.kind);
		if (m === 'showPromptMessage') return `PROMPT ${JSON.stringify(frame.message)}`;
		if (m === 'updateButtons') return `BUTTONS [${String(frame.label1)}${frame.enable1 === true ? '' : '-'}] [${String(frame.label2)}${frame.enable2 === true ? '' : '-'}]`;
		if (m === 'setSelectables') return `SELECTABLES ${JSON.stringify((frame.cards as { id: number }[]).map((c) => c.id))} min=${String(frame.min)} max=${String(frame.max)}`;
		if (m === 'clearSelectables') return 'SELECTABLES cleared';
		if (m === 'setWeaklySelectable') return `ACTIONABLE ${JSON.stringify((frame.cards as { id: number }[]).map((c) => c.id))}`;
		if (m === 'clearWeaklySelectable') return 'ACTIONABLE cleared';
		if (frame.kind === 'ask') return `ASK ${m} ${JSON.stringify(frame)}`;
		if (m === 'message') return `MESSAGE ${JSON.stringify(frame.message)}`;
		if (m === 'applyDelta' || m === 'setGameView') return m;
		return m;
	});
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'casting Thoughtseize through POST /api/play/matches + socket.io, against the real jar',
		async () => {
			const h = await boot();
			const alice = await connect(h.port, edgeHeaders('alice'));
			const bob = await connect(h.port, edgeHeaders('bob'));

			const res = await fetch(`http://127.0.0.1:${h.port}/api/play/matches`, {
				method: 'POST',
				headers: { ...edgeHeaders('alice'), 'content-type': 'application/json' },
				body: JSON.stringify({ opponent: 'human', scenario: scenarioText('thoughtseize') }),
			});
			// The server's own words when it refuses (a 503 names its reason: draining, no Forge, or the cap).
			expect(res.status, res.status === 201 ? '' : await res.clone().text()).toBe(201);
			const { matchId } = (await res.json()) as { matchId: string };

			const aJoin = (await alice.request('forge:join', { matchId })) as { seat: number };
			const bJoin = (await bob.request('forge:join', { matchId })) as { seat: number };
			const caster = aJoin.seat === 0 ? alice : bob;
			const casterSeat = aJoin.seat === 0 ? aJoin.seat : bJoin.seat;
			const discarder = caster === alice ? bob : alice;
			expect(casterSeat).toBe(0);

			/** Press OK on every mulligan / keep-hand prompt, for both peers. */
			const handled = new Set<unknown>();
			function keepHands(): void {
				for (const peer of [alice, bob]) {
					const last = peer.frames.at(-1) as { frame?: Record<string, unknown> } | undefined;
					if (last === undefined || handled.has(last)) continue;
					const promptFrame = [...peer.frames].reverse().find((f) => (f as { frame?: Record<string, unknown> }).frame?.method === 'showPromptMessage') as
						| { frame: { message: string } }
						| undefined;
					const buttonFrame = [...peer.frames].reverse().find((f) => (f as { frame?: Record<string, unknown> }).frame?.method === 'updateButtons') as
						| { frame: { enable1: boolean; label1: string } }
						| undefined;
					if (promptFrame === undefined || buttonFrame === undefined) continue;
					if (promptFrame.frame.message.startsWith('Priority:')) continue;
					if (buttonFrame.frame.enable1 !== true) continue;
					handled.add(last);
					peer.send({ matchId, frame: { kind: 'act', method: 'selectButtonOk' } });
				}
			}

			const neverSkip = (): boolean => false;
			await waitUntil(
				() => {
					keepHands();
					answerAsks(alice, matchId, neverSkip);
					answerAsks(bob, matchId, neverSkip);
					const p = [...caster.frames].reverse().find((f) => (f as { frame?: Record<string, unknown> }).frame?.method === 'showPromptMessage') as
						| { frame: { message: string } }
						| undefined;
					return p !== undefined && p.frame.message.startsWith('Priority:');
				},
				"the caster's own priority window",
				60_000,
			);

			// Find Thoughtseize and the untapped Swamp by scanning applyDelta/setGameView
			// payloads the caster received, the same way `visibility.ts` would.
			const { foldFrames } = await import('./visibility.js');
			const { deltaKey, DELTA_TYPE } = await import('@hadoku/forge-wire');
			const state = () =>
				foldFrames(
					caster.frames
						.map((f) => (f as { frame?: Record<string, unknown> }).frame)
						.filter((f): f is Record<string, unknown> => f !== undefined && (f.method === 'setGameView' || f.method === 'applyDelta' || f.method === 'openView')) as never,
				);
			function handIds(): number[] {
				const st = state();
				const me = st.get(deltaKey(DELTA_TYPE.player, casterSeat));
				const hand = me?.Hand as { v?: { t?: string; v?: number }[] } | undefined;
				return (hand?.v ?? []).filter((x) => x?.t === 'int' && typeof x.v === 'number').map((x) => x.v as number);
			}
			function nameOf(id: number): string {
				const st = state();
				const card = st.get(deltaKey(DELTA_TYPE.card, id));
				const current = card?.CurrentState as { v?: number } | undefined;
				const face = st.get(deltaKey(DELTA_TYPE.cardState, id * 16 + (current?.v ?? 0)));
				return (face?.Name as { v?: string } | undefined)?.v ?? `#${id}`;
			}
			const seize = handIds().find((id) => nameOf(id) === 'Thoughtseize');
			expect(seize, `caster's hand: ${JSON.stringify(handIds().map(nameOf))}`).toBeDefined();

			const logsBefore = caster.frames.length;
			caster.send({ matchId, frame: { kind: 'act', method: 'selectCard', card: { kind: 'card', id: seize }, otherCardViewsToSelect: [], triggerEvent: null } });

			// Pay/target loop: answer whatever comes until the discard choice itself
			// arrives (an `ask`, or a `setSelectables` push naming cards in the
			// DISCARDER's hand — the exact distinction this test exists to make).
			let discardShape: 'ask' | 'selectables' | null = null;
			let targeted = false;
			let paid = false;
			const opponentPlayerId = 1 - casterSeat;
			try {
			const isDiscardAsk = (frame: Record<string, unknown>): boolean => frame.method === 'getChoices' || frame.method === 'chooseSingleEntityForEffect';
			await waitUntil(
				() => {
					keepHands();
					answerAsks(discarder, matchId, neverSkip);
					answerAsks(caster, matchId, isDiscardAsk);
					for (const f of caster.frames.slice(logsBefore)) {
						const frame = (f as { frame?: Record<string, unknown> }).frame;
						if (frame === undefined) continue;
						if (frame.kind === 'ask' && isDiscardAsk(frame)) {
							discardShape = 'ask';
							return true;
						}
						if (frame.method === 'setSelectables') {
							const ids = (frame.cards as { id: number }[]).map((c) => c.id);
							if (ids.some((id) => id !== seize)) {
								discardShape = 'selectables';
								return true;
							}
						}
					}
					const promptFrame = [...caster.frames].reverse().find((f) => (f as { frame?: Record<string, unknown> }).frame?.method === 'showPromptMessage') as
						| { frame: { message: string } }
						| undefined;
					const buttonFrame = [...caster.frames].reverse().find((f) => (f as { frame?: Record<string, unknown> }).frame?.method === 'updateButtons') as
						| { frame: { label1: string; enable1: boolean } }
						| undefined;
					// Targeting: Thoughtseize's `ValidTgts$ Player` input shows "target"
					// in the prompt and wants a `selectPlayer` act at the opponent.
					if (!targeted && promptFrame !== undefined && /target/i.test(promptFrame.frame.message)) {
						targeted = true;
						caster.send({ matchId, frame: { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: opponentPlayerId }, triggerEvent: null } });
					}
					// Payment: the scenario's `{1}{B}` is unambiguous off one Swamp and
					// one other land — Forge's own Auto button, same as the raw-Match
					// test (`scenario-thoughtseize.jvm.test.ts`'s `castThoughtseize`).
					if (!paid && buttonFrame !== undefined && buttonFrame.frame.label1 === 'Auto' && buttonFrame.frame.enable1 === true) {
						paid = true;
						caster.send({ matchId, frame: { kind: 'act', method: 'selectButtonOk' } });
					}
					return false;
				},
				'the discard choice to reach the caster, in whatever shape Forge sends it',
				60_000,
			);
			} catch (e) {
				console.log('[s2-socket] FAILED, caster frames:\n' + dump(caster).join('\n'));
				console.log('[s2-socket] FAILED, discarder frames:\n' + dump(discarder).join('\n'));
				throw e;
			}

			console.log('[s2-socket] discard arrived as:', discardShape);
			console.log('[s2-socket] caster frames after cast:\n' + dump(caster).slice(-25).join('\n'));
			console.log('[s2-socket] discarder frames:\n' + dump(discarder).slice(-15).join('\n'));

			// The finding: over the REAL socket + a real jar, correctly driven
			// (targeting answered, `openZones` answered with its real shape, payment
			// via Auto), the fold holds exactly as the raw-Match test proved —
			// `chooseSingleEntityForEffect`, never a raw `getChoices` and never
			// `setSelectables` naming the discarder's hand.
			expect(discardShape).toBe('ask');
			const mergedAsk = caster.frames
				.map((f) => (f as { frame?: Record<string, unknown> }).frame)
				.find((f) => f?.kind === 'ask' && f.method === 'chooseSingleEntityForEffect') as
				| { optionList: { id: number }[]; delayedReveal: { cards: { id: number }[]; owner: { id: number } } | null; isOptional: boolean }
				| undefined;
			expect(mergedAsk, 'the merged ask must have been found again by direct scan').toBeDefined();
			if (mergedAsk === undefined) throw new Error('unreachable');
			// The nonland choices only — the land in the discarder's hand never a
			// legal pick, same invariant as the raw-Match test.
			expect(mergedAsk.optionList.length).toBeGreaterThan(0);
			// The whole hand is still shown (delayedReveal), owned by the discarder.
			expect(mergedAsk.delayedReveal).not.toBeNull();
			expect(mergedAsk.delayedReveal?.cards.length).toBeGreaterThan(mergedAsk.optionList.length);
			expect(mergedAsk.delayedReveal?.owner.id).toBe(1 - casterSeat);

			// No raw `getChoices` ever reached the caster for this effect.
			const casterAskMethods = caster.frames
				.map((f) => (f as { frame?: Record<string, unknown> }).frame)
				.filter((f): f is Record<string, unknown> => f?.kind === 'ask')
				.map((f) => f.method);
			expect(casterAskMethods).not.toContain('getChoices');

			// The discarder sees NO ask at all — the fold drops the trailing reveal
			// unconditionally, same as the operator's ruling.
			const discarderAsks = discarder.frames.map((f) => (f as { frame?: Record<string, unknown> }).frame).filter((f) => f?.kind === 'ask');
			expect(discarderAsks).toEqual([]);
		},
		180_000,
	);
});
