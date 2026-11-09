/**
 * `attachServedRoom`, end to end: a real socket.io server, real `socket.io-client` connections to
 * the `/room` namespace, a real lobby (`openLobby`) over a temp directory, the server's own tracker
 * (`createSeatPresence`) and the real account lookup (`createPeople`) over a stand-in prefs-api.
 * Who may join is a safety control, so it is proved against a server that ran the check.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

import type { Lobby } from './lobby.js';
import { placeOfKey } from './serve.js';

const EDGE_SECRET = 'test-edge-auth-secret';

/* `config.ts` reads `EDGE_AUTH_SECRET` once, at module load: everything under test is imported after it is set. */
let serveMod: typeof import('./serve.ts');
let lobbyMod: typeof import('./lobby.ts');
let gateMod: typeof import('../gate.ts');
let identityMod: typeof import('./identity.ts');
let socketMod: typeof import('./socket.ts');
let peopleMod: typeof import('../people.ts');

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	serveMod = await import('./serve.ts');
	lobbyMod = await import('./lobby.ts');
	gateMod = await import('../gate.ts');
	identityMod = await import('./identity.ts');
	socketMod = await import('./socket.ts');
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

interface Harness {
	port: number;
	lobby: Lobby;
	/** An open room, and a password-locked one, both owned by `owner`. */
	roomId: string;
	tableKey: string;
	lockedTableKey: string;
	presence: ReturnType<typeof import('./socket.ts').createSeatPresence>;
	/** What the stand-in prefs-api says each account is called, by userId; change it to rename someone. */
	names: Map<string, string>;
	served: Awaited<ReturnType<typeof import('./serve.ts').attachServedRoom>>;
	close: () => Promise<void>;
}

/** The one match this server's `isMatch` knows: a game no room holds. */
const LIVE_MATCH = 'm-0123456789ab';

const dirs: string[] = [];
const openPeers: ClientSocket[] = [];

async function boot(): Promise<Harness> {
	const lobbyDir = await mkdtemp(join(tmpdir(), 'cardtable-room-test-lobby-'));
	const chatDir = await mkdtemp(join(tmpdir(), 'cardtable-room-test-chat-'));
	dirs.push(lobbyDir, chatDir);
	const lobby = await lobbyMod.openLobby({ dir: lobbyDir });
	const owner = { id: participantIdFor('owner'), name: 'owner', userId: null };
	const made = lobby.create(owner, { name: 'served room', gameType: 'constructed-1v1', clientMode: 'builtin' });
	const locked = lobby.create(owner, { name: 'locked room', gameType: 'constructed-1v1', clientMode: 'builtin', password: 'pw' });
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
	const presence = socketMod.createSeatPresence({ seatReleaseMs: socketMod.SEAT_RELEASE_MS, draftGraceOf: () => 0 });

	const http = createServer();
	const io = new SocketIOServer(http, { serveClient: false });
	gateMod.gateSocketIo(io, { minTier: 'friend', surface: 'draft-socket' });
	const served = await serveMod.attachServedRoom(io, { lobby, presence, people, isMatch: (id) => id === LIVE_MATCH, minTier: 'friend', stateDir: () => chatDir });
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	return {
		port: (http.address() as AddressInfo).port,
		lobby,
		roomId: made.room.id,
		tableKey: `cardtable-${made.room.id}-${made.room.tables[0]!.id}`,
		lockedTableKey: `cardtable-${locked.room.id}-${locked.room.tables[0]!.id}`,
		presence,
		names,
		served,
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

const lastRoster = (peer: Peer): Array<Record<string, unknown>> => peer.presence.at(-1) ?? [];

afterEach(() => {
	for (const socket of openPeers.splice(0)) socket.disconnect();
});

afterAll(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/* ── placeOfKey ──────────────────────────────────────────────────────── */

describe('placeOfKey', () => {
	const lobby = {
		get: (id: string) => (id === 'r-abc' ? ({ id: 'r-abc', tables: [{ id: 't-1' }] } as unknown as ReturnType<Lobby['get']>) : undefined),
	};
	const place = (key: string) => placeOfKey(lobby, (id) => id === 'm-1', key);

	it('a room’s own key is that room', () => {
		expect(place('cardtable-r-abc')).toEqual({ served: 'r-abc', roomId: 'r-abc', kind: 'room' });
	});

	it('a table’s key is served as itself and belongs to its room', () => {
		expect(place('cardtable-r-abc-t-1')).toEqual({ served: 'r-abc-t-1', roomId: 'r-abc', kind: 'table' });
	});

	it('a match no room holds is served by its own id', () => {
		expect(place('cardtable-m-1')).toEqual({ served: 'm-1', roomId: null, kind: 'match' });
	});

	it('is null for another app’s key, a room or match nobody has, a table the room lacks, or an id ROOM_ID_RE refuses', () => {
		expect(place('watchparty-r-abc')).toBeNull();
		expect(place('cardtable-r-zzz')).toBeNull();
		expect(place('cardtable-m-2')).toBeNull();
		expect(place('cardtable-r-abc-t-9')).toBeNull();
		expect(place('cardtable-R-ABC')).toBeNull();
		expect(place('cardtable-')).toBeNull();
	});
});

/* ── Against a real server ───────────────────────────────────────────── */

describe('attachServedRoom', () => {
	it('two members join, see each other on the roster, chat, and the line is kept', async () => {
		const h = await boot();
		try {
			h.lobby.join(h.roomId, { id: participantIdFor('alice'), name: 'alice', userId: 'user-alice' });
			h.lobby.join(h.roomId, { id: participantIdFor('carol'), name: 'carol', userId: 'user-carol' });
			const key = `cardtable-${h.roomId}`;
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

	it('a room connection is its person’s connection on the ONE tracker it was handed', async () => {
		const h = await boot();
		try {
			const aliceId = participantIdFor('alice');
			h.lobby.join(h.roomId, { id: aliceId, name: 'alice', userId: 'user-alice' });
			const alice = await joinRoom(h.port, edgeHeaders('alice'), `cardtable-${h.roomId}`);
			await vi.waitFor(() => expect(alice.snapshots).toBe(1));
			expect(h.presence.keyOf(alice.socket.id!)).toBe(aliceId);
			// Her second tab is the same person: one key online, two connections of it.
			const again = await joinRoom(h.port, edgeHeaders('alice'), `cardtable-${h.roomId}`);
			await vi.waitFor(() => expect(again.snapshots).toBe(1));
			expect(h.presence.keyOf(again.socket.id!)).toBe(aliceId);
			alice.socket.disconnect();
			await vi.waitFor(() => expect(h.presence.keyOf(alice.socket.id ?? '')).toBeUndefined());
			expect(h.presence.isOnline(aliceId)).toBe(true);
		} finally {
			await h.close();
		}
	});

	it('a non-member at the floor is refused: no snapshot, no history, and their line reaches nobody', async () => {
		const h = await boot();
		try {
			h.lobby.join(h.roomId, { id: participantIdFor('alice'), name: 'alice', userId: null });
			const key = `cardtable-${h.roomId}`;
			const alice = await joinRoom(h.port, edgeHeaders('alice'), key);
			await vi.waitFor(() => expect(alice.historyEvents).toBe(1));
			const bob = await joinRoom(h.port, edgeHeaders('bob'), key);
			await vi.waitFor(() => expect(bob.errors[0]?.code).toBe('auth/forbidden'));
			bob.socket.emit('chat_send', { text: 'bob should never be heard' });
			await vi.waitFor(() => expect(bob.errors.length).toBeGreaterThan(1));
			expect([bob.snapshots, bob.historyEvents, alice.broadcasts]).toEqual([0, 0, []]);
			expect((await h.served.chat.store.recentMessages(h.roomId)).some((m) => m.text === 'bob should never be heard')).toBe(false);
		} finally {
			await h.close();
		}
	});

	it('a below-floor tier is refused even as a member, and so is a key for a room nobody has', async () => {
		const h = await boot();
		try {
			h.lobby.join(h.roomId, { id: participantIdFor('anon'), name: 'anon', userId: null });
			const anon = await joinRoom(h.port, edgeHeaders('anon', 'public'), `cardtable-${h.roomId}`);
			const lost = await joinRoom(h.port, edgeHeaders('alice'), 'cardtable-r-doesnotexist00');
			await vi.waitFor(() => expect([anon.errors[0]?.code, lost.errors[0]?.code]).toEqual(['auth/forbidden', 'auth/forbidden']));
			expect([anon.snapshots, lost.snapshots]).toEqual([0, 0]);
		} finally {
			await h.close();
		}
	});

	it('a table of an open room and a match no room holds admit anyone at the floor, since anyone may watch the match; a locked room’s table admits nobody outside it', async () => {
		const h = await boot();
		try {
			const watcher = await joinRoom(h.port, edgeHeaders('dana'), h.tableKey);
			const crowd = await joinRoom(h.port, edgeHeaders('frank'), `cardtable-${LIVE_MATCH}`);
			const outsider = await joinRoom(h.port, edgeHeaders('erin'), h.lockedTableKey);
			await vi.waitFor(() => expect([watcher.snapshots, crowd.snapshots]).toEqual([1, 1]));
			await vi.waitFor(() => expect(outsider.errors[0]?.code).toBe('auth/forbidden'));
			expect(outsider.snapshots).toBe(0);
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
			const key = `cardtable-${h.roomId}`;
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
