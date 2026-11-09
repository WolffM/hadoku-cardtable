/**
 * `attachRoomChat`'s `admit` gate, end to end: a real socket.io server, real
 * `socket.io-client` connections to the `/chat` namespace, and a real lobby
 * (`openLobby`) over a temp directory — the harness shape `socket.test.ts`
 * already uses for its own handshakes. "A non-member reads nothing" is a
 * safety control, so it is proved against a server that actually ran the
 * check, never a mock that agrees with the test's idea of the rules.
 *
 * `roomIdFromChatKey` (the inverse of `RoomShell.tsx`'s `roomKeyFor`) is
 * covered separately, by name, above.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

import { roomIdFromChatKey } from './chat.js';
import type { Lobby } from './lobby.js';

const EDGE_SECRET = 'test-edge-auth-secret';

/*
 * `config.ts` (through `kernel.ts`, through `edge-auth.ts`/`gate.ts`) reads
 * `EDGE_AUTH_SECRET` once, at module load — the same reason `socket.test.ts`
 * dynamically imports everything under test AFTER the env is set, rather
 * than at the top of the file.
 */
let chatMod: typeof import('./chat.ts');
let lobbyMod: typeof import('./lobby.ts');
let gateMod: typeof import('../gate.ts');
let identityMod: typeof import('./identity.ts');

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	chatMod = await import('./chat.ts');
	lobbyMod = await import('./lobby.ts');
	gateMod = await import('../gate.ts');
	identityMod = await import('./identity.ts');
});

/** Headers the edge would stamp for a vouched account, at `tier` (default friend). */
function edgeHeaders(userKey: string, tier = 'friend'): Record<string, string> {
	return {
		'x-edge-auth': EDGE_SECRET,
		'x-hadoku-tier': tier,
		'x-user-id': `user-${userKey}`,
		'x-user-key': `friend-key-${userKey}`,
	};
}

/** The durable id a socket connecting with `edgeHeaders(userKey)` mints. */
function participantIdFor(userKey: string): string {
	return identityMod.identityFromHeaders(edgeHeaders(userKey) as unknown as Parameters<typeof identityMod.identityFromHeaders>[0], 'unused');
}

/* ── Harness ─────────────────────────────────────────────────────────── */

interface Harness {
	port: number;
	lobby: Lobby;
	/** The one room this boot's fixture lobby holds. */
	roomId: string;
	served: Awaited<ReturnType<typeof chatMod.attachRoomChat>>;
	close: () => Promise<void>;
}

const dirs: string[] = [];
const openPeers: ClientSocket[] = [];

/** A real server, with `gateSocketIo`'s engine-wide provenance sanitization installed exactly as
 *  `plugins/play.ts` installs it in production (via the draft socket) before `attachRoomChat` ever
 *  sees a handshake — and a real lobby with ONE room, owned by a caller nobody else's test reuses. */
async function boot(): Promise<Harness> {
	const lobbyDir = await mkdtemp(join(tmpdir(), 'cardtable-chat-test-lobby-'));
	const chatDir = await mkdtemp(join(tmpdir(), 'cardtable-chat-test-chat-'));
	dirs.push(lobbyDir, chatDir);
	const lobby = await lobbyMod.openLobby({ dir: lobbyDir });
	const owner = { id: participantIdFor('owner'), name: 'owner', userId: null };
	const made = lobby.create(owner, { name: 'e2e chat room', gameType: 'constructed-1v1', clientMode: 'builtin' });
	if (!made.ok) throw new Error(`the lobby refused to create the room: ${made.reason}`);
	const roomId = made.room.id;

	const http = createServer();
	const io = new SocketIOServer(http, { serveClient: false });
	gateMod.gateSocketIo(io, { minTier: 'friend', surface: 'draft-socket' });
	const served = await chatMod.attachRoomChat(io, { lobby, minTier: 'friend', stateDir: () => chatDir });
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	const port = (http.address() as AddressInfo).port;
	return {
		port,
		lobby,
		roomId,
		served,
		close: async () => {
			io.close();
			await new Promise<void>((done) => http.close(() => done()));
		},
	};
}

interface ChatPeer {
	socket: ClientSocket;
	/** How many `chat_history` events arrived — not how many messages, since an
	 *  admitted join with no prior history still fires one with an EMPTY array. */
	historyEvents: number;
	broadcasts: Array<Record<string, unknown>>;
	errors: Array<{ code?: string; message?: string }>;
}

/** Connects to cardtable's own `/chat` namespace with `headers`. Resolves on the transport
 *  connecting — admitted or refused is a separate, later event (`join` has not been sent yet). */
function connectChat(port: number, headers: Record<string, string>): Promise<ChatPeer> {
	return new Promise((resolve, reject) => {
		const socket = ioClient(`http://127.0.0.1:${port}/chat`, {
			path: '/socket.io/',
			transports: ['polling'],
			extraHeaders: headers,
			forceNew: true,
			reconnection: false,
		});
		openPeers.push(socket);
		const peer: ChatPeer = { socket, historyEvents: 0, broadcasts: [], errors: [] };
		socket.on('chat_history', () => {
			peer.historyEvents += 1;
		});
		socket.on('chat_broadcast', (payload: Record<string, unknown>) => peer.broadcasts.push(payload));
		socket.on('error', (payload: { code?: string; message?: string }) => peer.errors.push(payload));
		socket.on('connect', () => resolve(peer));
		socket.on('connect_error', (err) => reject(err));
	});
}


afterEach(() => {
	for (const socket of openPeers.splice(0)) socket.disconnect();
});

afterAll(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/* ── roomIdFromChatKey (pure) ────────────────────────────────────────── */

describe('roomIdFromChatKey', () => {
	it('strips the app prefix for a cardtable key', () => {
		expect(roomIdFromChatKey('cardtable-abc123')).toBe('abc123');
	});

	it('is null for a key from a different app — never another app’s room', () => {
		expect(roomIdFromChatKey('watchparty-abc123')).toBeNull();
		expect(roomIdFromChatKey('bomberman-abc123')).toBeNull();
	});

	it('is null with no id after the prefix', () => {
		expect(roomIdFromChatKey('cardtable-')).toBeNull();
		expect(roomIdFromChatKey('cardtable')).toBeNull();
	});

	it('is null for an id ROOM_ID_RE would refuse — uppercase, punctuation, or over-long', () => {
		expect(roomIdFromChatKey('cardtable-Abc123')).toBeNull();
		expect(roomIdFromChatKey('cardtable-abc_123')).toBeNull();
		expect(roomIdFromChatKey(`cardtable-${'a'.repeat(41)}`)).toBeNull();
	});

	it('accepts the longest id ROOM_ID_RE allows', () => {
		const id = 'a'.repeat(40);
		expect(roomIdFromChatKey(`cardtable-${id}`)).toBe(id);
	});
});

/* ── The admit gate, against a real server ──────────────────────────── */

describe('attachRoomChat — admit, against a real socket.io server and a real lobby', () => {
	it('a member joins, sends, a second member receives it, and it lands in history', async () => {
		const h = await boot();
		try {
			const aliceId = participantIdFor('alice');
			const carolId = participantIdFor('carol');
			expect(h.lobby.join(h.roomId, { id: aliceId, name: 'alice', userId: null }).ok).toBe(true);
			expect(h.lobby.join(h.roomId, { id: carolId, name: 'carol', userId: null }).ok).toBe(true);
			const roomKey = `cardtable-${h.roomId}`;

			const alice = await connectChat(h.port, edgeHeaders('alice'));
			alice.socket.emit('join', { room_key: roomKey, name: 'alice' });
			await vi.waitFor(() => expect(alice.historyEvents).toBeGreaterThan(0));
			expect(alice.errors).toEqual([]);

			const carol = await connectChat(h.port, edgeHeaders('carol'));
			carol.socket.emit('join', { room_key: roomKey, name: 'carol' });
			await vi.waitFor(() => expect(carol.historyEvents).toBeGreaterThan(0));
			expect(carol.errors).toEqual([]);

			alice.socket.emit('chat_send', { text: 'hello from alice' });
			await vi.waitFor(() => expect(carol.broadcasts.some((b) => b.text === 'hello from alice')).toBe(true));

			const stored = await h.served.store.recentMessages(h.roomId);
			expect(stored.some((m) => m.text === 'hello from alice')).toBe(true);
		} finally {
			await h.close();
		}
	});

	it('a non-member at a valid tier is refused: no history, and its send never reaches the room or the store', async () => {
		const h = await boot();
		try {
			const aliceId = participantIdFor('alice');
			expect(h.lobby.join(h.roomId, { id: aliceId, name: 'alice', userId: null }).ok).toBe(true);
			const roomKey = `cardtable-${h.roomId}`;

			const alice = await connectChat(h.port, edgeHeaders('alice'));
			alice.socket.emit('join', { room_key: roomKey, name: 'alice' });
			await vi.waitFor(() => expect(alice.historyEvents).toBeGreaterThan(0));

			// bob is a real, otherwise-valid account at the floor's own tier — just never joined this room.
			const bob = await connectChat(h.port, edgeHeaders('bob'));
			bob.socket.emit('join', { room_key: roomKey, name: 'bob' });
			await vi.waitFor(() => expect(bob.errors.length).toBeGreaterThan(0));
			expect(bob.errors[0]?.code).toBe('auth/forbidden');
			expect(bob.historyEvents).toBe(0);

			bob.socket.emit('chat_send', { text: 'bob should never be heard' });
			// `chat_send` is refused independently of `join` (`serveRoomChat`'s own
			// `admitted.get(socket.id)` check) — a SECOND error, awaited rather than
			// a timed guess at "long enough for a broadcast to have arrived".
			await vi.waitFor(() => expect(bob.errors.length).toBeGreaterThan(1));
			expect(bob.errors[1]?.code).toBe('auth/forbidden');
			expect(alice.broadcasts).toEqual([]);
			const stored = await h.served.store.recentMessages(h.roomId);
			expect(stored.some((m) => m.text === 'bob should never be heard')).toBe(false);
		} finally {
			await h.close();
		}
	});

	it('a below-floor tier is refused even where membership would otherwise admit it', async () => {
		const h = await boot();
		try {
			const anonId = participantIdFor('anon');
			// A member of the room — proves the TIER check runs independently of
			// (and before) the membership one, not merely that a stranger is refused.
			expect(h.lobby.join(h.roomId, { id: anonId, name: 'anon', userId: null }).ok).toBe(true);
			const roomKey = `cardtable-${h.roomId}`;

			const anon = await connectChat(h.port, edgeHeaders('anon', 'public'));
			anon.socket.emit('join', { room_key: roomKey, name: 'anon' });
			await vi.waitFor(() => expect(anon.errors.length).toBeGreaterThan(0));
			expect(anon.errors[0]?.code).toBe('auth/forbidden');
			expect(anon.historyEvents).toBe(0);
		} finally {
			await h.close();
		}
	});

	it('a key for a room that does not exist is refused', async () => {
		const h = await boot();
		try {
			const alice = await connectChat(h.port, edgeHeaders('alice'));
			alice.socket.emit('join', { room_key: 'cardtable-r-doesnotexist00', name: 'alice' });
			await vi.waitFor(() => expect(alice.errors.length).toBeGreaterThan(0));
			expect(alice.errors[0]?.code).toBe('auth/forbidden');
			expect(alice.historyEvents).toBe(0);
		} finally {
			await h.close();
		}
	});
});
