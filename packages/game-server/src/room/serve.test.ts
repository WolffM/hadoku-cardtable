/**
 * `attachServedRoom`, generic over the game: a real socket.io server, real `socket.io-client`
 * connections to the `/room` namespace, a real `RoomLobby` (on `plainRoomType`, the shape a game
 * with nothing of its own — bomberman's — plays on) over a temp directory, a plain
 * `PresenceTracker` and the real account lookup (`createPeople`) over a stand-in prefs-api.
 * Who may join is a safety control, so it is proved against a server that ran the check.
 *
 * Moved and genericized from `games/magic/server/src/room/serve.test.ts` (wave 119 §S): the fixture
 * lobby here is `RoomLobby`/`plainRoomType` straight from `./lobby.ts`, not Magic's `FileLobby`,
 * which is exactly the point of the move — this file proves the room socket works for a game that
 * is NOT Magic.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { FileRoomStore } from '@wolffm/rooms-server/store';
import { PresenceTracker } from '@wolffm/rooms-server';
import { ROOM_ID_RE } from '@hadoku/platform-wire/room-feed';

const EDGE_SECRET = 'test-edge-auth-secret';
const APP_ID = 'w119s-test';

/* `config.ts` reads `EDGE_AUTH_SECRET` once, at module load: everything under test is imported after it is set. */
let serveMod: typeof import('./serve.ts');
let lobbyMod: typeof import('./lobby.ts');
let gateMod: typeof import('../gate.ts');
let identityMod: typeof import('./identity.ts');
let peopleMod: typeof import('../people.ts');

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	serveMod = await import('./serve.ts');
	lobbyMod = await import('./lobby.ts');
	gateMod = await import('../gate.ts');
	identityMod = await import('./identity.ts');
	peopleMod = await import('../people.ts');
});

/** Headers the edge would stamp for a vouched account, at `tier` (default friend). */
function edgeHeaders(userKey: string, tier = 'friend'): Record<string, string> {
	return { 'x-edge-auth': EDGE_SECRET, 'x-hadoku-tier': tier, 'x-user-id': `user-${userKey}`, 'x-user-key': `friend-key-${userKey}` };
}

/** The durable id a socket connecting with `edgeHeaders(userKey)` mints. */
function participantIdFor(userKey: string): string {
	return identityMod.identityFromHeaders(edgeHeaders(userKey) as unknown as Parameters<typeof identityMod.identityFromHeaders>[0], 'unused');
}

/* ── Harness ─────────────────────────────────────────────────────────── */

type TestLobby = InstanceType<typeof lobbyMod.RoomLobby<import('./lobby.ts').PlatformRoomView, import('./lobby.ts').RoomCreateInput>>;

interface Harness {
	port: number;
	lobby: TestLobby;
	/** An open room, and a password-locked one, both owned by `owner`. */
	roomId: string;
	lockedRoomId: string;
	presence: PresenceTracker<string>;
	people: ReturnType<typeof import('../people.ts').createPeople>;
	/** What the stand-in prefs-api says each account is called, by userId; change it to rename someone. */
	names: Map<string, string>;
	served: Awaited<ReturnType<typeof import('./serve.ts').attachServedRoom>>;
	/** Every `onRoster` call, by room. */
	rosterChanges: string[];
	/** What the served room logged, `room.refused` among it. */
	events: Array<{ event: string; fields: Record<string, unknown> }>;
	close: () => Promise<void>;
}

/** The one match this server's `isMatch` knows: a game no room holds. */
const LIVE_MATCH = 'm-0123456789ab';

const dirs: string[] = [];
const openPeers: ClientSocket[] = [];

async function boot(): Promise<Harness> {
	const lobbyDir = await mkdtemp(join(tmpdir(), 'w119s-room-test-lobby-'));
	const chatDir = await mkdtemp(join(tmpdir(), 'w119s-room-test-chat-'));
	dirs.push(lobbyDir, chatDir);
	const gameType = 'toy-game';
	const lobby: TestLobby = new lobbyMod.RoomLobby({
		store: new FileRoomStore(lobbyDir),
		now: () => Date.now(),
		log: () => undefined,
		typeOf: (t) => (t === gameType ? lobbyMod.plainRoomType({ seats: 2, max: 4 }) : undefined),
		watchpartyRoom: { name: 'wp', gameType },
	});
	await lobby.open();
	const owner = { id: participantIdFor('owner'), name: 'owner', userId: null };
	const made = lobby.create(owner, { name: 'served room', gameType });
	const locked = lobby.create(owner, { name: 'locked room', gameType, password: 'pw' });
	if (!made.ok || !locked.ok) throw new Error('the lobby refused to create the rooms');
	const names = new Map<string, string>();
	const people = peopleMod.createPeople({
		baseUrl: 'https://prefs.test',
		serviceKey: 'k',
		log: () => undefined,
		fetch: async (_url, init) => {
			const { userIds } = JSON.parse(String(init?.body)) as { userIds: string[] };
			const avatars = Object.fromEntries(userIds.map((id) => [id, { source: 'sprite', name: names.get(id) ?? null }]));
			return new Response(JSON.stringify({ avatars }), { status: 200, headers: { 'Content-Type': 'application/json' } });
		},
	});
	const presence = new PresenceTracker<string>({ idleMs: 60_000, graceMs: 0 });

	const http = createServer();
	const io = new SocketIOServer(http, { serveClient: false });
	gateMod.gateSocketIo(io, { minTier: 'friend', surface: 'draft-socket' });
	const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
	const rosterChanges: string[] = [];
	const served = await serveMod.attachServedRoom(io, {
		lobby,
		presence,
		people,
		isMatch: (id) => id === LIVE_MATCH,
		minTier: 'friend',
		stateDir: () => chatDir,
		appId: APP_ID,
		roomIdRe: ROOM_ID_RE,
		onEvent: (_level, event, fields) => events.push({ event, fields }),
		onRoster: (roomId) => rosterChanges.push(roomId),
	});
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	return {
		port: (http.address() as AddressInfo).port,
		lobby,
		roomId: made.room.id,
		lockedRoomId: locked.room.id,
		presence,
		people,
		names,
		served,
		events,
		rosterChanges,
		close: async () => {
			served.close();
			io.close();
			await new Promise<void>((done) => http.close(() => done()));
		},
	};
}

interface Peer {
	socket: ClientSocket;
	snapshots: number;
	historyEvents: number;
	presence: Array<Array<Record<string, unknown>>>;
	broadcasts: Array<Record<string, unknown>>;
	errors: Array<{ code?: string; message?: string }>;
}

/** Connects to `/room` with `headers` and sends `join` for `roomKey`. */
function joinRoom(port: number, headers: Record<string, string>, roomKey: string, extra: Record<string, unknown> = {}): Promise<Peer> {
	return new Promise((resolve, reject) => {
		const socket = ioClient(`http://127.0.0.1:${port}/room`, { path: '/socket.io/', transports: ['polling'], extraHeaders: headers, forceNew: true, reconnection: false });
		openPeers.push(socket);
		const peer: Peer = { socket, snapshots: 0, historyEvents: 0, presence: [], broadcasts: [], errors: [] };
		socket.on('snapshot', () => (peer.snapshots += 1));
		socket.on('chat_history', () => (peer.historyEvents += 1));
		socket.on('presence', (p: { users: Array<Record<string, unknown>> }) => peer.presence.push(p.users));
		socket.on('chat_broadcast', (payload: Record<string, unknown>) => peer.broadcasts.push(payload));
		socket.on('error', (payload: { code?: string; message?: string }) => peer.errors.push(payload));
		socket.on('connect', () => {
			socket.emit('join', { room_key: roomKey, ...extra });
			resolve(peer);
		});
		socket.on('connect_error', (err) => reject(err));
	});
}

/** Connects to `/room` with `headers` and resolves with whether the HANDSHAKE itself succeeded
 *  or was refused — never sends `join`, so this is `gateRoomHandshake`'s own refusal, not `admit`'s. */
function connectAttempt(port: number, headers: Record<string, string>): Promise<{ outcome: 'connected' | 'refused'; message?: string }> {
	return new Promise((resolve) => {
		const socket = ioClient(`http://127.0.0.1:${port}/room`, { path: '/socket.io/', transports: ['polling'], extraHeaders: headers, forceNew: true, reconnection: false });
		openPeers.push(socket);
		socket.on('connect', () => resolve({ outcome: 'connected' }));
		socket.on('connect_error', (err) => resolve({ outcome: 'refused', message: err.message }));
	});
}

const lastRoster = (peer: Peer): Array<Record<string, unknown>> => peer.presence.at(-1) ?? [];

afterEach(() => {
	for (const socket of openPeers.splice(0)) socket.disconnect();
});

afterAll(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/* ── placeOfKey ──────────────────────────────────────────────────────── */

describe('placeOfKey', () => {
	const room = { id: 'r-abc', locked: false, members: [] as { id: string; name: string }[] };
	const lobby = {
		get: (id: string) => (id === 'r-abc' ? room : undefined),
		// The room remembers a table and a match it has moved on from.
		subPlaceOf: (id: string, rest: string) => id === 'r-abc' && (rest === 't-1' || rest === 'm-past'),
	};
	const place = (key: string) => serveMod.placeOfKey(lobby, (id) => id === 'm-1', APP_ID, key, ROOM_ID_RE);

	it('a room’s own key is that room', () => {
		expect(place(`${APP_ID}-r-abc`)).toEqual({ served: 'r-abc', roomId: 'r-abc', kind: 'room' });
	});

	it('a table’s key is served as itself and belongs to its room', () => {
		expect(place(`${APP_ID}-r-abc-t-1`)).toEqual({ served: 'r-abc-t-1', roomId: 'r-abc', kind: 'table' });
	});

	it('a room’s key with a match it played, when the screen’s copy no longer names that table, is the room’s table chat', () => {
		expect(place(`${APP_ID}-r-abc-m-past`)).toEqual({ served: 'r-abc-m-past', roomId: 'r-abc', kind: 'table' });
	});

	it('a match no room holds is served by its own id', () => {
		expect(place(`${APP_ID}-m-1`)).toEqual({ served: 'm-1', roomId: null, kind: 'match' });
	});

	it('is null for another app’s key, a room or match nobody has, a table the room lacks, or an id ROOM_ID_RE refuses', () => {
		expect(place('some-other-app-r-abc')).toBeNull();
		expect(place(`${APP_ID}-r-zzz`)).toBeNull();
		expect(place(`${APP_ID}-m-2`)).toBeNull();
		expect(place(`${APP_ID}-r-abc-t-9`)).toBeNull();
		expect(place(`${APP_ID}-r-abc-m-elsewhere`)).toBeNull();
		expect(place(`${APP_ID}-R-ABC`)).toBeNull();
		expect(place(`${APP_ID}-`)).toBeNull();
	});
});

/* ── Against a real server ───────────────────────────────────────────── */

describe('attachServedRoom', () => {
	it('two members join, see each other on the roster, chat, and the line is kept', async () => {
		const h = await boot();
		try {
			h.lobby.join(h.roomId, { id: participantIdFor('alice'), name: 'alice', userId: 'user-alice' });
			h.lobby.join(h.roomId, { id: participantIdFor('carol'), name: 'carol', userId: 'user-carol' });
			const key = `${APP_ID}-${h.roomId}`;
			const alice = await joinRoom(h.port, edgeHeaders('alice'), key);
			const carol = await joinRoom(h.port, edgeHeaders('carol'), key);
			await vi.waitFor(() => expect(lastRoster(alice).map((u) => u.name).sort()).toEqual(['alice', 'carol']));
			expect(alice.snapshots).toBe(1);
			alice.socket.emit('chat_send', { text: 'hello from alice' });
			await vi.waitFor(() => expect(carol.broadcasts.some((b) => b.text === 'hello from alice')).toBe(true));
			expect((await h.served.chat.store.recentMessages(h.roomId)).some((m) => m.text === 'hello from alice')).toBe(true);
			expect([alice.errors, carol.errors]).toEqual([[], []]);
		} finally {
			await h.close();
		}
	});

	it('`here` names who has a room connection now, never a member who only joined once, and says when it changes', async () => {
		const h = await boot();
		try {
			const [aliceId, carolId] = [participantIdFor('alice'), participantIdFor('carol')];
			h.lobby.join(h.roomId, { id: aliceId, name: 'alice', userId: 'user-alice' });
			h.lobby.join(h.roomId, { id: carolId, name: 'carol', userId: 'user-carol' });
			// Both are members; neither has a screen on the room.
			expect([...h.served.here(h.roomId)]).toEqual([]);
			const key = `${APP_ID}-${h.roomId}`;
			const alice = await joinRoom(h.port, edgeHeaders('alice'), key);
			await vi.waitFor(() => expect([...h.served.here(h.roomId)]).toEqual([aliceId]));
			expect(h.rosterChanges).toEqual([h.roomId]);
			// Her second tab is still one person, and closing one of the two leaves her here.
			const again = await joinRoom(h.port, edgeHeaders('alice'), key);
			await vi.waitFor(() => expect(h.rosterChanges).toHaveLength(2));
			again.socket.disconnect();
			await vi.waitFor(() => expect(h.rosterChanges).toHaveLength(3));
			expect([...h.served.here(h.roomId)]).toEqual([aliceId]);
			alice.socket.disconnect();
			await vi.waitFor(() => expect(h.rosterChanges).toHaveLength(4));
			expect([...h.served.here(h.roomId)]).toEqual([]);
			// The other room never heard of any of it.
			expect([...h.served.here(h.lockedRoomId)]).toEqual([]);
		} finally {
			await h.close();
		}
	});

	it('a room connection is its person’s connection on the ONE tracker it was handed', async () => {
		const h = await boot();
		try {
			const aliceId = participantIdFor('alice');
			h.lobby.join(h.roomId, { id: aliceId, name: 'alice', userId: 'user-alice' });
			const alice = await joinRoom(h.port, edgeHeaders('alice'), `${APP_ID}-${h.roomId}`);
			await vi.waitFor(() => expect(alice.snapshots).toBe(1));
			expect(h.presence.keyOf(alice.socket.id!)).toBe(aliceId);
			// Her second tab is the same person: one key online, two connections of it.
			const again = await joinRoom(h.port, edgeHeaders('alice'), `${APP_ID}-${h.roomId}`);
			await vi.waitFor(() => expect(again.snapshots).toBe(1));
			expect(h.presence.keyOf(again.socket.id!)).toBe(aliceId);
			alice.socket.disconnect();
			await vi.waitFor(() => expect(h.presence.keyOf(alice.socket.id ?? '')).toBeUndefined());
			expect(h.presence.isOnline(aliceId)).toBe(true);
		} finally {
			await h.close();
		}
	});

	it('a non-member at the floor is refused a locked room: no snapshot, no history, and their line reaches nobody', async () => {
		const h = await boot();
		try {
			const key = `${APP_ID}-${h.lockedRoomId}`;
			const alice = await joinRoom(h.port, edgeHeaders('owner'), key);
			await vi.waitFor(() => expect(alice.historyEvents).toBe(1));
			const bob = await joinRoom(h.port, edgeHeaders('bob'), key);
			await vi.waitFor(() => expect(bob.errors[0]?.code).toBe('auth/forbidden'));
			bob.socket.emit('chat_send', { text: 'bob should never be heard' });
			await vi.waitFor(() => expect(bob.errors.length).toBeGreaterThan(1));
			expect([bob.snapshots, bob.historyEvents, alice.broadcasts]).toEqual([0, 0, []]);
			expect(h.events.find((e) => e.event === 'room.refused')?.fields).toMatchObject({ room_key: key, gate: 'not-member' });
			expect((await h.served.chat.store.recentMessages(h.lockedRoomId)).some((m) => m.text === 'bob should never be heard')).toBe(false);
		} finally {
			await h.close();
		}
	});

	it('a below-floor tier never reaches connection at all — refused at the handshake, even as a member; a key for a room nobody has connects fine and is refused only at join', async () => {
		const h = await boot();
		try {
			h.lobby.join(h.roomId, { id: participantIdFor('anon'), name: 'anon', userId: null });
			const anon = await connectAttempt(h.port, edgeHeaders('anon', 'public'));
			expect(anon.outcome).toBe('refused');
			const lost = await joinRoom(h.port, edgeHeaders('alice'), `${APP_ID}-r-doesnotexist00`);
			await vi.waitFor(() => expect(lost.errors[0]?.code).toBe('auth/forbidden'));
			expect(lost.snapshots).toBe(0);
			// The handshake gate logs its own refusal (no room_key: it refuses before any `join` is read).
			expect(h.events.find((e) => e.event === 'room.refused' && e.fields.gate === 'tier')).toBeTruthy();
			// `admit`'s own refusal still says which key and which gate.
			const refused = h.events.filter((e) => e.event === 'room.refused' && e.fields.room_key !== undefined).map((e) => [e.fields.room_key, e.fields.gate]);
			expect(refused).toEqual([[`${APP_ID}-r-doesnotexist00`, 'no-place']]);
		} finally {
			await h.close();
		}
	});

	it('a headerless connect — no edge headers at all — is refused at the handshake the same way a forged below-floor tier is (bm1-BS)', async () => {
		const h = await boot();
		try {
			const headerless = await connectAttempt(h.port, {});
			expect(headerless.outcome).toBe('refused');
		} finally {
			await h.close();
		}
	});

	it('an open room’s chat and a match no room holds admit anyone at the floor, since anyone may watch the match; a locked room admits nobody outside it', async () => {
		const h = await boot();
		try {
			const passerby = await joinRoom(h.port, edgeHeaders('gale'), `${APP_ID}-${h.roomId}`);
			const crowd = await joinRoom(h.port, edgeHeaders('frank'), `${APP_ID}-${LIVE_MATCH}`);
			const knocker = await joinRoom(h.port, edgeHeaders('hal'), `${APP_ID}-${h.lockedRoomId}`);
			await vi.waitFor(() => expect([passerby.snapshots, crowd.snapshots]).toEqual([1, 1]));
			await vi.waitFor(() => expect(knocker.errors[0]?.code).toBe('auth/forbidden'));
			expect(knocker.snapshots).toBe(0);
		} finally {
			await h.close();
		}
	});

	it('the account names the member, and a rename reaches the lobby and the other player’s roster with nobody rejoining', async () => {
		const h = await boot();
		try {
			const aliceId = participantIdFor('alice');
			h.lobby.join(h.roomId, { id: aliceId, name: 'header-alice', userId: 'user-alice' });
			h.lobby.join(h.roomId, { id: participantIdFor('carol'), name: 'carol', userId: 'user-carol' });
			h.names.set('user-alice', 'Ari');
			const key = `${APP_ID}-${h.roomId}`;
			const alice = await joinRoom(h.port, edgeHeaders('alice'), key);
			const carol = await joinRoom(h.port, edgeHeaders('carol'), key);
			const nameOfAlice = (): string | undefined => h.lobby.get(h.roomId)?.members.find((m) => m.id === aliceId)?.name;
			await vi.waitFor(() => expect(nameOfAlice()).toBe('Ari'));

			// Renamed in the fleet: the gear fires `hadoku:name`, and the chrome says so.
			h.names.set('user-alice', 'Ariadne');
			alice.socket.emit('identity_update', { name: 'Ariadne' });
			await vi.waitFor(() => expect(nameOfAlice()).toBe('Ariadne'));
			await vi.waitFor(() => expect(lastRoster(carol).map((u) => u.name)).toContain('Ariadne'));
		} finally {
			await h.close();
		}
	});
});
