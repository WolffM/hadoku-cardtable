/**
 * The relay's socket path, end to end: a real express app and socket.io
 * server on an ephemeral loopback port, real `socket.io-client` peers with
 * edge headers — the same harness shape `play/socket.test.ts` uses for the
 * play socket, because this reuses that socket's own gate.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

import { identityFromHeaders } from '../room/identity.ts';
import { createRelayMatchRegistry } from './runtimes/relay-match.ts';

const EDGE_SECRET = 'test-edge-auth-secret';

let socketMod: typeof import('./relay-socket.ts');
let sessionMod: typeof import('./runtimes/relay.ts');

beforeAll(async () => {
	// config.ts reads the environment once, at load (see room/socket.test.ts).
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	socketMod = await import('./relay-socket.ts');
	sessionMod = await import('./runtimes/relay.ts');
});

function edgeHeaders(user: string, tier = 'friend'): Record<string, string> {
	return {
		'x-edge-auth': EDGE_SECRET,
		'x-hadoku-tier': tier,
		'x-user-id': `user-${user}`,
		'x-user-key': `friend-key-${user}`,
	};
}

function participantOf(user: string): string {
	return identityFromHeaders(edgeHeaders(user) as unknown as Record<string, string>, 'unused');
}

/* ── Harness ─────────────────────────────────────────────────────────── */

interface Harness {
	port: number;
	handle: import('./relay-socket.ts').RelayHandle;
	logs: Record<string, unknown>[];
	ended: { matchId: string; outcome: unknown }[];
	close: () => Promise<void>;
}

const openPeers: ClientSocket[] = [];
let harness: Harness | null = null;

afterEach(async () => {
	for (const p of openPeers.splice(0)) p.disconnect();
	if (harness !== null) await harness.close();
	harness = null;
});

interface Roster {
	seatCount: number;
	seats: Record<number, string>; // seat -> username
	watchers: string[];
	/** Spies for the lifecycle-owner hooks: optional, read fresh by `rosterOf` every call. */
	onSeatConnected?(seat: number): void;
	onSeatDisconnected?(seat: number): void;
}

function rosterOf(roster: Roster): import('./relay-socket.ts').RelayRoster {
	return {
		seatCount: roster.seatCount,
		roleOf: (participantId) => {
			for (const [seat, user] of Object.entries(roster.seats)) {
				if (participantOf(user) === participantId) return Number(seat);
			}
			if (roster.watchers.some((w) => participantOf(w) === participantId)) return null;
			return undefined;
		},
		// This file's own `matchOf` no longer builds the session itself, so a fixture roster —
		// this one plays the lifecycle owner's part — has to build it on `attach`, exactly as
		// `relay-socket.ts`'s own header now describes.
		attach: (sink, onEnded) => new sessionMod.RelaySession(roster.seatCount, sink, onEnded),
		seatConnected: roster.onSeatConnected,
		seatDisconnected: roster.onSeatDisconnected,
	};
}

async function boot(rosters: Record<string, Roster>, options: { joinRateLimit?: { capacity: number; refillAmount: number; refillIntervalMs: number } | null } = {}): Promise<Harness> {
	return bootWith((matchId) => {
		const r = rosters[matchId];
		return r === undefined ? undefined : rosterOf(r);
	}, options);
}

async function bootWith(
	rosterFor: (matchId: string) => import('./relay-socket.ts').RelayRoster | undefined,
	options: { joinRateLimit?: { capacity: number; refillAmount: number; refillIntervalMs: number } | null } = {},
): Promise<Harness> {
	const logs: Record<string, unknown>[] = [];
	const ended: { matchId: string; outcome: unknown }[] = [];
	const http: HttpServer = createServer();
	const io = new SocketIOServer(http, { serveClient: false });
	const handle = socketMod.attachRelay(io, {
		minTier: 'friend',
		rosterOf: rosterFor,
		onEnded: (matchId, outcome) => ended.push({ matchId, outcome }),
		log: (e) => logs.push(e),
		joinRateLimit: options.joinRateLimit,
	});
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	const port = (http.address() as AddressInfo).port;
	harness = {
		port,
		handle,
		logs,
		ended,
		close: async () => {
			handle.close();
			io.close();
			await new Promise<void>((done) => http.close(() => done()));
		},
	};
	return harness;
}

interface Peer {
	socket: ClientSocket;
	messages: unknown[];
	join: (matchId: string) => Promise<{ ok: boolean; seat?: number | null; error?: string }>;
	send: (msg: unknown) => void;
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
			messages: [],
			join: async (matchId) => (await socket.timeout(3000).emitWithAck('relay:join', { matchId })) as { ok: boolean; seat?: number | null; error?: string },
			send: (msg) => socket.emit('relay:message', msg),
		};
		socket.on('relay:message', (payload: unknown) => peer.messages.push(payload));
		socket.on('connect', () => done(peer));
		socket.on('connect_error', (err) => fail(err));
	});
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
	await vi.waitFor(
		() => {
			if (!predicate()) throw new Error(`waiting for ${label}`);
		},
		{ timeout: 2000, interval: 5 },
	);
}

/* ── Tests ───────────────────────────────────────────────────────────── */

describe('relay:join', () => {
	it('refuses a caller below the floor, the same as the play socket', async () => {
		const h = await boot({});
		await expect(connect(h.port, {})).rejects.toBeDefined();
	});

	it('refuses a matchId nothing is running', async () => {
		const h = await boot({});
		const peer = await connect(h.port, edgeHeaders('alice'));
		const ack = await peer.join('unknown-match');
		expect(ack).toEqual({ ok: false, error: 'unknown-match' });
	});

	it('refuses a participant the match does not recognise', async () => {
		const h = await boot({ m1: { seatCount: 2, seats: { 0: 'alice', 1: 'bob' }, watchers: [] } });
		const peer = await connect(h.port, edgeHeaders('carol'));
		const ack = await peer.join('m1');
		expect(ack).toEqual({ ok: false, error: 'not-joined' });
	});

	it('answers a seat with its own seat number, and a watcher with null', async () => {
		const h = await boot({ m1: { seatCount: 2, seats: { 0: 'alice', 1: 'bob' }, watchers: ['carol'] } });
		const aliceAck = await (await connect(h.port, edgeHeaders('alice'))).join('m1');
		expect(aliceAck).toEqual({ ok: true, seat: 0 });
		const carolAck = await (await connect(h.port, edgeHeaders('carol'))).join('m1');
		expect(carolAck).toEqual({ ok: true, seat: null });
	});
});

describe('relay:message', () => {
	async function seated(h: Harness): Promise<{ alice: Peer; bob: Peer; carol: Peer }> {
		const alice = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));
		const carol = await connect(h.port, edgeHeaders('carol'));
		await alice.join('m1');
		await bob.join('m1');
		await carol.join('m1');
		return { alice, bob, carol };
	}

	it("relays a seat's message to the other seat and to the watcher, never back to the sender", async () => {
		const h = await boot({ m1: { seatCount: 2, seats: { 0: 'alice', 1: 'bob' }, watchers: ['carol'] } });
		const { alice, bob, carol } = await seated(h);
		alice.send({ hi: 1 });
		await waitUntil(() => bob.messages.length === 1 && carol.messages.length === 1, 'bob and carol to hear alice');
		expect(bob.messages).toEqual([{ hi: 1 }]);
		expect(carol.messages).toEqual([{ hi: 1 }]);
		expect(alice.messages).toEqual([]);
	});

	it('keeps one sender in order: three quick messages arrive at the other seat in order, each exactly once', async () => {
		const h = await boot({ m1: { seatCount: 2, seats: { 0: 'alice', 1: 'bob' }, watchers: [] } });
		const alice = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));
		await alice.join('m1');
		await bob.join('m1');
		alice.send(1);
		alice.send(2);
		alice.send(3);
		await waitUntil(() => bob.messages.length === 3, 'bob to hear all three');
		expect(bob.messages).toEqual([1, 2, 3]);
	});

	it("a watcher's send is refused: nothing is relayed, and the match keeps running", async () => {
		const h = await boot({ m1: { seatCount: 2, seats: { 0: 'alice', 1: 'bob' }, watchers: ['carol'] } });
		const { alice, bob, carol } = await seated(h);
		carol.send({ sneaky: true });
		await waitUntil(() => h.logs.some((l) => l.evt === 'relay-send-refused'), 'the refusal to be logged');
		expect(alice.messages).toEqual([]);
		expect(bob.messages).toEqual([]);
	});

	it("a seat's rejoin resumes delivery: a new connection for the same seat keeps receiving", async () => {
		const h = await boot({ m1: { seatCount: 2, seats: { 0: 'alice', 1: 'bob' }, watchers: [] } });
		const alice = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));
		await alice.join('m1');
		await bob.join('m1');
		bob.socket.disconnect();
		await waitUntil(() => h.logs.some((l) => l.evt === 'relay-disconnected' && l.seat === 1), 'the old connection to be cleared');
		const bobAgain = await connect(h.port, edgeHeaders('bob'));
		await bobAgain.join('m1');
		alice.send('after rejoin');
		await waitUntil(() => bobAgain.messages.length === 1, 'the rejoined bob to hear it');
		expect(bobAgain.messages).toEqual(['after rejoin']);
	});

	it("the match's end is recorded: the leader's own { t: 'over', winners } ends it for everyone", async () => {
		const h = await boot({ m1: { seatCount: 2, seats: { 0: 'alice', 1: 'bob' }, watchers: [] } });
		const alice = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));
		await alice.join('m1');
		await bob.join('m1');
		alice.send({ t: 'over', winners: [0] });
		await waitUntil(() => h.ended.length === 1, 'the end to be recorded');
		expect(h.ended[0]).toEqual({ matchId: 'm1', outcome: { winners: [0] } });
		expect(h.handle.sessionOf('m1')).toBeUndefined();
	});

	it("the end reaches every screen as relay:ended — the sender of over and the watcher too — so the room can show it", async () => {
		const h = await boot({ m1: { seatCount: 2, seats: { 0: 'alice', 1: 'bob' }, watchers: ['carol'] } });
		const { alice, bob, carol } = await seated(h);
		const heard = (p: Peer): unknown[] => {
			const got: unknown[] = [];
			p.socket.on('relay:ended', (w: unknown) => got.push(w));
			return got;
		};
		const [a, b, c] = [heard(alice), heard(bob), heard(carol)];
		alice.send({ t: 'over', winners: [1] });
		await waitUntil(() => a.length === 1 && b.length === 1 && c.length === 1, 'every screen to hear the end');
		expect([a, b, c]).toEqual([[{ winners: [1] }], [{ winners: [1] }], [{ winners: [1] }]]);
		expect(h.logs).toContainEqual({ evt: 'relay-ended', matchId: 'm1', winners: [1] });
	});

	it("a rematch in the same room: every screen joins the room's next match with the same relay:join, its messages are delivered and its over recorded", async () => {
		const reg = createRelayMatchRegistry();
		const roomSeats = [participantOf('alice'), participantOf('bob')];
		reg.register('m1', 2, { log: () => {}, roomSeatOf: (p) => (roomSeats.includes(p) ? roomSeats.indexOf(p) : null) });
		const h = await bootWith((matchId) => reg.get(matchId));
		const alice = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));
		const carol = await connect(h.port, edgeHeaders('carol'));
		for (const p of [alice, bob, carol]) await p.join('m1');
		alice.send({ t: 'over', winners: [0] });
		await waitUntil(() => h.ended.length === 1, 'the first match to end');

		// Until it rejoins, a screen speaks for nothing, even once the room's next match is live:
		// bob's send goes nowhere after alice is already in the second match.
		expect(await alice.join('m1')).toEqual({ ok: true, seat: 0, ended: { winners: [0] } });
		bob.send('into the void');
		expect(await bob.join('m1')).toEqual({ ok: true, seat: 1, ended: { winners: [0] } });
		alice.send('second match');
		bob.send('bob in the second match');
		await waitUntil(() => bob.messages.includes('second match'), 'bob to hear the second match');
		await waitUntil(() => alice.messages.includes('bob in the second match'), 'alice to hear bob in the second match');
		expect(alice.messages).not.toContain('into the void');
		// Carol has not rejoined: the second match's message does not reach her.
		expect(carol.messages).not.toContain('second match');

		bob.send({ t: 'over', winners: [1] });
		await waitUntil(() => h.ended.length === 2, 'the second match to end');
		expect(h.ended[1]).toEqual({ matchId: 'm1', outcome: { winners: [1] } });
	});

	it("the result on reload: a screen that joins after the end is answered with it, until the room's next match is under way", async () => {
		const reg = createRelayMatchRegistry();
		const roomSeats = [participantOf('alice'), participantOf('bob')];
		reg.register('m1', 2, { log: () => {}, roomSeatOf: (p) => (roomSeats.includes(p) ? roomSeats.indexOf(p) : null) });
		const h = await bootWith((matchId) => reg.get(matchId));
		const alice = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));
		// A room's first match has no result to tell.
		expect(await alice.join('m1')).toEqual({ ok: true, seat: 0 });
		await bob.join('m1');
		alice.send({ t: 'over', winners: [1] });
		await waitUntil(() => h.ended.length === 1, 'the match to end');

		const carol = await connect(h.port, edgeHeaders('carol'));
		expect(await carol.join('m1')).toEqual({ ok: true, seat: null, ended: { winners: [1] } });

		// The next match is under way from its first message: a later screen is told nothing.
		await alice.join('m1');
		await bob.join('m1');
		alice.send({ t: 'start' });
		await waitUntil(() => bob.messages.length === 1, 'bob to hear the start');
		const dave = await connect(h.port, edgeHeaders('dave'));
		expect(await dave.join('m1')).toEqual({ ok: true, seat: null });
	});

	it('answers 429 once a caller has spent their joins, and only for that caller', async () => {
		const h = await boot(
			{ m1: { seatCount: 2, seats: { 0: 'alice', 1: 'bob' }, watchers: [] } },
			{ joinRateLimit: { capacity: 1, refillAmount: 1, refillIntervalMs: 60_000 } },
		);
		const alice = await connect(h.port, edgeHeaders('alice'));
		expect(await alice.join('m1')).toEqual({ ok: true, seat: 0 });
		expect(await alice.join('m1')).toEqual({ ok: false, error: 'rate-limited' });
		const bob = await connect(h.port, edgeHeaders('bob'));
		expect(await bob.join('m1')).toEqual({ ok: true, seat: 1 });
	});
});

describe('roster lifecycle hooks', () => {
	it("tells the roster a seat connected on its first join, and disconnected only once its LAST socket is gone", async () => {
		const connected: number[] = [];
		const disconnected: number[] = [];
		const h = await boot({
			m1: { seatCount: 2, seats: { 0: 'alice', 1: 'bob' }, watchers: [], onSeatConnected: (s) => connected.push(s), onSeatDisconnected: (s) => disconnected.push(s) },
		});
		const alice1 = await connect(h.port, edgeHeaders('alice'));
		await alice1.join('m1');
		expect(connected).toEqual([0]);
		// A second tab on the SAME seat: connected again (harmless — `MatchShell.seatConnected`
		// is idempotent), but disconnecting it must NOT yet say the seat left.
		const alice2 = await connect(h.port, edgeHeaders('alice'));
		await alice2.join('m1');
		expect(connected).toEqual([0, 0]);
		alice1.socket.disconnect();
		await waitUntil(() => h.logs.some((l) => l.evt === 'relay-disconnected' && l.seat === 0), 'the first tab to be cleared');
		expect(disconnected).toEqual([]);
		alice2.socket.disconnect();
		await waitUntil(() => disconnected.length === 1, "the seat's last socket to be told gone");
		expect(disconnected).toEqual([0]);
	});

	it("never tells the roster a watcher connected or disconnected", async () => {
		const connected: number[] = [];
		const disconnected: number[] = [];
		const h = await boot({
			m1: { seatCount: 2, seats: { 0: 'alice', 1: 'bob' }, watchers: ['carol'], onSeatConnected: (s) => connected.push(s), onSeatDisconnected: (s) => disconnected.push(s) },
		});
		const carol = await connect(h.port, edgeHeaders('carol'));
		await carol.join('m1');
		carol.socket.disconnect();
		await waitUntil(() => h.logs.some((l) => l.evt === 'relay-disconnected' && l.seat === null), "carol's disconnect to be logged");
		expect(connected).toEqual([]);
		expect(disconnected).toEqual([]);
	});
});

describe('RelaySession wiring', () => {
	it('close() ends every live match as every seat left', async () => {
		const h = await boot({ m1: { seatCount: 2, seats: { 0: 'alice', 1: 'bob' }, watchers: [] } });
		const alice = await connect(h.port, edgeHeaders('alice'));
		await alice.join('m1');
		const session = h.handle.sessionOf('m1');
		expect(session).toBeInstanceOf(sessionMod.RelaySession);
		h.handle.close();
		expect(session?.isEnded).toBe(true);
		expect(session?.result).toBeNull();
	});
});
