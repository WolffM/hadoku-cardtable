/**
 * The room feed over a real socket.io server, real `socket.io-client`
 * connections and a real lobby: who hears a room change, how often, and what a
 * watch does to the front page's idea of who is there.
 *
 * The handshake gate is not installed here — `room/socket.test.ts` proves it for
 * the namespace this shares — so identity is read off the bare headers, which
 * is what `identityFromHeaders` does after the gate has sanitized them.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { ROOM_FEED_CHANNEL, type RoomChanged } from '@hadoku/shared';

import { attachRoomFeed } from './feed.ts';
import { deriveParticipantId } from './identity.ts';
import { openLobby, ROOM_STALE_MS, type Lobby } from './lobby.ts';

interface Person {
	key: string;
	id: string;
	name: string;
}

const person = (name: string): Person => {
	const key = `friend-key-${name}`;
	return { key, name, id: deriveParticipantId({ friendKey: key, deviceId: `user-${name}`, socketId: 'unused' }) };
};
const ALICE = person('alice');
const BOB = person('bob');
const CAROL = person('carol');

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(opts: { now?: () => number; touchEveryMs?: number } = {}): Promise<{ lobby: Lobby; port: number; lines: Record<string, unknown>[] }> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-feed-test-'));
	const lobby = await openLobby({ dir, ...(opts.now === undefined ? {} : { now: opts.now }) });
	const http = createServer();
	const io = new SocketIOServer(http, { serveClient: false });
	const lines: Record<string, unknown>[] = [];
	const feed = attachRoomFeed(io, {
		lobby,
		log: (line) => {
			lines.push(line);
		},
		...(opts.touchEveryMs === undefined ? {} : { touchEveryMs: opts.touchEveryMs }),
	});
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	cleanups.push(async () => {
		feed.close();
		io.close();
		await rm(dir, { recursive: true, force: true });
	});
	return { lobby, port: (http.address() as AddressInfo).port, lines };
}

interface Peer {
	socket: ClientSocket;
	heard: RoomChanged[];
}

async function connect(port: number, who: Person): Promise<Peer> {
	const socket = ioClient(`http://127.0.0.1:${port}`, {
		transports: ['websocket'],
		forceNew: true,
		extraHeaders: { 'x-user-key': who.key, 'x-user-id': `user-${who.name}` },
	});
	const heard: RoomChanged[] = [];
	socket.on(ROOM_FEED_CHANNEL.changed, (m: RoomChanged) => heard.push(m));
	await new Promise<void>((done) => socket.once('connect', () => done()));
	cleanups.push(() => {
		socket.close();
	});
	return { socket, heard };
}

/** Send a watch; resolves on the server's ack, which says it is in force. */
async function watch(peer: Peer, rooms: string[], list = false): Promise<void> {
	await peer.socket.timeout(2_000).emitWithAck(ROOM_FEED_CHANNEL.watch, { rooms, list });
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

function room(lobby: Lobby, owner: Person): string {
	const made = lobby.create({ id: owner.id, name: owner.name }, { name: 'tonight', gameType: 'constructed-1v1', clientMode: 'builtin' });
	if (!made.ok) throw new Error(made.reason);
	return made.room.id;
}

describe('the room feed', () => {
	it("tells a room's members that it changed, once per change, and nobody else", async () => {
		const { lobby, port } = await boot();
		const id = room(lobby, ALICE);
		const other = room(lobby, CAROL);
		expect(lobby.join(id, { id: BOB.id, name: BOB.name }).ok).toBe(true);
		const alice = await connect(port, ALICE);
		const bob = await connect(port, BOB);
		const carol = await connect(port, CAROL);
		await watch(alice, [id]);
		await watch(bob, [id, other]);
		await watch(carol, [id]);

		lobby.setReady(id, BOB.id, true);
		await settle();
		expect(alice.heard).toEqual([{ room: id }]);
		expect(bob.heard).toEqual([{ room: id }]);
		expect(carol.heard, 'not a member: hears nothing about the room').toEqual([]);

		lobby.setReady(other, CAROL.id, true);
		await settle();
		expect(bob.heard, 'watching a room you are not in tells you nothing').toEqual([{ room: id }]);
	});

	it('a match start writes the room three times and is said once', async () => {
		const { lobby, port } = await boot();
		const id = room(lobby, ALICE);
		const alice = await connect(port, ALICE);
		await watch(alice, [id]);
		lobby.setTableMatch(id, lobby.get(id)!.tables[0]!.id, 'm-000000000001');
		lobby.setPlayerState(id, ALICE.id, { ready: false });
		lobby.setReady(id, ALICE.id, false);
		await settle();
		expect(alice.heard).toEqual([{ room: id }]);
	});

	it('a watch made before the join is heard once the join makes it a member', async () => {
		const { lobby, port } = await boot();
		const id = room(lobby, ALICE);
		const bob = await connect(port, BOB);
		await watch(bob, [id]);
		lobby.setReady(id, ALICE.id, true);
		await settle();
		expect(bob.heard).toEqual([]);
		lobby.join(id, { id: BOB.id, name: BOB.name });
		await settle();
		expect(bob.heard).toEqual([{ room: id }]);
	});

	it('the list hears every room come, change and go; a new watch replaces the old one', async () => {
		let clock = 5_000_000_000_000;
		const { lobby, port } = await boot({ now: () => clock });
		const carol = await connect(port, CAROL);
		await watch(carol, [], true);
		const id = room(lobby, ALICE);
		await settle();
		expect(carol.heard).toEqual([{ list: true }]);
		clock += 13 * 60 * 60_000;
		lobby.sweep();
		await settle();
		expect(carol.heard).toEqual([{ list: true }, { list: true }]);

		await watch(carol, [], false);
		room(lobby, BOB);
		await settle();
		expect(carol.heard, 'stopped following the list').toHaveLength(2);
		expect(lobby.get(id)).toBeUndefined();
	});

	it('refuses a malformed watch in a log line, and keeps the last good one', async () => {
		const { lobby, port, lines } = await boot();
		const id = room(lobby, ALICE);
		const alice = await connect(port, ALICE);
		await watch(alice, [id]);
		alice.socket.emit(ROOM_FEED_CHANNEL.watch, { rooms: ['Not A Room!'], list: false });
		await settle();
		expect(lines.map((l) => l.evt)).toEqual(['watch-malformed']);
		lobby.setReady(id, ALICE.id, true);
		await settle();
		expect(alice.heard).toEqual([{ room: id }]);
	});

	it('a watch keeps an open room offered on the front page, even with nothing read', async () => {
		let clock = 6_000_000_000_000;
		const { lobby, port } = await boot({ now: () => clock, touchEveryMs: 50 });
		const id = room(lobby, ALICE);
		const alice = await connect(port, ALICE);
		await watch(alice, [id]);
		clock += ROOM_STALE_MS + 60_000;
		await settle();
		expect(lobby.offered().map((r) => r.id), 'touched by the watch').toEqual([id]);

		alice.socket.close();
		await settle();
		clock += ROOM_STALE_MS + 60_000;
		await settle();
		expect(lobby.offered(), 'nobody has it open any more').toEqual([]);
	});
});
