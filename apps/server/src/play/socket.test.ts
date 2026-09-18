/**
 * The play socket and route, end to end: a real express app and socket.io
 * server on an ephemeral loopback port, real `socket.io-client` peers with
 * edge headers, and a match whose Forge is the recorded REAL transcript
 * (`fixtures/bridge-two-seats.ndjson`) replayed through `ReplayHost`.
 *
 * The leak assertion is over bytes: everything each peer received — every
 * ack and every `forge:s2c` payload, `JSON.stringify`-ed exactly as it came
 * off the socket — is searched for every identifying string of the other
 * seat's hidden cards.
 */

import express from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

import type { BridgeLine } from './host.js';
import { leaked, loadTranscript, rawStatesOf, replayFactory, secretsFor, type ReplayHost } from './fixtures/transcript.js';
import { foldFrames, type StateFrame } from './visibility.js';

const EDGE_SECRET = 'test-edge-auth-secret';

let socketMod: typeof import('./socket.ts');
let edgeMod: typeof import('../edge-auth.ts');
let transportMod: typeof import('./transport.ts');

beforeAll(async () => {
	// config.ts reads the environment once, at load — see room/socket.test.ts.
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	socketMod = await import('./socket.ts');
	edgeMod = await import('../edge-auth.ts');
	transportMod = await import('./transport.ts');
});

const TRANSCRIPT = loadTranscript();
const PROBE_AT = TRANSCRIPT.findIndex((l) => l.t === 'frame' && (l.frame as { kind: string }).kind === 'ask');
const OPENING = TRANSCRIPT.slice(0, PROBE_AT);
const PROBE_ASK = TRANSCRIPT[PROBE_AT] as Extract<BridgeLine, { t: 'frame' }>;
const AFTER_PROBE = TRANSCRIPT.slice(PROBE_AT + 1);

/* ── Harness ─────────────────────────────────────────────────────────── */

interface Harness {
	port: number;
	hosts: ReplayHost[];
	handle: import('./socket.ts').PlayHandle;
	logs: Record<string, unknown>[];
	close: () => Promise<void>;
}

const openPeers: ClientSocket[] = [];
let harness: Harness | null = null;

afterEach(async () => {
	for (const p of openPeers.splice(0)) p.disconnect();
	if (harness !== null) await harness.close();
	harness = null;
});

async function boot(options: { devIdentity?: boolean; disconnectGraceMs?: number } = {}): Promise<Harness> {
	const { factory, hosts } = replayFactory();
	const logs: Record<string, unknown>[] = [];
	const app = express();
	// The same order index.ts uses: provenance, the floor, then /api.
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	app.use('/api', api);
	const http: HttpServer = createServer(app);
	const io = new SocketIOServer(http, { serveClient: false });
	const handle = socketMod.attachPlay(io, api, {
		minTier: 'friend',
		host: factory,
		log: (e) => logs.push(e),
		startTimeoutMs: 5000,
		joinWaitMs: 1000,
		devIdentity: options.devIdentity,
		disconnectGraceMs: options.disconnectGraceMs,
	});
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	const port = (http.address() as AddressInfo).port;
	harness = {
		port,
		hosts,
		handle,
		logs,
		close: async () => {
			handle.close();
			io.close();
			await new Promise<void>((done) => http.close(() => done()));
		},
	};
	return harness;
}

function edgeHeaders(user: string, tier = 'friend'): Record<string, string> {
	return {
		'x-edge-auth': EDGE_SECRET,
		'x-hadoku-tier': tier,
		'x-user-id': `user-${user}`,
		'x-user-key': `friend-key-${user}`,
	};
}

interface Peer {
	socket: ClientSocket;
	/** Every `forge:s2c` payload, as received. */
	frames: unknown[];
	/** Every ack, as received. */
	acks: unknown[];
	request(event: 'forge:join' | 'forge:resync', payload: unknown): Promise<unknown>;
	send(payload: unknown): void;
	/** Everything this peer was sent, serialised. */
	transcript(): string;
}

function connect(port: number, headers: Record<string, string>, auth?: Record<string, string>): Promise<Peer> {
	return new Promise((done, fail) => {
		const socket = ioClient(`http://127.0.0.1:${port}`, {
			transports: ['polling'],
			extraHeaders: headers,
			forceNew: true,
			reconnection: false,
			auth,
		});
		openPeers.push(socket);
		const peer: Peer = {
			socket,
			frames: [],
			acks: [],
			request: async (event, payload) => {
				const ack: unknown = await socket.timeout(3000).emitWithAck(event, payload);
				peer.acks.push(ack);
				return ack;
			},
			send: (payload) => socket.emit('forge:c2s', payload),
			transcript: () => [...peer.acks, ...peer.frames].map((x) => JSON.stringify(x)).join('\n'),
		};
		socket.on('forge:s2c', (payload: unknown) => peer.frames.push(payload));
		socket.on('connect', () => done(peer));
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

/** POST a match and feed the recorded opening to its host, so the route can answer. */
async function startMatch(h: Harness, user = 'alice'): Promise<{ status: number; body: Record<string, unknown> }> {
	const hostsBefore = h.hosts.length;
	const response = fetch(`http://127.0.0.1:${h.port}/api/play/matches`, {
		method: 'POST',
		headers: { ...edgeHeaders(user), 'content-type': 'application/json' },
		body: JSON.stringify({ opponent: 'human' }),
	});
	await waitUntil(() => h.hosts.length > hostsBefore, 'the match host to be created');
	(h.hosts.at(-1) as ReplayHost).push(...OPENING);
	const res = await response;
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/* ── Tests ───────────────────────────────────────────────────────────── */

describe('POST /api/play/matches', () => {
	it('starts a match and answers once Forge has opened it for both seats', async () => {
		const h = await boot();
		const { status, body } = await startMatch(h);
		expect(status).toBe(201);
		expect(typeof body.matchId).toBe('string');
		const ready = TRANSCRIPT.find((l) => l.t === 'ready') as Extract<BridgeLine, { t: 'ready' }>;
		expect(body.seats).toEqual(ready.seats.map((s) => ({ seat: s.seat, kind: 'human', deck: s.deck })));
		expect(h.hosts[0]?.spec.seats.map((s) => s.ai)).toEqual([false, false]);
	});

	it('refuses a caller below the floor with the same 404 as every other route', async () => {
		const h = await boot();
		const res = await fetch(`http://127.0.0.1:${h.port}/api/play/matches`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		expect(res.status).toBe(404);
		expect(h.hosts).toHaveLength(0);
	});

	it('refuses a body it does not understand, before any JVM is spent', async () => {
		const h = await boot();
		const res = await fetch(`http://127.0.0.1:${h.port}/api/play/matches`, {
			method: 'POST',
			headers: { ...edgeHeaders('alice'), 'content-type': 'application/json' },
			body: JSON.stringify({ opponent: 'goldfish' }),
		});
		expect(res.status).toBe(400);
		expect(h.hosts).toHaveLength(0);
	});

	it('reports a match Forge could not start as a failure, not a hang', async () => {
		const h = await boot();
		const response = fetch(`http://127.0.0.1:${h.port}/api/play/matches`, {
			method: 'POST',
			headers: { ...edgeHeaders('alice'), 'content-type': 'application/json' },
			body: '{}',
		});
		await waitUntil(() => h.hosts.length > 0, 'the host');
		h.hosts[0]?.push({ t: 'fatal', message: 'no precon in res/quest/precons has 40 cards' });
		const res = await response;
		expect(res.status).toBe(500);
		expect(((await res.json()) as { error: string }).error).toContain('precon');
	});
});

describe('two seats over the socket', () => {
	async function twoSeats(
		options: { disconnectGraceMs?: number } = {},
	): Promise<{ h: Harness; matchId: string; alice: Peer; bob: Peer; host: ReplayHost }> {
		const h = await boot(options);
		const { body } = await startMatch(h);
		const matchId = body.matchId as string;
		const alice = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));
		return { h, matchId, alice, bob, host: h.hosts[0] as ReplayHost };
	}

	it('seats the first joiner at 0 and the second at 1, each with their own Forge player and snapshot', async () => {
		const { matchId, alice, bob } = await twoSeats();
		const a = (await alice.request('forge:join', { matchId })) as Record<string, unknown>;
		const b = (await bob.request('forge:join', { matchId })) as Record<string, unknown>;
		expect(transportMod.MatchSnapshotSchema.safeParse(a).success).toBe(true);
		expect(transportMod.MatchSnapshotSchema.safeParse(b).success).toBe(true);
		expect([a.seat, a.playerId, b.seat, b.playerId]).toEqual([0, 0, 1, 1]);
		expect((a.cursor as { seq: number }).seq).toBeGreaterThan(0);
	});

	it('refuses a third person, and a join for a match that does not exist', async () => {
		const { h, matchId, alice, bob } = await twoSeats();
		await alice.request('forge:join', { matchId });
		await bob.request('forge:join', { matchId });
		const carol = await connect(h.port, edgeHeaders('carol'));
		expect(await carol.request('forge:join', { matchId })).toEqual({ error: 'match-full' });
		expect(await carol.request('forge:join', { matchId: 'm-000000000000' })).toEqual({ error: 'unknown-match' });
		expect(await carol.request('forge:resync', { matchId })).toEqual({ error: 'not-joined' });
	});

	it("never puts one byte of the other seat's hidden cards in what either peer received", async () => {
		const { matchId, alice, bob, host } = await twoSeats();
		await alice.request('forge:join', { matchId });
		await bob.request('forge:join', { matchId });
		host.push(PROBE_ASK, ...AFTER_PROBE);
		await waitUntil(() => alice.frames.length > 0 && bob.frames.length > 0, 'live frames to both seats');
		await alice.request('forge:resync', { matchId });
		await bob.request('forge:resync', { matchId });

		for (const [seat, peer] of [
			[0, alice],
			[1, bob],
		] as const) {
			const { secrets } = secretsFor(rawStatesOf(TRANSCRIPT, seat), seat);
			expect(secrets.size).toBeGreaterThan(0);
			const raw = TRANSCRIPT.filter((l) => l.t === 'frame' && l.seat === seat).map((l) => JSON.stringify(l)).join('\n');
			expect(leaked(secrets, raw).length).toBe(secrets.size);
			expect(leaked(secrets, peer.transcript())).toEqual([]);
		}
	});

	it('streams live frames per seat on one contiguous cursor that continues from the snapshot', async () => {
		const { matchId, alice, bob, host } = await twoSeats();
		const snaps = [
			(await alice.request('forge:join', { matchId })) as { cursor: { seq: number; epoch: string } },
			(await bob.request('forge:join', { matchId })) as { cursor: { seq: number; epoch: string } },
		];
		// The join re-sends the prompt and buttons of the moment after the snapshot.
		await waitUntil(() => alice.frames.length >= 2 && bob.frames.length >= 2, 'the post-snapshot re-sends');
		host.push(PROBE_ASK, ...AFTER_PROBE);
		const expected = [0, 1].map((seat) => TRANSCRIPT.slice(PROBE_AT).filter((l) => l.t === 'frame' && l.seat === seat).length);
		await waitUntil(
			() => alice.frames.length >= 2 + (expected[0] ?? 0) && bob.frames.length >= 2 + (expected[1] ?? 0),
			'every live frame',
		);
		for (const [i, peer] of [alice, bob].entries()) {
			const parsed = peer.frames.map((f) => transportMod.ServerEnvelopeSchema.parse(f));
			const base = snaps[i]?.cursor.seq ?? 0;
			expect(parsed.map((e) => e.cursor.seq)).toEqual(parsed.map((_, k) => base + k + 1));
			expect(new Set(parsed.map((e) => e.cursor.epoch))).toEqual(new Set([snaps[i]?.cursor.epoch]));
		}
		const aliceAsks = alice.frames.filter((f) => (f as { frame: { kind: string } }).frame.kind === 'ask');
		const bobAsks = bob.frames.filter((f) => (f as { frame: { kind: string } }).frame.kind === 'ask');
		expect([aliceAsks.length, bobAsks.length]).toEqual([1, 0]);
	});

	it("carries a seat's answer to Forge, and only the asked seat's", async () => {
		const { matchId, alice, bob, host } = await twoSeats();
		await alice.request('forge:join', { matchId });
		await bob.request('forge:join', { matchId });
		host.push(PROBE_ASK);
		await waitUntil(() => alice.frames.some((f) => (f as { frame: { kind: string } }).frame.kind === 'ask'), 'the ask');
		const callId = (PROBE_ASK.frame as { callId: string }).callId;
		const answer = { kind: 'reply', callId, method: 'showConfirmDialog', result: true };
		bob.send({ matchId, frame: answer });
		alice.send({ matchId, frame: { ...answer, result: 'yes' } }); // wrong type for the method
		alice.send({ matchId, frame: answer });
		await waitUntil(() => host.commands.length > 0, 'the reply to reach Forge');
		expect(host.commands).toEqual([{ t: 'reply', seat: 0, callId, result: true }]);
	});

	it("aborts the open ask as 'disconnected' when the seat's last connection drops — but not on a refresh", async () => {
		// A short grace, so the abort this test waits for comes quickly.
		const { h, matchId, alice, bob, host } = await twoSeats({ disconnectGraceMs: 200 });
		await alice.request('forge:join', { matchId });
		await bob.request('forge:join', { matchId });
		host.push(PROBE_ASK);
		await waitUntil(() => alice.frames.length > 2, 'the ask');

		// A refresh: the new tab joins first, then the old one's close lands.
		const aliceAgain = await connect(h.port, edgeHeaders('alice'));
		const again = (await aliceAgain.request('forge:join', { matchId })) as { seat: number };
		expect(again.seat).toBe(0);
		alice.socket.disconnect();
		await waitUntil(() => h.logs.some((l) => l.evt === 'left'), 'the old tab to leave');
		expect(host.commands).toEqual([]);

		aliceAgain.socket.disconnect();
		await waitUntil(() => host.commands.length > 0, 'the abort');
		const callId = (PROBE_ASK.frame as { callId: string }).callId;
		expect(host.commands).toEqual([{ t: 'abort', seat: 0, callId, reason: 'disconnected' }]);
	});
});

/* ── Wave 10: crash and reconnect, over the real socket ─────────────── */

type Envelope = { cursor: { seq: number; epoch: string }; frame: { kind: string; method: string; callId?: string; title?: string } };
const STATE_METHODS = new Set(['setGameView', 'openView', 'applyDelta']);

/** What a browser holds: the snapshot's frames, then every state frame after it, folded. */
function boardOf(snapshot: { frames: unknown[] }, frames: unknown[]): Map<string, unknown> {
	const after = (frames as Envelope[]).filter((e) => STATE_METHODS.has(e.frame.method)).map((e) => e.frame);
	return foldFrames([...snapshot.frames, ...after] as unknown as StateFrame[]);
}

function isEndedNotice(payload: unknown): boolean {
	const f = (payload as Envelope).frame;
	return f.method === 'showErrorDialog' && f.title === 'Match ended';
}

describe('reconnect: a browser refresh mid-match', () => {
	it('closes the old socket FIRST, then rejoins: same seat, same board, the same open ask — and Forge never hears "disconnected"', async () => {
		// A 1 s grace, outlived below after the rejoin: the rejoin must DISARM the abort, not merely beat it.
		const h = await boot({ disconnectGraceMs: 1000 });
		const { body } = await startMatch(h);
		const matchId = body.matchId as string;
		const alice = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));
		const first = (await alice.request('forge:join', { matchId })) as { seat: number; frames: unknown[] };
		await bob.request('forge:join', { matchId });
		const host = h.hosts[0] as ReplayHost;
		host.push(PROBE_ASK);
		await waitUntil(() => alice.frames.some((f) => (f as Envelope).frame.kind === 'ask'), 'the ask');
		const boardBefore = boardOf(first, alice.frames);
		expect(boardBefore.size).toBeGreaterThan(50);

		// The refresh, in the order a browser does it.
		alice.socket.disconnect();
		await waitUntil(() => h.logs.some((l) => l.evt === 'left' && l.seat === 0 && l.stillHere === false), 'the old page to go');
		const aliceAgain = await connect(h.port, edgeHeaders('alice'));
		const again = (await aliceAgain.request('forge:join', { matchId })) as { seat: number; frames: unknown[]; cursor: { epoch: string } };
		expect(again.seat).toBe(0);
		expect(again.cursor.epoch).toBe((alice.frames[0] as Envelope).cursor.epoch);
		expect(boardOf(again, [])).toEqual(boardBefore);

		const callId = (PROBE_ASK.frame as { callId: string }).callId;
		await waitUntil(() => aliceAgain.frames.some((f) => (f as Envelope).frame.callId === callId), 'the same ask, re-sent');
		await new Promise((r) => setTimeout(r, 1500));
		expect(host.commands).toEqual([]);
		aliceAgain.send({ matchId, frame: { kind: 'reply', callId, method: 'showConfirmDialog', result: true } });
		await waitUntil(() => host.commands.length > 0, 'the answer to reach Forge');
		expect(host.commands).toEqual([{ t: 'reply', seat: 0, callId, result: true }]);
	});
});

describe('crash: the JVM dies mid-match', () => {
	it('leaves the server and its sockets up, tells both seats, and keeps telling a seat that resyncs', async () => {
		const h = await boot();
		const { body } = await startMatch(h);
		const matchId = body.matchId as string;
		const alice = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));
		await alice.request('forge:join', { matchId });
		await bob.request('forge:join', { matchId });
		(h.hosts[0] as ReplayHost).exit('the JVM exited (code null, signal SIGKILL); see /tmp/x/bridge.stderr.txt');

		await waitUntil(() => [alice, bob].every((p) => p.frames.some(isEndedNotice)), 'both seats to be told');
		for (const p of [alice, bob]) expect(transportMod.ServerEnvelopeSchema.safeParse(p.frames.find(isEndedNotice)).success).toBe(true);
		expect(alice.socket.connected && bob.socket.connected).toBe(true);

		const status = await fetch(`http://127.0.0.1:${h.port}/api/play/matches/${matchId}`, { headers: edgeHeaders('alice') });
		expect(((await status.json()) as { status: string }).status).toBe('failed');

		// A resync after the crash: the board it had, then the notice again.
		const seen = alice.frames.length;
		const snap = (await alice.request('forge:resync', { matchId })) as { frames: unknown[] };
		expect(snap.frames.length).toBeGreaterThan(0);
		await waitUntil(() => alice.frames.slice(seen).some(isEndedNotice), 'the notice after the resync');

		// The server survived: the next match starts and seats people.
		const next = await startMatch(h, 'carol');
		expect(next.status).toBe(201);
		const carol = await connect(h.port, edgeHeaders('carol'));
		expect(((await carol.request('forge:join', { matchId: next.body.matchId })) as { seat: number }).seat).toBe(0);
	});
});

describe('the gate and identity', () => {
	it('refuses a socket handshake below the floor', async () => {
		const h = await boot();
		await expect(connect(h.port, {})).rejects.toThrow();
	});

	it('ignores a dev identity unless the insecure hatch is open — with a real edge it would be identity by assertion', async () => {
		const h = await boot({ devIdentity: true });
		expect(h.logs.some((l) => l.evt === 'dev-identity-refused')).toBe(true);
		const { body } = await startMatch(h);
		const matchId = body.matchId as string;
		const one = await connect(h.port, edgeHeaders('alice'), { devUser: 'one' });
		const two = await connect(h.port, edgeHeaders('alice'), { devUser: 'two' });
		const a = (await one.request('forge:join', { matchId })) as { seat: number };
		const b = (await two.request('forge:join', { matchId })) as { seat: number };
		expect([a.seat, b.seat]).toEqual([0, 0]);
	});
});
