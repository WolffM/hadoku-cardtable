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
	watchDraft,
	safeParseServerMessage,
	type DraftCard,
	type DraftView,
	type ServerMessage,
} from '@hadoku/shared';

import type { DraftRoom, DraftRooms } from './draftRooms.js';
import { identityFromHeaders } from './identity.js';
import type { Lobby } from './lobby.js';
import type { CubePool } from './pool.js';

const BUNDLED_POOL_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../ui/src/draft/pool.json');
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
	const load = poolMod.loadPool(BUNDLED_POOL_FIXTURE);
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
	// startDraft also gates on the plan's verdict (wave 73 §A follow-up) — this
	// lobby is never given a `checkPlan`, so nothing auto-checks one; approve
	// it directly, the way a PUT would, since this file is not about plans.
	const plan = lobby.get(startedRoomId)?.pod?.plan;
	if (plan === undefined || plan === null) throw new Error('the started room has no plan');
	if (!lobby.setPodPlan(startedRoomId, OWNER.id, plan, { ok: true, cards: 1 }).ok) throw new Error('the lobby refused to approve the plan');
	const started = lobby.startDraft(startedRoomId, OWNER.id);
	if (!started.ok) throw new Error(`the lobby refused to start the draft: ${started.reason}`);
	if (lobby.get(pendingRoomId)?.draftStartedAt !== null) throw new Error('the pending room started itself');
	return lobby;
}

async function boot(
	deps: {
		rateLimit?: { capacity: number; refillAmount: number; refillIntervalMs: number };
		botPickMs?: number;
		/** A test's own clock, so it never waits out the real 30 s. */
		seatReleaseMs?: number;
		schedule?: (fn: () => void, ms: number) => void;
	} = {},
): Promise<Harness> {
	const rooms = roomsMod.createDraftRooms({ ...roomsMod.singlePoolResolver(pool) });
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
		botPickMs: deps.botPickMs,
		seatReleaseMs: deps.seatReleaseMs,
		schedule: deps.schedule,
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
		const pendingPlan = live().lobby.get(pendingRoomId)?.pod?.plan;
		if (pendingPlan === undefined || pendingPlan === null) throw new Error('the pending room has no plan');
		expect(live().lobby.setPodPlan(pendingRoomId, OWNER.id, pendingPlan, { ok: true, cards: 1 }).ok).toBe(true);
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

	it("shows someone with no seat one drafter's pack and picks, the seat they ask for, and never a drafter anyone else's", async () => {
		const alice = await connect(live().port, edgeHeaders('alice'));
		const bob = await connect(live().port, edgeHeaders('bob'));
		await joinAndSettle(alice);
		await joinAndSettle(bob);
		const bobSeat = lastView(bob);
		if (bobSeat?.viewer.kind !== 'seat') throw new Error('bob should be seated');

		// Leaving releases the seat; they stay connected, watching the table's
		// first human drafter — bob, now that alice's own seat is let go.
		const before = alice.received.length;
		alice.send(leaveDraft(startedRoomId));
		await waitUntil(() => alice.received.length > before, 'the spectator payload');
		const watched = lastView(alice)?.viewer;
		const bobNow = lastView(bob)?.viewer;
		if (watched?.kind !== 'watcher' || bobNow?.kind !== 'seat') throw new Error('alice watches, bob drafts');
		expect(watched.seatId).toBe(bobNow.seatId);
		expect(watched.pack.map((c) => c.cardId)).toEqual(bobNow.pack.map((c) => c.cardId));
		expect(watched.pool.map((c) => c.cardId)).toEqual(bobNow.pool.map((c) => c.cardId));

		// Asked for another seat, a bot's, she watches that one instead.
		const bot = 2;
		alice.send(watchDraft(startedRoomId, bot));
		await waitUntil(() => {
			const v = lastView(alice)?.viewer;
			return v?.kind === 'watcher' && v.seatId === bot;
		}, 'the bot seat');
		const botView = lastView(alice);
		if (botView?.viewer.kind !== 'watcher') throw new Error('alice should be watching');
		expect(botView.seats[bot]?.occupant?.kind).toBe('bot');
		expect(botView.viewer.pack.length).toBeGreaterThan(0);
		expect(botView.viewer.pool).toHaveLength(botView.seats[bot]?.pickedCount ?? -1);

		// A drafter asking to watch is still shown their own seat.
		const bobBefore = bob.received.length;
		bob.send(watchDraft(startedRoomId, 0));
		await waitUntil(() => bob.received.length > bobBefore, "bob's answer");
		expect(lastView(bob)?.viewer).toMatchObject({ kind: 'seat', seatId: bobSeat.viewer.seatId });
		for (const msg of bob.received) {
			if (msg.type === 'state' || msg.type === 'update') expect(msg.view.viewer.kind).toBe('seat');
		}
		for (const payload of bob.raw) expect(leakedCardPaths(payload)).toEqual([]);

		// A seat the table does not have is refused.
		alice.send(watchDraft(startedRoomId, 99));
		await waitUntil(() => errors(alice).length > 0, 'the refusal');
		expect(errors(alice)[0]?.code).toBe('unknown-seat');
	});
});

/* ── Rejections are values ───────────────────────────────────────────── */

describe('a pick the engine refuses', () => {
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

		// The card she just took has gone on to her pool: asking for it again is
		// a pick the engine refuses.
		alice.send(pickCard(startedRoomId, taken.cardId));
		await waitUntil(() => errors(alice).length > 0, 'the rejection');

		expect(errors(alice)).toHaveLength(1);
		expect(errors(alice)[0]?.code).toBe('card-not-in-pack');
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
		await waitUntil(() => lastView(alice)?.viewer.kind === 'watcher', 'the seat release');

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

/* ── Bots on the clock ───────────────────────────────────────────────── */

describe('bots on the clock', () => {
	it('take one card each per turn once someone is seated, and the packs pile up in front of a seat that does not pick', async () => {
		await harness?.close();
		harness = await boot({ botPickMs: 40 });
		const alice = await connect(live().port, edgeHeaders('alice'));
		await joinAndSettle(alice);
		const opening = lastView(alice);
		if (opening?.viewer.kind !== 'seat') throw new Error('alice should be seated');
		const seat = opening.viewer.seatId;
		expect(opening.seats[seat]?.queueDepth).toBe(0);

		// One bot turn: every bot holding a pack took exactly one card.
		await waitUntil(() => lines().some((l) => l.evt === 'bot-picks'), 'the first bot turn');
		const first = lines().find((l) => l.evt === 'bot-picks');
		expect(first?.picks).toBe(7);

		// Alice never picks, so every other pack of the round ends up waiting on her.
		await waitUntil(() => lastView(alice)?.seats[seat]?.queueDepth === 7, 'the whole round to wait on alice', 10_000);
		const piled = lastView(alice);
		expect(piled?.seats.filter((s) => s.id !== seat).map((s) => s.queueDepth)).toEqual([0, 0, 0, 0, 0, 0, 0]);
		expect(piled?.waitingOn).toEqual([seat]);
		// She still sees only the pack she is picking from: her own, untouched.
		if (piled?.viewer.kind !== 'seat') throw new Error('alice should be seated');
		expect(piled.viewer.pack.map((c) => c.cardId)).toEqual(opening.viewer.pack.map((c) => c.cardId));
		expect(piled.pickNumber).toBe(1);
	});
});

function lines(): Array<Record<string, unknown>> {
	return live().lines;
}

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

/**
 * Ruled 2026-10-26: 30 s. `constructedRoomId` plays no draft, so this
 * is the one place in the file that seats somebody at its table directly
 * (`Lobby.sit`) rather than through a draft's own join — the gate this
 * socket layer puts in front of a draft is a different question from the
 * seat-release timer, which fires for ANY connection this server holds (the
 * module header's own point: `room/feed.ts`'s socket shares the same
 * handshake). `schedule` is injected so no test waits out the real 30 s.
 */
describe('a seat with nobody connected to it, for the window', () => {
	/** The id a socket connecting with `edgeHeaders(userKey)` mints — independent of its actual socket id, since a friend key is present. */
	function participantIdFor(userKey: string): string {
		return identityFromHeaders(edgeHeaders(userKey) as unknown as Parameters<typeof identityFromHeaders>[0], 'unused');
	}

	/** `userKey` joins `constructedRoomId` and sits at its one table. Returns the ids the test reads back by. */
	async function seatedAt(userKey: string): Promise<{ tableId: string; memberId: string }> {
		const memberId = participantIdFor(userKey);
		expect(live().lobby.join(constructedRoomId, { id: memberId, name: `user-${userKey}` }).ok).toBe(true);
		const tableId = live().lobby.get(constructedRoomId)!.tables[0]!.id;
		expect(live().lobby.sit(constructedRoomId, tableId, memberId)).toBe(true);
		return { tableId, memberId };
	}

	/** Connects as `userKey` and waits for this server's own `connected` log line — proof `liveConnections` has already counted it, not just that the client's `connect` event fired. */
	async function connectCounted(userKey: string): ReturnType<typeof connect> {
		const before = live().lines.filter((l) => l.evt === 'connected' && l.participantId === participantIdFor(userKey)).length;
		const peer = await connect(live().port, edgeHeaders(userKey));
		await waitUntil(
			() => live().lines.filter((l) => l.evt === 'connected' && l.participantId === participantIdFor(userKey)).length > before,
			`${userKey}’s connection to be counted`,
		);
		return peer;
	}

	it('gives the seat back once the window elapses with nobody reconnected, and logs it', async () => {
		await harness?.close();
		const timers: Array<() => void> = [];
		harness = await boot({ schedule: (fn) => timers.push(fn) });
		const { tableId, memberId } = await seatedAt('alice');

		const alice = await connectCounted('alice');
		alice.socket.disconnect();
		await waitUntil(() => timers.length > 0, 'the release timer to be scheduled');
		// Scheduled, not fired: the seat is untouched until the window is up.
		expect(live().lobby.seats(constructedRoomId, tableId).map((s) => s.memberId)).toContain(memberId);

		timers.shift()!();
		expect(live().lobby.seats(constructedRoomId, tableId).map((s) => s.memberId)).not.toContain(memberId);
		expect(live().lines).toContainEqual({ evt: 'seat-released-disconnected', participantId: memberId, roomId: constructedRoomId, tableId });
	});

	it('keeps the seat when a reload reconnects inside the window — the timer still runs, but finds them connected again', async () => {
		await harness?.close();
		const timers: Array<() => void> = [];
		harness = await boot({ schedule: (fn) => timers.push(fn) });
		const { tableId, memberId } = await seatedAt('alice');

		const alice = await connectCounted('alice');
		alice.socket.disconnect();
		await waitUntil(() => timers.length > 0, 'the release timer to be scheduled');

		// A reload: the SAME participant id (the edge headers mint it, never the
		// socket), a brand new connection, well inside the window — and the timer
		// scheduled on the first disconnect is never cancelled, it is just a no-op
		// once it runs (the module header's own point).
		const reloaded = await connectCounted('alice');
		timers.shift()!();
		expect(live().lobby.seats(constructedRoomId, tableId).map((s) => s.memberId)).toContain(memberId);
		expect(live().lines.filter((l) => l.evt === 'seat-released-disconnected')).toEqual([]);
		reloaded.socket.disconnect();
	});

	it('never releases a seat while its table has a live match', async () => {
		await harness?.close();
		const timers: Array<() => void> = [];
		harness = await boot({ schedule: (fn) => timers.push(fn) });
		const { tableId, memberId } = await seatedAt('alice');
		expect(live().lobby.setTableMatch(constructedRoomId, tableId, 'm-live')).toBe(true);

		const alice = await connectCounted('alice');
		alice.socket.disconnect();
		await waitUntil(() => timers.length > 0, 'the release timer to be scheduled');
		timers.shift()!();
		expect(live().lobby.seats(constructedRoomId, tableId).map((s) => s.memberId)).toContain(memberId);
	});

	it('a second tab’s own connection keeps the window from ever starting', async () => {
		await harness?.close();
		const timers: Array<() => void> = [];
		harness = await boot({ schedule: (fn) => timers.push(fn) });
		await seatedAt('alice');

		const first = await connectCounted('alice');
		const second = await connectCounted('alice');
		first.socket.disconnect();
		// Still one tab open: nothing scheduled.
		await new Promise((r) => setTimeout(r, 20));
		expect(timers).toHaveLength(0);
		second.socket.disconnect();
		await waitUntil(() => timers.length > 0, 'the release timer to be scheduled once the LAST tab is gone');
	});
});
