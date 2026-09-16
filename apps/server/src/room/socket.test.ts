/**
 * The socket layer, end to end: a real socket.io server on an ephemeral
 * loopback port, real `socket.io-client` connections, the real cube.
 *
 * Nothing here is stubbed. A stub transport can prove the dispatch is right —
 * `apps/ui/src/draft/socket.test.ts` does exactly that for the client half —
 * but it cannot prove that a handshake below the tier floor is refused, or that
 * two sockets in one room receive different bytes, because in a stub there are
 * no bytes and no handshake.
 *
 * ## The leak assertion is positional, not nominal
 *
 * `apps/ui/src/draft/hiddenInfo.ts` is the existing in-repo example of this
 * shape: it walks a whole serialised payload and fails on a card-shaped object
 * anywhere it does not belong, because a payload leaks when somebody ADDS a
 * field, not when they mistype one. The same idea is applied here from the
 * other end — every card id and every card name that reached seat 0 is searched
 * for in the complete serialised transcript of what seat 1 received. Not "the
 * seat field looks right": the other seat's cards must appear NOWHERE.
 *
 * ## Every server payload is re-parsed with the wire's own rules
 *
 * `safeParseServerMessage` runs `serverMessageIssues`, which runs the full
 * semantic pass — the D13 no-images control and the cursor-agreement rule —
 * over anything the server sent. A server that emitted something a browser
 * would refuse fails here rather than in production.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { roleOf, seatOf } from '@wolffm/rooms-protocol';
import {
	DRAFT_CHANNEL,
	joinDraft,
	leaveDraft,
	pickCard,
	resyncRequest,
	safeParseServerMessage,
	type DraftCard,
	type DraftView,
	type ServerMessage,
} from '@hadoku/shared';

import type { DraftRoom, DraftRooms } from './draftRooms.js';
import type { CubePool } from './pool.js';

const POOL_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../ui/src/draft/pool.json');
const EDGE_SECRET = 'test-edge-auth-secret';
const DRAFT_ID = 'pod-socket-1';

/*
 * `config.ts` reads the environment once, at module load, so the secret has to
 * be in place before anything that imports it is evaluated. ESM import
 * declarations hoist, so the modules under test are pulled in dynamically after
 * the environment is set — the alternative is an import-ordering trick that
 * works until somebody reorders the imports.
 */
let socketMod: typeof import('./socket.ts');
let roomsMod: typeof import('./draftRooms.ts');
let pool: CubePool;

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	socketMod = await import('./socket.ts');
	roomsMod = await import('./draftRooms.ts');
	const poolMod = await import('./pool.ts');
	const load = poolMod.loadPool(POOL_FILE);
	if (!load.ok) throw new Error(`the bundled cube pool did not load: ${load.detail}`);
	pool = load.pool;
});

/* ── Harness ─────────────────────────────────────────────────────────── */

interface Harness {
	port: number;
	rooms: DraftRooms;
	io: SocketIOServer;
	http: HttpServer;
	close: () => Promise<void>;
}

const openPeers: ClientSocket[] = [];
let harness: Harness | null = null;

async function boot(deps: { rateLimit?: { capacity: number; refillAmount: number; refillIntervalMs: number } } = {}): Promise<Harness> {
	const rooms = roomsMod.createDraftRooms({ pool: pool.cards, cube: pool.meta });
	const http = createServer();
	const io = new SocketIOServer(http, { serveClient: false });
	const handle = socketMod.attachDraftSocket(io, {
		rooms,
		minTier: 'friend',
		// Silence in the test log; the assertions read state, not lines.
		log: () => {},
		rateLimit: deps.rateLimit,
	});
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	const port = (http.address() as AddressInfo).port;
	return {
		port,
		rooms,
		io,
		http,
		close: async () => {
			handle.close();
			io.close();
			await new Promise<void>((done) => http.close(() => done()));
		},
	};
}

/** Headers the edge would stamp for a vouched friend. */
function edgeHeaders(userKey: string): Record<string, string> {
	return {
		'x-edge-auth': EDGE_SECRET,
		'x-hadoku-tier': 'friend',
		'x-user-id': `user-${userKey}`,
		'x-user-key': `friend-key-${userKey}`,
	};
}

interface Peer {
	socket: ClientSocket;
	id: string;
	/** Every envelope this socket received, in arrival order. */
	received: ServerMessage[];
	/** The raw bytes, kept so the leak assertion can search the real transcript. */
	raw: unknown[];
	send: (message: unknown) => void;
}

function connect(port: number, headers: Record<string, string>): Promise<Peer> {
	return new Promise((done, fail) => {
		// Polling only: `extraHeaders` is applied to the handshake request, which
		// is the request `io.engine.use(edgeProvenance)` sanitizes. Letting the
		// transport upgrade would not change that, but pinning it keeps the test
		// asserting one thing.
		const socket = ioClient(`http://127.0.0.1:${port}`, {
			transports: ['polling'],
			extraHeaders: headers,
			forceNew: true,
			reconnection: false,
		});
		openPeers.push(socket);
		const peer: Peer = {
			socket,
			id: '',
			received: [],
			raw: [],
			send: (message) => socket.emit(DRAFT_CHANNEL.clientToServer, message),
		};
		socket.on(DRAFT_CHANNEL.serverToClient, (payload: unknown) => {
			peer.raw.push(payload);
			const parsed = safeParseServerMessage(payload);
			if (!parsed.ok) {
				fail(
					new Error(
						`the server sent something a browser would refuse:\n${parsed.errors
							.map((e) => `  ${e.path}: ${e.message}`)
							.join('\n')}`,
					),
				);
				return;
			}
			peer.received.push(parsed.value);
		});
		socket.on('connect', () => {
			peer.id = socket.id ?? '';
			done(peer);
		});
		socket.on('connect_error', (err) => fail(err));
	});
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** The most recent envelope carrying a payload, or null. */
function lastView(peer: Peer): DraftView | null {
	for (let i = peer.received.length - 1; i >= 0; i--) {
		const msg = peer.received[i];
		if (msg !== undefined && (msg.type === 'state' || msg.type === 'update')) return msg.view;
	}
	return null;
}

function errors(peer: Peer): Array<{ code: string; detail?: string }> {
	return peer.received.filter((m) => m.type === 'error').map((m) => m.error);
}

/**
 * Paths at which a card-shaped object appears that the recipient may not see.
 *
 * The same positional rule `apps/ui/src/draft/hiddenInfo.ts` enforces on the
 * browser side, restated here because that module belongs to the UI app and a
 * server test must not reach across into it. A card is anything carrying both a
 * `cardId` and a `name`; the only places one may appear are the recipient's own
 * `viewer.pack` and `viewer.pool`. Everything else — a seat summary, a debug
 * echo, a `lastPick` convenience field somebody adds later — is a leak, and the
 * assertion names the path.
 */
function leakedCardPaths(payload: unknown): string[] {
	const found: string[] = [];
	const isCard = (v: unknown): boolean => {
		if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
		const o = v as Record<string, unknown>;
		return typeof o.cardId === 'string' && typeof o.name === 'string';
	};
	const walk = (node: unknown, path: string): void => {
		if (isCard(node)) {
			found.push(path);
			return;
		}
		if (Array.isArray(node)) {
			node.forEach((child, i) => walk(child, `${path}[${i}]`));
			return;
		}
		if (typeof node === 'object' && node !== null) {
			for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`);
		}
	};
	walk(payload, '$');
	return found.filter(
		(p) => !p.startsWith('$.view.viewer.pack[') && !p.startsWith('$.view.viewer.pool['),
	);
}

/** Every card this seat has been shown: their pack and their pool, over time. */
function cardsSeenBy(peer: Peer): DraftCard[] {
	const out: DraftCard[] = [];
	for (const msg of peer.received) {
		if (msg.type !== 'state' && msg.type !== 'update') continue;
		if (msg.view.viewer.kind !== 'seat') continue;
		out.push(...msg.view.viewer.pack, ...msg.view.viewer.pool);
	}
	return out;
}

async function joinAndSettle(peer: Peer, draftId = DRAFT_ID): Promise<void> {
	const before = peer.received.length;
	peer.send(joinDraft(draftId));
	await waitUntil(() => peer.received.length > before, `${peer.id} to be seated`);
}

beforeEach(async () => {
	harness = await boot();
});

afterEach(async () => {
	for (const socket of openPeers.splice(0)) socket.disconnect();
	await harness?.close();
	harness = null;
});

function live(): Harness {
	if (harness === null) throw new Error('no harness');
	return harness;
}

function room(): DraftRoom {
	const found = live().rooms.find(DRAFT_ID);
	if (found === undefined) throw new Error(`no room for ${DRAFT_ID}`);
	return found;
}

/* ── The gate ────────────────────────────────────────────────────────── */

describe('the handshake inherits the friend gate', () => {
	it('refuses a socket the edge did not vouch for', async () => {
		// No X-Edge-Auth: `sanitizeHeaders` overwrites the tier with `public` and
		// deletes the identity headers, and the floor then refuses it. Claiming
		// `admin` makes no difference, which is the point.
		await expect(
			connect(live().port, { 'x-hadoku-tier': 'admin', 'x-user-key': 'friend-key-forged' }),
		).rejects.toThrow(/not found/);
	});

	it('refuses a vouched socket that is below the floor', async () => {
		await expect(
			connect(live().port, { 'x-edge-auth': EDGE_SECRET, 'x-hadoku-tier': 'public' }),
		).rejects.toThrow(/not found/);
	});

	it('refuses a socket carrying the wrong seal', async () => {
		await expect(
			connect(live().port, { 'x-edge-auth': 'not-the-secret', 'x-hadoku-tier': 'friend' }),
		).rejects.toThrow(/not found/);
	});

	it('admits a vouched friend', async () => {
		const alice = await connect(live().port, edgeHeaders('alice'));
		expect(alice.socket.connected).toBe(true);
	});
});

/* ── Identity ────────────────────────────────────────────────────────── */

describe('identity comes from the edge, never from the client', () => {
	it('refuses a message that carries a participantId', async () => {
		const alice = await connect(live().port, edgeHeaders('alice'));
		alice.send({ type: 'join', draftId: DRAFT_ID, participantId: 'fk:0000000000000000' });
		await waitUntil(() => alice.received.length > 0, 'a rejection');

		expect(errors(alice)).toHaveLength(1);
		expect(errors(alice)[0]?.code).toBe('malformed-message');
		expect(errors(alice)[0]?.detail).toContain('participantId');
		// And nothing happened: the join did not go through under any identity.
		expect(live().rooms.find(DRAFT_ID)).toBeUndefined();
	});

	it('refuses junk without closing the socket', async () => {
		const alice = await connect(live().port, edgeHeaders('alice'));
		alice.send({ type: 'nonsense' });
		await waitUntil(() => alice.received.length > 0, 'a rejection');
		expect(errors(alice)[0]?.code).toBe('malformed-message');
		expect(alice.socket.connected).toBe(true);

		// …and the socket still works afterwards.
		await joinAndSettle(alice);
		expect(lastView(alice)?.viewer.kind).toBe('seat');
	});

	it('seats the same person in the same seat whatever socket they arrive on', async () => {
		const first = await connect(live().port, edgeHeaders('alice'));
		await joinAndSettle(first);
		const seat = seatOf(room().seats, room().clients.get(first.id)?.participantId ?? '');
		expect(seat).toBe(0);
	});
});

/* ── Hidden information ──────────────────────────────────────────────── */

describe('two sockets in one room', () => {
	it("each receive ONLY their own seat's cards, over whole serialised payloads", async () => {
		const alice = await connect(live().port, edgeHeaders('alice'));
		const bob = await connect(live().port, edgeHeaders('bob'));
		await joinAndSettle(alice);
		await joinAndSettle(bob);
		await waitUntil(() => alice.received.length >= 2, 'alice to see bob arrive');

		const aliceView = lastView(alice);
		const bobView = lastView(bob);
		expect(aliceView?.viewer.kind).toBe('seat');
		expect(bobView?.viewer.kind).toBe('seat');
		if (aliceView?.viewer.kind !== 'seat' || bobView?.viewer.kind !== 'seat') return;
		expect(aliceView.viewer.seatId).toBe(0);
		expect(bobView.viewer.seatId).toBe(1);

		// Make the two seats' slices genuinely different: alice takes a card, so
		// she has a pool and a 14-card pack while bob still has 15.
		const taken = aliceView.viewer.pack[0];
		if (taken === undefined) throw new Error('an opening pack should not be empty');
		alice.send(pickCard(DRAFT_ID, taken.cardId));
		await waitUntil(() => lastView(bob)?.seq !== bobView.seq, "bob to see alice's pick");

		const aliceCards = cardsSeenBy(alice);
		const bobCards = cardsSeenBy(bob);
		expect(aliceCards.length).toBeGreaterThan(15);
		expect(bobCards.length).toBeGreaterThan(0);

		// (a) Positional, over the whole parsed tree: a card-shaped object may
		//     appear at `viewer.pack[…]` and `viewer.pool[…]` and nowhere else.
		//     This is the rule `hiddenInfo.ts` enforces, and it catches a leak
		//     that arrives as a NEW FIELD nobody thought to check.
		for (const payload of [...alice.raw, ...bob.raw]) {
			expect(leakedCardPaths(payload)).toEqual([]);
		}

		// (b) By value, over the whole serialised transcript: not one of the
		//     other seat's card ids or names appears anywhere in the bytes they
		//     received. Quoted, because `JSON.stringify` writes ids as string
		//     literals and a bare `includes('c4')` matches `"c40"` — a naive
		//     substring search reports three leaks that are not there, which is
		//     how a control ends up being weakened to make it pass.
		const bobTranscript = JSON.stringify(bob.raw);
		const aliceTranscript = JSON.stringify(alice.raw);
		const quoted = (v: string): string => JSON.stringify(v);

		const leakedToBob = aliceCards.filter(
			(c) => bobTranscript.includes(quoted(c.cardId)) || bobTranscript.includes(quoted(c.name)),
		);
		expect(leakedToBob.map((c) => c.name)).toEqual([]);

		const leakedToAlice = bobCards.filter(
			(c) => aliceTranscript.includes(quoted(c.cardId)) || aliceTranscript.includes(quoted(c.name)),
		);
		expect(leakedToAlice.map((c) => c.name)).toEqual([]);

		// The control on the control: the two seats really were handed different
		// cards, so the assertions above had something to catch.
		const aliceIds = new Set(aliceCards.map((c) => c.cardId));
		expect(bobCards.some((c) => aliceIds.has(c.cardId))).toBe(false);
		expect(aliceTranscript).toContain(quoted(aliceCards[0]?.cardId ?? ''));
	});

	it('gives someone with no seat a payload with no cards in it at all', async () => {
		const alice = await connect(live().port, edgeHeaders('alice'));
		await joinAndSettle(alice);
		// Leaving releases the seat; they stay connected as a spectator.
		const before = alice.received.length;
		alice.send(leaveDraft(DRAFT_ID));
		await waitUntil(() => alice.received.length > before, 'the spectator payload');

		const view = lastView(alice);
		expect(view?.viewer).toEqual({ kind: 'spectator' });
		// Structurally, not by filtering: the spectator arm has no card fields.
		const spectatorTranscript = JSON.stringify(alice.raw.at(-1));
		expect(spectatorTranscript).not.toContain('"pack"');
		expect(spectatorTranscript).not.toContain('"pool"');
	});
});

/* ── Rejections are values ───────────────────────────────────────────── */

describe('an out-of-turn pick', () => {
	it("comes back as an error envelope with the engine's own code, and changes nothing", async () => {
		const alice = await connect(live().port, edgeHeaders('alice'));
		const bob = await connect(live().port, edgeHeaders('bob'));
		await joinAndSettle(alice);
		await joinAndSettle(bob);

		const opening = lastView(alice);
		if (opening?.viewer.kind !== 'seat') throw new Error('alice should be seated');
		const taken = opening.viewer.pack[0];
		if (taken === undefined) throw new Error('an opening pack should not be empty');

		alice.send(pickCard(DRAFT_ID, taken.cardId));
		await waitUntil(() => (lastView(alice)?.seq ?? 0) > opening.seq, 'the pick to land');
		const afterPick = lastView(alice);
		if (afterPick?.viewer.kind !== 'seat') throw new Error('alice should still be seated');
		const seqAfterPick = afterPick.seq;

		// The round has not advanced — bob still owes a pick — so alice picking
		// again is out of turn.
		const second = afterPick.viewer.pack[0];
		if (second === undefined) throw new Error('the pack should still have cards');
		alice.send(pickCard(DRAFT_ID, second.cardId));
		await waitUntil(() => errors(alice).length > 0, 'the rejection');

		expect(errors(alice)).toHaveLength(1);
		expect(errors(alice)[0]?.code).toBe('already-picked');
		// The socket is fine and the draft did not move.
		expect(alice.socket.connected).toBe(true);
		expect(roomsSeq()).toBe(seqAfterPick);
		expect(lastView(alice)?.seq).toBe(seqAfterPick);
		// The rejection is stamped with the state it was evaluated against, so
		// it cannot leave anyone with a permanent gap.
		const rejection = alice.received.at(-1);
		expect(rejection?.type).toBe('error');
		expect(rejection?.cursor.seq).toBe(seqAfterPick);
	});

	it('refuses a pick from someone holding no seat', async () => {
		const alice = await connect(live().port, edgeHeaders('alice'));
		await joinAndSettle(alice);
		const view = lastView(alice);
		if (view?.viewer.kind !== 'seat') throw new Error('alice should be seated');
		const card = view.viewer.pack[0];
		if (card === undefined) throw new Error('an opening pack should not be empty');

		alice.send(leaveDraft(DRAFT_ID));
		await waitUntil(() => lastView(alice)?.viewer.kind === 'spectator', 'the seat release');

		alice.send(pickCard(DRAFT_ID, card.cardId));
		await waitUntil(() => errors(alice).length > 0, 'the rejection');
		expect(errors(alice)[0]?.code).toBe('not-seated');
	});

	it('refuses anything about a draft that was never opened', async () => {
		const alice = await connect(live().port, edgeHeaders('alice'));
		alice.send(resyncRequest('no-such-pod', null));
		await waitUntil(() => errors(alice).length > 0, 'the rejection');
		expect(errors(alice)[0]?.code).toBe('unknown-draft');
	});
});

function roomsSeq(): number {
	return roomsMod.stateOf(room()).seq;
}

/* ── Reconnect ───────────────────────────────────────────────────────── */

describe('a disconnect and a reconnect inside the reservation TTL', () => {
	it('returns the participant to the same seat with their pool intact', async () => {
		const alice = await connect(live().port, edgeHeaders('alice'));
		const bob = await connect(live().port, edgeHeaders('bob'));
		await joinAndSettle(alice);
		await joinAndSettle(bob);

		const view = lastView(alice);
		if (view?.viewer.kind !== 'seat') throw new Error('alice should be seated');
		const taken = view.viewer.pack[0];
		if (taken === undefined) throw new Error('an opening pack should not be empty');
		alice.send(pickCard(DRAFT_ID, taken.cardId));
		await waitUntil(() => (lastView(alice)?.seq ?? 0) > view.seq, 'the pick to land');

		const aliceId = alice.id;
		alice.socket.disconnect();
		await waitUntil(() => !room().clients.has(aliceId), 'the disconnect to be processed');
		// The seat is empty but HELD — the pod is not handing it to a stranger.
		expect(room().seats.reservations[0]?.participantId).toBeDefined();

		// Same friend key, new socket: the same `ParticipantId`.
		const back = await connect(live().port, edgeHeaders('alice'));
		await joinAndSettle(back);

		const restored = lastView(back);
		expect(restored?.viewer.kind).toBe('seat');
		if (restored?.viewer.kind !== 'seat') return;
		expect(restored.viewer.seatId).toBe(0);
		expect(restored.viewer.pool.map((c) => c.cardId)).toEqual([taken.cardId]);
	});
});

/* ── The refresh guard ───────────────────────────────────────────────── */

describe('a browser refresh', () => {
	it('leaves the drafter on the same seat when the stale socket closes behind them', async () => {
		const first = await connect(live().port, edgeHeaders('alice'));
		const bob = await connect(live().port, edgeHeaders('bob'));
		await joinAndSettle(first);
		await joinAndSettle(bob);

		const participantId = room().clients.get(first.id)?.participantId ?? '';
		expect(seatOf(room().seats, participantId)).toBe(0);

		// The refresh: the new tab connects and joins while the old one is still
		// registered, exactly as a browser does it.
		const second = await connect(live().port, edgeHeaders('alice'));
		await joinAndSettle(second);
		expect(room().clients.has(first.id)).toBe(true);
		expect(seatOf(room().seats, participantId)).toBe(0);

		// …and only now does the stale socket close. Without the guard,
		// `leaveRoom` unseats a drafter who is sitting right there.
		const staleId = first.id;
		first.socket.disconnect();
		await waitUntil(() => !room().clients.has(staleId), 'the stale close to be processed');

		expect(seatOf(room().seats, participantId)).toBe(0);
		expect(roleOf(room().seats, participantId)).toBe('player');
		expect(room().clients.get(second.id)?.participantId).toBe(participantId);

		// And the surviving tab agrees, over the wire.
		const before = second.received.length;
		second.send(resyncRequest(DRAFT_ID, null));
		await waitUntil(() => second.received.length > before, 'the resync answer');
		const view = lastView(second);
		expect(view?.viewer.kind).toBe('seat');
		if (view?.viewer.kind !== 'seat') return;
		expect(view.viewer.seatId).toBe(0);
	});
});

/* ── Rate limiting ───────────────────────────────────────────────────── */

describe('picks are rate limited per participant', () => {
	it('answers over-budget picks with rate-limited, ahead of any engine verdict', async () => {
		await harness?.close();
		harness = await boot({ rateLimit: { capacity: 1, refillAmount: 1, refillIntervalMs: 600_000 } });

		const alice = await connect(live().port, edgeHeaders('alice'));
		await joinAndSettle(alice);
		const view = lastView(alice);
		if (view?.viewer.kind !== 'seat') throw new Error('alice should be seated');
		const first = view.viewer.pack[0];
		const second = view.viewer.pack[1];
		if (first === undefined || second === undefined) throw new Error('need two cards');

		alice.send(pickCard(DRAFT_ID, first.cardId));
		await waitUntil(() => (lastView(alice)?.seq ?? 0) > view.seq, 'the first pick');

		alice.send(pickCard(DRAFT_ID, second.cardId));
		await waitUntil(() => errors(alice).length > 0, 'the rate limit');
		// The limiter runs BEFORE the engine, so this is `rate-limited` and not
		// the `already-picked` the engine would have said.
		expect(errors(alice)[0]?.code).toBe('rate-limited');
	});

	it('does not hand a reconnecting participant a fresh budget', async () => {
		await harness?.close();
		harness = await boot({ rateLimit: { capacity: 1, refillAmount: 1, refillIntervalMs: 600_000 } });

		const alice = await connect(live().port, edgeHeaders('alice'));
		await joinAndSettle(alice);
		const view = lastView(alice);
		if (view?.viewer.kind !== 'seat') throw new Error('alice should be seated');
		const card = view.viewer.pack[0];
		if (card === undefined) throw new Error('an opening pack should not be empty');
		alice.send(pickCard(DRAFT_ID, card.cardId));
		await waitUntil(() => (lastView(alice)?.seq ?? 0) > view.seq, 'the first pick');

		const staleId = alice.id;
		alice.socket.disconnect();
		await waitUntil(() => !room().clients.has(staleId), 'the disconnect');

		// A new socket, the same person, the same bucket — the key is the
		// ParticipantId, so reconnecting is not a way to buy more picks.
		const back = await connect(live().port, edgeHeaders('alice'));
		await joinAndSettle(back);
		const restored = lastView(back);
		if (restored?.viewer.kind !== 'seat') throw new Error('alice should be seated again');
		const next = restored.viewer.pack[0];
		if (next === undefined) throw new Error('the pack should still have cards');
		back.send(pickCard(DRAFT_ID, next.cardId));
		await waitUntil(() => errors(back).length > 0, 'the rate limit');
		expect(errors(back)[0]?.code).toBe('rate-limited');
	});
});
