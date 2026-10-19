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
 * ## The lobby is real, because the readiness gate is a lobby read
 *
 * A `join` is admitted only for a room the lobby says is a `draft` whose draft
 * has STARTED (wave 23), so every test here runs against a real `openLobby` over
 * a temp directory, with three real rooms in it: a started draft (what the
 * drafting tests join), a draft still in its lobby, and a constructed room. A
 * stub lobby would let the gate agree with the test's idea of the rules instead
 * of with the lobby's.
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

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { roleOf, seatOf } from '@wolffm/rooms-protocol';
import { MultiRateLimiter } from '@wolffm/rooms-server';
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
import type { Lobby } from './lobby.js';
import type { CubePool } from './pool.js';

const POOL_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../ui/src/draft/pool.json');
const EDGE_SECRET = 'test-edge-auth-secret';

/*
 * `config.ts` reads the environment once, at module load, so the secret has to
 * be in place before anything that imports it is evaluated. ESM import
 * declarations hoist, so the modules under test are pulled in dynamically after
 * the environment is set — the alternative is an import-ordering trick that
 * works until somebody reorders the imports.
 */
let socketMod: typeof import('./socket.ts');
let roomsMod: typeof import('./draftRooms.ts');
let lobbyMod: typeof import('./lobby.ts');
let pool: CubePool;

/** The room that owns the draft every drafting test joins. `r-<hex>`, minted by the lobby. */
let startedRoomId = '';
/** A draft room whose members have NOT all readied: the gate's own case. */
let pendingRoomId = '';
/** A room playing constructed. Nothing here may ever be dealt a pod for it. */
let constructedRoomId = '';

/** The lobby's member, and the caller that starts the draft. Durable, so `create` accepts it. */
const OWNER = { id: 'fk:1111111111111111', name: 'user-owner' };

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	socketMod = await import('./socket.ts');
	roomsMod = await import('./draftRooms.ts');
	lobbyMod = await import('./lobby.ts');
	const poolMod = await import('./pool.ts');
	const load = poolMod.loadPool(POOL_FILE);
	if (!load.ok) throw new Error(`the bundled cube pool did not load: ${load.detail}`);
	pool = load.pool;
});

/* ── Harness ─────────────────────────────────────────────────────────── */

interface Harness {
	port: number;
	rooms: DraftRooms;
	/** The real lobby the gate reads. Its three rooms are the module-level ids. */
	lobby: Lobby;
	io: SocketIOServer;
	http: HttpServer;
	/**
	 * Every structured line the socket layer emitted, in order.
	 *
	 * Captured rather than silenced because one field on one line is a product
	 * observable rather than noise: `disconnected … guarded` is the only report
	 * that the stale-close ordering happened at all, now that
	 * `@wolffm/rooms-server` holds the seat itself and there is no seat change
	 * left to assert. `e2e/draft.spec.ts:456` reads that same field out of the
	 * real server's stdout; this makes the claim checkable without a browser.
	 */
	lines: Array<Record<string, unknown>>;
	close: () => Promise<void>;
}

const openPeers: ClientSocket[] = [];
/** Every temp lobby directory this file made, removed once at the end. */
const dirs: string[] = [];
let harness: Harness | null = null;

/** Three rooms in a real lobby: a started draft, a draft still in its lobby, a constructed room. */
async function bootLobby(): Promise<Lobby> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-socket-test-'));
	dirs.push(dir);
	const lobby = await lobbyMod.openLobby({ dir });
	const make = (name: string, gameType: 'draft' | 'constructed-1v1'): string => {
		const made = lobby.create(OWNER, { name, gameType, clientMode: 'builtin' });
		if (!made.ok) throw new Error(`the lobby refused to create ${name}: ${made.reason}`);
		return made.room.id;
	};
	startedRoomId = make('pod-socket-started', 'draft');
	pendingRoomId = make('pod-socket-pending', 'draft');
	constructedRoomId = make('table-socket', 'constructed-1v1');

	// Only the first one is started, through the lobby's own rules: every member
	// ready, then `startDraft`. Nothing here sets `draftStartedAt` by hand.
	if (!lobby.setReady(startedRoomId, OWNER.id, true)) throw new Error('the lobby refused a ready flag');
	// No deal with an open seat: the AI holds the other seven.
	for (let seat = 1; seat < 8; seat++) if (!lobby.aiPod(startedRoomId, OWNER.id, seat, true).ok) throw new Error('the lobby refused an AI seat');
	const started = lobby.startDraft(startedRoomId, OWNER.id);
	if (!started.ok) throw new Error(`the lobby refused to start the draft: ${started.reason}`);
	if (lobby.get(pendingRoomId)?.draftStartedAt !== null) throw new Error('the pending room started itself');
	return lobby;
}

async function boot(deps: { rateLimit?: { capacity: number; refillAmount: number; refillIntervalMs: number } } = {}): Promise<Harness> {
	const rooms = roomsMod.createDraftRooms({ pool: pool.cards, cube: pool.meta });
	const lobby = await bootLobby();
	const http = createServer();
	const io = new SocketIOServer(http, { serveClient: false });
	// Collected, not printed: nothing reaches the test output, and the one line
	// that is a product observable stays assertable. See `Harness.lines`.
	const lines: Array<Record<string, unknown>> = [];
	const handle = socketMod.attachDraftSocket(io, {
		rooms,
		lobby,
		minTier: 'friend',
		log: (line) => {
			lines.push(line);
		},
		rateLimit: deps.rateLimit,
	});
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	const port = (http.address() as AddressInfo).port;
	return {
		port,
		rooms,
		lobby,
		io,
		http,
		lines,
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

async function joinAndSettle(peer: Peer, draftId: string = startedRoomId): Promise<void> {
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

afterAll(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function live(): Harness {
	if (harness === null) throw new Error('no harness');
	return harness;
}

function room(): DraftRoom {
	const found = live().rooms.find(startedRoomId);
	if (found === undefined) throw new Error(`no room for ${startedRoomId}`);
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

/* ── The readiness gate ──────────────────────────────────────────────── */

/*
 * The control this wave exists for. `case 'join'` used to be
 * `rooms.open(msg.draftId)`: the first socket to name any id was dealt a whole
 * eight-seat pod against it and every seat nobody had taken was a bot. So the
 * assertion is not only "an error came back" — it is that NO DRAFT EXISTS
 * afterwards and that the socket was shown no cards at all, because that is what
 * a reverted gate would break.
 */
describe('a join against a draft that has not started', () => {
	it('is refused and deals NOTHING — no draft is built and no card is sent', async () => {
		const alice = await connect(live().port, edgeHeaders('alice'));
		// The lobby really has this room, and it really is a draft: the refusal
		// below is about readiness and nothing else.
		expect(live().lobby.get(pendingRoomId)?.gameType).toBe('draft');
		expect(live().lobby.get(pendingRoomId)?.draftStartedAt).toBeNull();

		alice.send(joinDraft(pendingRoomId));
		await waitUntil(() => alice.received.length > 0, 'the refusal');

		expect(errors(alice)).toEqual([
			{ code: 'unknown-draft', detail: 'that draft has not started yet' },
		]);
		// Nothing but the refusal reached this socket.
		expect(alice.received.map((m) => m.type)).toEqual(['error']);
		expect(lastView(alice)).toBeNull();
		expect(cardsSeenBy(alice)).toEqual([]);
		// And no pod was dealt, for this id or any other. THIS is the assertion
		// that fails if the gate is removed.
		expect(live().rooms.find(pendingRoomId)).toBeUndefined();
		expect(live().rooms.all()).toEqual([]);
		// The refusal is logged with its reason, for the operator reading stdout.
		expect(live().lines.filter((l) => l.evt === 'join-refused')).toEqual([
			{ evt: 'join-refused', participantId: expect.any(String), draftId: pendingRoomId, reason: 'not-started' },
		]);
	});

	it('is refused for a room playing constructed, and for an id that is no room at all', async () => {
		const alice = await connect(live().port, edgeHeaders('alice'));
		alice.send(joinDraft(constructedRoomId));
		await waitUntil(() => errors(alice).length > 0, 'the constructed refusal');
		expect(errors(alice)[0]).toEqual({ code: 'unknown-draft', detail: 'that room is not playing a draft' });

		alice.send(joinDraft('kindly-willow-6kgg'));
		await waitUntil(() => errors(alice).length > 1, 'the no-room refusal');
		expect(errors(alice)[1]).toEqual({ code: 'unknown-draft', detail: 'no room with that id' });

		// A client-minted pod id is exactly the shape the deleted "Start a pod"
		// button used to hand out, and it buys nothing now.
		expect(live().rooms.all()).toEqual([]);
		expect(live().lines.filter((l) => l.evt === 'join-refused').map((l) => l.reason)).toEqual([
			'not-draft',
			'no-room',
		]);
	});

	it('becomes a pod the moment the LOBBY says the draft started, on the same id', async () => {
		const alice = await connect(live().port, edgeHeaders('alice'));
		alice.send(joinDraft(pendingRoomId));
		await waitUntil(() => errors(alice).length > 0, 'the refusal');

		// The room starts through the lobby's own rules — every member ready,
		// then `startDraft` — and nothing about the socket changed.
		expect(live().lobby.setReady(pendingRoomId, OWNER.id, true)).toBe(true);
		for (let seat = 1; seat < 8; seat++) expect(live().lobby.aiPod(pendingRoomId, OWNER.id, seat, true).ok).toBe(true);
		expect(live().lobby.startDraft(pendingRoomId, OWNER.id).ok).toBe(true);

		alice.send(joinDraft(pendingRoomId));
		await waitUntil(() => lastView(alice) !== null, 'the pod');
		const view = lastView(alice);
		expect(view?.draftId).toBe(pendingRoomId);
		expect(view?.viewer.kind).toBe('seat');
		// One id, not two: the pod's id IS the room's, server-minted.
		expect(pendingRoomId).toMatch(/^r-[0-9a-f]{12}$/);
		expect(live().rooms.find(pendingRoomId)?.roomId).toBe(pendingRoomId);
	});

	it('seats a human into a pod whose other seven seats are bots, and only then', async () => {
		// Bots exist from the instant the draft is dealt and never before: the
		// eight-seat table does not exist at all until the room starts it.
		expect(live().rooms.find(startedRoomId)).toBeUndefined();
		const alice = await connect(live().port, edgeHeaders('alice'));
		await joinAndSettle(alice);
		const view = lastView(alice);
		expect(view?.seats).toHaveLength(8);
		expect(view?.seats.filter((seat) => seat.occupant?.kind === 'bot')).toHaveLength(7);
		expect(view?.seats.filter((seat) => seat.occupant?.kind === 'human')).toHaveLength(1);
	});
});

/* ── Identity ────────────────────────────────────────────────────────── */

describe('identity comes from the edge, never from the client', () => {
	it('refuses a message that carries a participantId', async () => {
		const alice = await connect(live().port, edgeHeaders('alice'));
		alice.send({ type: 'join', draftId: startedRoomId, participantId: 'fk:0000000000000000' });
		await waitUntil(() => alice.received.length > 0, 'a rejection');

		expect(errors(alice)).toHaveLength(1);
		expect(errors(alice)[0]?.code).toBe('malformed-message');
		expect(errors(alice)[0]?.detail).toContain('participantId');
		// And nothing happened: the join did not go through under any identity.
		expect(live().rooms.find(startedRoomId)).toBeUndefined();
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
		alice.send(pickCard(startedRoomId, taken.cardId));
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
		alice.send(leaveDraft(startedRoomId));
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

		alice.send(pickCard(startedRoomId, taken.cardId));
		await waitUntil(() => (lastView(alice)?.seq ?? 0) > opening.seq, 'the pick to land');
		const afterPick = lastView(alice);
		if (afterPick?.viewer.kind !== 'seat') throw new Error('alice should still be seated');
		const seqAfterPick = afterPick.seq;

		// The round has not advanced — bob still owes a pick — so alice picking
		// again is out of turn.
		const second = afterPick.viewer.pack[0];
		if (second === undefined) throw new Error('the pack should still have cards');
		alice.send(pickCard(startedRoomId, second.cardId));
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

		alice.send(leaveDraft(startedRoomId));
		await waitUntil(() => lastView(alice)?.viewer.kind === 'spectator', 'the seat release');

		alice.send(pickCard(startedRoomId, card.cardId));
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

/* ── The pick step says it is complete ───────────────────────────────── */

describe('the step after a pick', () => {
	it('jumps seq by the bot picks behind it, in ONE envelope per recipient marked full-state', async () => {
		const alice = await connect(live().port, edgeHeaders('alice'));
		const bob = await connect(live().port, edgeHeaders('bob'));
		await joinAndSettle(alice);
		await joinAndSettle(bob);
		await waitUntil(() => alice.received.length >= 2, 'alice to see bob arrive');

		// A join's step is +1 and stays unmarked: nothing about it is a jump.
		const arrival = alice.received.at(-1);
		expect(arrival?.type).toBe('update');
		expect(arrival?.type === 'update' ? arrival.carries : 'not-an-update').toBeUndefined();

		const opening = lastView(alice);
		if (opening?.viewer.kind !== 'seat') throw new Error('alice should be seated');
		const taken = opening.viewer.pack[0];
		if (taken === undefined) throw new Error('an opening pack should not be empty');
		const aliceBefore = alice.received.length;
		const bobBefore = bob.received.length;
		const bobSeqBefore = lastView(bob)?.seq ?? 0;

		alice.send(pickCard(startedRoomId, taken.cardId));
		await waitUntil(
			() => alice.received.length > aliceBefore && bob.received.length > bobBefore,
			'the pick step to reach both seats',
		);

		for (const [peer, before] of [
			[alice, aliceBefore],
			[bob, bobBefore],
		] as const) {
			const step = peer.received.slice(before);
			// One envelope, not one per bot pick.
			expect(step).toHaveLength(1);
			const msg = step[0];
			expect(msg?.type).toBe('update');
			if (msg?.type !== 'update') return;
			expect(msg.carries).toBe('full-state');
			expect(msg.cursor.seq).toBe(roomsSeq());
		}
		// The bots really did move seq by more than one — the case this marker
		// exists for. Without the jump the test would prove nothing.
		expect(roomsSeq() - bobSeqBefore).toBeGreaterThan(1);
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
		alice.send(pickCard(startedRoomId, taken.cardId));
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
		second.send(resyncRequest(startedRoomId, null));
		await waitUntil(() => second.received.length > before, 'the resync answer');
		const view = lastView(second);
		expect(view?.viewer.kind).toBe('seat');
		if (view?.viewer.kind !== 'seat') return;
		expect(view.viewer.seatId).toBe(0);
	});

	/*
	 * `guarded` is all that is left of the workaround this file used to test.
	 * Through 0.38.x the seat came back because `draftRooms.ts` put it back;
	 * `@wolffm/rooms-server@0.39.5` deletes the client first and unseats only a
	 * participant's LAST connection, so there is no repair left to observe —
	 * the seat simply never moves, which is indistinguishable from a stale
	 * close that was never processed at all.
	 *
	 * So the flag is the observable, and it only exists on the wire out: the
	 * `disconnected` log line. `e2e/draft.spec.ts:456-502` reads it from the
	 * real server's stdout and requires at least one. That e2e needs a browser
	 * and a built bundle; this needs neither, so the claim in `draftRooms.ts`'s
	 * header stops resting on a suite most runs skip.
	 */
	it('reports the ordering on the way out, because the seat no longer moves', async () => {
		const first = await connect(live().port, edgeHeaders('alice'));
		await joinAndSettle(first);
		const participantId = room().clients.get(first.id)?.participantId ?? '';

		const second = await connect(live().port, edgeHeaders('alice'));
		await joinAndSettle(second);

		const staleId = first.id;
		first.socket.disconnect();
		await waitUntil(() => !room().clients.has(staleId), 'the stale close to be processed');

		const disconnects = live().lines.filter((l) => l.evt === 'disconnected');
		expect(disconnects).toHaveLength(1);
		expect(disconnects[0]).toMatchObject({ participantId, draftId: startedRoomId, guarded: true });
		// The seat did not move, which is exactly why the flag has to exist.
		expect(seatOf(room().seats, participantId)).toBe(0);
	});

	it('says guarded:false for a drop with nobody else carrying the id', async () => {
		const alice = await connect(live().port, edgeHeaders('alice'));
		await joinAndSettle(alice);
		const participantId = room().clients.get(alice.id)?.participantId ?? '';

		const aliceId = alice.id;
		alice.socket.disconnect();
		await waitUntil(() => !room().clients.has(aliceId), 'the disconnect to be processed');

		const disconnects = live().lines.filter((l) => l.evt === 'disconnected');
		expect(disconnects).toHaveLength(1);
		expect(disconnects[0]).toMatchObject({ participantId, guarded: false });
		// The real departure: unseated, and the reservation is what holds it.
		expect(seatOf(room().seats, participantId)).toBeNull();
		expect(room().seats.reservations[0]?.participantId).toBe(participantId);
	});
});

/* ── Rate limiting ───────────────────────────────────────────────────── */

describe('picks are rate limited per participant', () => {
	it('never refuses a human clicking through a pack against bots', () => {
		// The pick times of the draft that was refused on 2026-10-18 (05:41:32Z
		// onwards, ms from the first pick): the next pack arrived at once, and
		// the old budget refused the eleventh click.
		const at = [0, 1703, 2104, 2448, 2691, 2865, 3043, 3195, 3339, 3481, 3623, 15977, 18066, 18217, 18585, 18946, 19839, 20150, 20450, 20713, 21043, 21353, 21646];
		const limiter = new MultiRateLimiter<string>(socketMod.PICK_RATE_LIMIT);
		try {
			expect(at.map((t) => limiter.allow('p', 1, 1_000_000 + t))).not.toContain(false);
			// A script is still stopped: a pack's worth at once, then nothing.
			const burst = Array.from({ length: 20 }, () => limiter.allow('s', 1, 5_000_000));
			expect(burst.filter(Boolean)).toHaveLength(socketMod.PICK_RATE_LIMIT.capacity);
		} finally {
			limiter.deregister();
		}
	});

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

		alice.send(pickCard(startedRoomId, first.cardId));
		await waitUntil(() => (lastView(alice)?.seq ?? 0) > view.seq, 'the first pick');

		alice.send(pickCard(startedRoomId, second.cardId));
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
		alice.send(pickCard(startedRoomId, card.cardId));
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
		back.send(pickCard(startedRoomId, next.cardId));
		await waitUntil(() => errors(back).length > 0, 'the rate limit');
		expect(errors(back)[0]?.code).toBe('rate-limited');
	});
});
