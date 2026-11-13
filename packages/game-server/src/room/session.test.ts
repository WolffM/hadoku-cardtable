/**
 * One live tab per player per room, over a real socket.io server and real `socket.io-client`
 * connections: the claim a screen sends, the question it is answered with, a take retiring every
 * socket of the old tab, a stale holder replaced without asking, and the beat that keeps a holder live.
 *
 * Who plays where is a stub here (`players`): the rule for it is `playsIn`, tested below on its own,
 * and the draft and match sockets' use of `attach` are tested in their own suites.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer, type Socket as ServerSocket } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { SESSION_EVENTS, type SessionClaimAnswer } from '@wolffm/rooms-protocol';

import { deriveParticipantId } from './identity.ts';
import { attachSessions, playsIn, type SessionHandle } from './session.ts';
import { installTelemetry, type TelemetryContext } from '../telemetry.ts';

const idOf = (name: string): string => deriveParticipantId({ accountId: `user-${name}`, socketId: 'unused' });
const ROOM = 'r-0123456789ab';
const TAB_A = 'tab-aaaaaaaa';
const TAB_B = 'tab-bbbbbbbb';
const IDLE = 15_000;

interface Harness {
	port: number;
	io: SocketIOServer;
	handle: SessionHandle;
	players: Set<string>;
	lines: Record<string, unknown>[];
	clock: { now: number };
	reports: [string, TelemetryContext][];
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
	installTelemetry(() => {});
});

async function boot(beatMs = 60_000): Promise<Harness> {
	const http = createServer();
	const io = new SocketIOServer(http, { serveClient: false });
	const players = new Set([idOf('alice')]);
	const lines: Record<string, unknown>[] = [];
	const clock = { now: 1_000_000 };
	const reports: [string, TelemetryContext][] = [];
	installTelemetry((event, context) => reports.push([event, context]));
	const handle = attachSessions(io, {
		isPlayer: (room, participantId) => room === ROOM && players.has(participantId),
		log: (l) => lines.push(l),
		beatMs,
		idleMs: IDLE,
		now: () => clock.now,
	});
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	cleanups.push(async () => {
		handle.close();
		await io.close();
	});
	return { port: (http.address() as AddressInfo).port, io, handle, players, lines, clock, reports };
}

interface Tab {
	socket: ClientSocket;
	taken: unknown[];
	disconnects: string[];
	/** Beats the server sent this socket. */
	beats: number;
	claim(take?: boolean, tabId?: string): Promise<SessionClaimAnswer>;
}

async function open(h: Harness, name: string, tabId: string, answerBeats = true): Promise<Tab> {
	const socket = ioClient(`http://127.0.0.1:${h.port}`, {
		transports: ['websocket'],
		extraHeaders: { 'x-user-id': `user-${name}` },
		forceNew: true,
		reconnection: false,
	});
	cleanups.push(() => {
		socket.disconnect();
	});
	const tab: Tab = {
		socket,
		taken: [],
		disconnects: [],
		beats: 0,
		claim: (take = false, id = tabId) => socket.emitWithAck(SESSION_EVENTS.claim, take ? { room: ROOM, tabId: id, take } : { room: ROOM, tabId: id }) as Promise<SessionClaimAnswer>,
	};
	socket.on(SESSION_EVENTS.taken, (m: unknown) => tab.taken.push(m));
	socket.on('disconnect', (reason) => tab.disconnects.push(reason));
	socket.on(SESSION_EVENTS.beat, (ack: () => void) => {
		tab.beats += 1;
		if (answerBeats) ack();
	});
	await new Promise<void>((done, fail) => {
		socket.on('connect', () => done());
		socket.on('connect_error', fail);
	});
	return tab;
}

function serverSocket(h: Harness, client: ClientSocket): ServerSocket {
	const s = h.io.sockets.sockets.get(client.id ?? '');
	if (s === undefined) throw new Error('no server socket for that client');
	return s;
}

async function waitUntil(predicate: () => boolean, label: string, timeout = 5000): Promise<void> {
	await vi.waitFor(
		() => {
			if (!predicate()) throw new Error(`timed out waiting for ${label}`);
		},
		{ timeout, interval: 5 },
	);
}

describe('the claim a screen sends', () => {
	it('a player’s first tab is granted', async () => {
		const h = await boot();
		const a = await open(h, 'alice', TAB_A);
		expect(await a.claim()).toEqual({ room: ROOM, status: 'granted' });
	});

	it('a second tab of the same player is held, and the first is left alone', async () => {
		const h = await boot();
		const a = await open(h, 'alice', TAB_A);
		await a.claim();
		const b = await open(h, 'alice', TAB_B);
		expect(await b.claim()).toEqual({ room: ROOM, status: 'held' });
		// A round trip on the first tab's own socket: anything the server sent it before now has arrived.
		expect(await a.claim()).toEqual({ room: ROOM, status: 'granted' });
		expect(a.socket.connected).toBe(true);
		expect(a.taken).toEqual([]);
	});

	it('a watcher holds nothing: every tab of theirs plays on', async () => {
		const h = await boot();
		const one = await open(h, 'carol', TAB_A);
		const two = await open(h, 'carol', TAB_B);
		expect(await one.claim()).toEqual({ room: ROOM, status: 'watcher' });
		expect(await two.claim()).toEqual({ room: ROOM, status: 'watcher' });
	});

	it('a watcher who sits down holds the room from their next claim; standing up lets it go', async () => {
		const h = await boot();
		const one = await open(h, 'carol', TAB_A);
		const two = await open(h, 'carol', TAB_B);
		expect(await one.claim()).toEqual({ room: ROOM, status: 'watcher' });
		h.players.add(idOf('carol'));
		expect(await one.claim()).toEqual({ room: ROOM, status: 'granted' });
		expect(await two.claim()).toEqual({ room: ROOM, status: 'held' });
		h.players.delete(idOf('carol'));
		expect(await one.claim()).toEqual({ room: ROOM, status: 'watcher' });
		h.players.add(idOf('carol'));
		expect(await two.claim()).toEqual({ room: ROOM, status: 'granted' });
	});

	it('a request that does not parse is refused, and claims nothing', async () => {
		const h = await boot();
		const a = await open(h, 'alice', TAB_A);
		expect(await a.socket.emitWithAck(SESSION_EVENTS.claim, { room: ROOM, tabId: 'short' })).toEqual({ room: '', status: 'refused' });
		const b = await open(h, 'alice', TAB_B);
		expect(await b.claim()).toEqual({ room: ROOM, status: 'granted' });
	});

	it('the same tab reconnecting before its old socket closed is granted, not asked', async () => {
		const h = await boot();
		const before = await open(h, 'alice', TAB_A);
		await before.claim();
		const after = await open(h, 'alice', TAB_A);
		expect(await after.claim()).toEqual({ room: ROOM, status: 'granted' });
	});

	it('the holder’s tab closing frees the room: the next tab is granted', async () => {
		const h = await boot();
		const a = await open(h, 'alice', TAB_A);
		await a.claim();
		const id = a.socket.id ?? '';
		a.socket.disconnect();
		await waitUntil(() => !h.io.sockets.sockets.has(id), 'the close to reach the server');
		const b = await open(h, 'alice', TAB_B);
		expect(await b.claim()).toEqual({ room: ROOM, status: 'granted' });
	});
});

describe('a take', () => {
	it('retires every socket of the old tab in the room — told taken, closed by the server — and reports it live', async () => {
		const h = await boot();
		const a = await open(h, 'alice', TAB_A);
		await a.claim();
		// The old tab's match socket, joined to its claim the way `play/socket.ts` joins it.
		const match = await open(h, 'alice', TAB_A);
		expect(h.handle.attach(ROOM, idOf('alice'), TAB_A, serverSocket(h, match.socket))).toBe(true);

		const b = await open(h, 'alice', TAB_B);
		expect(await b.claim()).toEqual({ room: ROOM, status: 'held' });
		expect(await b.claim(true)).toEqual({ room: ROOM, status: 'granted' });
		await waitUntil(() => !a.socket.connected && !match.socket.connected, 'the old tab’s sockets to close');
		expect(a.taken).toEqual([{ room: ROOM }]);
		expect(match.taken).toEqual([{ room: ROOM }]);
		// A server-side close: socket.io does not reconnect it.
		expect(a.disconnects).toEqual(['io server disconnect']);
		expect(match.disconnects).toEqual(['io server disconnect']);
		expect(b.socket.connected).toBe(true);
		expect(h.reports).toEqual([['session-takeover', expect.objectContaining({ room: ROOM, holder: 'live', key: ROOM, userId: 'user-alice' })]]);
	});

	it('the old tab takes it back the same way, and the tab it took from is told', async () => {
		const h = await boot();
		const a = await open(h, 'alice', TAB_A);
		await a.claim();
		const b = await open(h, 'alice', TAB_B);
		await b.claim(true);
		await waitUntil(() => !a.socket.connected, 'the first take');
		const back = await open(h, 'alice', TAB_A);
		expect(await back.claim()).toEqual({ room: ROOM, status: 'held' });
		expect(await back.claim(true)).toEqual({ room: ROOM, status: 'granted' });
		await waitUntil(() => !b.socket.connected, 'the take back');
		expect(b.taken).toEqual([{ room: ROOM }]);
		expect(h.reports.map(([e, c]) => [e, c.holder])).toEqual([
			['session-takeover', 'live'],
			['session-takeover', 'live'],
		]);
	});

	it('a socket of a tab that does not hold the room is refused its player’s join', async () => {
		const h = await boot();
		const a = await open(h, 'alice', TAB_A);
		await a.claim();
		const intruder = await open(h, 'alice', TAB_B);
		expect(h.handle.attach(ROOM, idOf('alice'), TAB_B, serverSocket(h, intruder.socket))).toBe(false);
		expect(h.lines).toContainEqual(expect.objectContaining({ evt: 'session-elsewhere', room: ROOM }));
		expect(a.socket.connected).toBe(true);
		// A watcher's join is never refused.
		const carol = await open(h, 'carol', TAB_B);
		expect(h.handle.attach(ROOM, idOf('carol'), TAB_B, serverSocket(h, carol.socket))).toBe(true);
	});
});

describe('a stale holder', () => {
	it('is replaced without asking once silent past the window, and reported stale', async () => {
		const h = await boot();
		const a = await open(h, 'alice', TAB_A, false);
		await a.claim();
		h.clock.now += IDLE + 1;
		const b = await open(h, 'alice', TAB_B);
		expect(await b.claim()).toEqual({ room: ROOM, status: 'granted' });
		await waitUntil(() => !a.socket.connected, 'the stale socket to be closed');
		expect(h.reports).toEqual([['session-takeover', expect.objectContaining({ room: ROOM, holder: 'stale' })]]);
	});

	it('a holder that answers its beats stays live past the window', async () => {
		const h = await boot(20);
		const a = await open(h, 'alice', TAB_A);
		await a.claim();
		const beatsBefore = h.clock.now;
		h.clock.now += IDLE - 1;
		// A beat answered at the new time: two more arrive after it, so its ack has reached the server.
		const seen = a.beats;
		await waitUntil(() => a.beats >= seen + 3, 'beats at the new time');
		h.clock.now = beatsBefore + IDLE + 1;
		const b = await open(h, 'alice', TAB_B);
		expect(await b.claim()).toEqual({ room: ROOM, status: 'held' });
	});

	it('a holder that does not answer its beats goes stale', async () => {
		const h = await boot(20);
		const a = await open(h, 'alice', TAB_A, false);
		await a.claim();
		h.clock.now += IDLE - 1;
		const seen = a.beats;
		await waitUntil(() => a.beats >= seen + 3, 'beats it leaves unanswered');
		h.clock.now += 2;
		const b = await open(h, 'alice', TAB_B);
		expect(await b.claim()).toEqual({ room: ROOM, status: 'granted' });
	});
});

describe('playsIn', () => {
	const table = (...ids: string[]) => ({ players: ids.map((memberId) => ({ memberId })) });
	const pod = (o: { seats?: (string | null)[]; drafters?: string[]; dropped?: string[] }) => ({
		seats: (o.seats ?? []).map((m) => (m === null ? null : { memberId: m })),
		drafters: o.drafters ?? [],
		...(o.dropped === undefined ? {} : { dropped: o.dropped }),
	});

	it('a seat at a table', () => {
		expect(playsIn({ seats: [], tables: [table('a', 'b')], game: { pod: null } }, 'b')).toBe(true);
		expect(playsIn({ seats: [], tables: [table('a', 'b')], game: { pod: null } }, 'c')).toBe(false);
	});

	it('a game seat, whatever the game: a room with no pod of its own', () => {
		expect(playsIn({ seats: ['a', null], tables: [table()] }, 'a')).toBe(true);
		expect(playsIn({ seats: ['a', null], tables: [table()] }, 'b')).toBe(false);
	});

	it('a seat in the pod, or a place in its draft and rounds', () => {
		expect(playsIn({ seats: [], tables: [table()], game: { pod: pod({ seats: [null, 'a'] }) } }, 'a')).toBe(true);
		expect(playsIn({ seats: [], tables: [table()], game: { pod: pod({ drafters: ['a'] }) } }, 'a')).toBe(true);
		expect(playsIn({ seats: [], tables: [table()], game: { pod: pod({ drafters: ['a'], dropped: ['a'] }) } }, 'a')).toBe(false);
		expect(playsIn({ seats: [], tables: [table()], game: { pod: pod({ seats: [null], drafters: ['b'] }) } }, 'a')).toBe(false);
	});
});
