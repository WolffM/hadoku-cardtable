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

import { parseStartBody, parseStopPolicyEnv, STOP_POLICY_ENV } from './socket.ts';
import { ARENA_STOP_POLICY, DEFAULT_STOP_POLICY, FULL_CONTROL_POLICY, STRICT_PAYMENT_POLICY } from './auto.ts';
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

async function boot(options: { devIdentity?: boolean; disconnectGraceMs?: number; probe?: boolean } = {}): Promise<Harness> {
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
		probe: options.probe,
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
	/** Every `forge:full-control` payload the SERVER sent this socket, as received. */
	fullControls: unknown[];
	/**
	 * Every `forge:seats` payload the SERVER sent this socket, as received —
	 * item 4's server half (wave 29 §B). Sent on every join and every resync,
	 * beside `forge:full-control`; see `socket.ts`'s `answer`.
	 */
	seatsEvents: unknown[];
	/** Every `forge:role` payload the SERVER sent this socket (wave 31 §S). */
	roles: unknown[];
	presences: unknown[];
	request(event: 'forge:join' | 'forge:resync', payload: unknown): Promise<unknown>;
	send(payload: unknown): void;
	/** Ask for full control, or give it back — the client → server direction. */
	setFullControl(payload: unknown): void;
	/** Wave 30 §B item 6: flip the "always stop at end step" setting for THIS seat. */
	setStopPreference(payload: unknown): void;
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
			fullControls: [],
			seatsEvents: [],
			roles: [],
			presences: [],
			request: async (event, payload) => {
				const ack: unknown = await socket.timeout(3000).emitWithAck(event, payload);
				peer.acks.push(ack);
				return ack;
			},
			send: (payload) => socket.emit('forge:c2s', payload),
			setFullControl: (payload) => socket.emit('forge:full-control', payload),
			setStopPreference: (payload) => socket.emit('forge:stop-preference', payload),
			transcript: () => [...peer.acks, ...peer.frames].map((x) => JSON.stringify(x)).join('\n'),
		};
		socket.on('forge:s2c', (payload: unknown) => peer.frames.push(payload));
		socket.on('forge:full-control', (payload: unknown) => peer.fullControls.push(payload));
		socket.on('forge:seats', (payload: unknown) => peer.seatsEvents.push(payload));
		socket.on('forge:presence', (payload: unknown) => peer.presences.push(payload));
		socket.on('forge:role', (payload: unknown) => peer.roles.push(payload));
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
async function startMatch(
	h: Harness,
	user = 'alice',
	body: Record<string, unknown> = { opponent: 'human' },
): Promise<{ status: number; body: Record<string, unknown> }> {
	const hostsBefore = h.hosts.length;
	const response = fetch(`http://127.0.0.1:${h.port}/api/play/matches`, {
		method: 'POST',
		headers: { ...edgeHeaders(user), 'content-type': 'application/json' },
		body: JSON.stringify(body),
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

/*
 * Wave 33 §S, shape 1 — "a scenario is a TEST facility, never a production one.
 * It is honoured only when the server runs with CARDTABLE_PLAY_PROBE=1 …
 * A request carrying `scenario` without the flag is refused, not ignored."
 * This is the HTTP-layer half of that rule: `attachPlay`'s `deps.probe` is what
 * `index.ts` sets from the environment variable (never on in production), and
 * the gate lives ahead of `matches.create` so a scenario can never spend a JVM
 * it was refused.
 */
describe('POST /api/play/matches: scenario needs the probe flag', () => {
	const SCENARIO = 'humanlife=20\nailife=20\n';

	it('refuses a scenario with the probe flag off, before any JVM is spent', async () => {
		const h = await boot({ probe: false });
		const res = await fetch(`http://127.0.0.1:${h.port}/api/play/matches`, {
			method: 'POST',
			headers: { ...edgeHeaders('alice'), 'content-type': 'application/json' },
			body: JSON.stringify({ scenario: SCENARIO }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'scenario-needs-probe' });
		expect(h.hosts).toHaveLength(0);
	});

	it('refuses a scenario when the flag is simply absent (the production default)', async () => {
		const h = await boot();
		const res = await fetch(`http://127.0.0.1:${h.port}/api/play/matches`, {
			method: 'POST',
			headers: { ...edgeHeaders('alice'), 'content-type': 'application/json' },
			body: JSON.stringify({ scenario: SCENARIO }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'scenario-needs-probe' });
		expect(h.hosts).toHaveLength(0);
	});

	it('accepts a scenario with the flag on, and carries the text onto the match spec', async () => {
		const h = await boot({ probe: true });
		const { status } = await startMatch(h, 'alice', { scenario: SCENARIO });
		expect(status).toBe(201);
		expect(h.hosts[0]?.spec.scenario).toBe(SCENARIO);
	});

	it('still starts an ordinary match with the flag on and no scenario', async () => {
		const h = await boot({ probe: true });
		const { status } = await startMatch(h);
		expect(status).toBe(201);
		expect(h.hosts[0]?.spec.scenario).toBeUndefined();
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

	/*
	 * Presence (ledger Z5): a seat's pointer and hands, relayed as sent to the
	 * match's OTHER sockets, stamped with the seat. Forge never hears it and
	 * the message names no card, so there is nothing to redact.
	 */
	it('relays a seat’s presence to the other seat, stamped with the seat, never back to the sender, and never from a spectator', async () => {
		const { h, matchId, alice, bob } = await twoSeats();
		await alice.request('forge:join', { matchId });
		await bob.request('forge:join', { matchId });
		const message = {
			matchId,
			type: 'presence',
			pointer: { zone: 'battlefield', x: 0.25, y: 0.5 },
			held: true,
			from: { zone: 'hand', x: 0.1, y: 0.9 },
			handRows: 2,
		};
		alice.socket.emit('forge:presence', message);
		await vi.waitFor(() => expect(bob.presences).toHaveLength(1));
		expect(bob.presences[0]).toEqual({ ...message, seat: 0 });
		await new Promise((r) => setTimeout(r, 60));
		expect(alice.presences, 'nothing comes back to the sender').toHaveLength(0);

		// Malformed: dropped and logged, not relayed. A card id would be malformed too — the schema
		// is strict, and so is a hand row count that is neither 1 nor 2.
		alice.socket.emit('forge:presence', { ...message, cardId: 42 });
		alice.socket.emit('forge:presence', { matchId, type: 'presence', pointer: { zone: 'hand', x: 2, y: 0 }, held: false, from: null, handRows: 1 });
		alice.socket.emit('forge:presence', { ...message, handRows: 3 });
		await vi.waitFor(() => expect(h.logs.filter((l) => l.evt === 'presence-malformed')).toHaveLength(3));
		expect(bob.presences).toHaveLength(1);

		// A match spans a deploy: a tab still on the OLD bundle sends a spot's old `owner` field and
		// no `handRows` at all. That shape still relays — never dropped, never logged as malformed —
		// with `handRows` defaulted to 1 and `owner` gone, not merely ignored by the receiver.
		alice.socket.emit('forge:presence', { matchId, type: 'presence', pointer: { zone: 'battlefield', owner: 'you', x: 0.25, y: 0.5 }, held: false, from: null });
		await vi.waitFor(() => expect(bob.presences).toHaveLength(2));
		expect(bob.presences[1]).toEqual({ matchId, type: 'presence', pointer: { zone: 'battlefield', x: 0.25, y: 0.5 }, held: false, from: null, handRows: 1, seat: 0 });
		expect(h.logs.filter((l) => l.evt === 'presence-malformed'), 'still 3: the old shape was never malformed').toHaveLength(3);

		// A spectator on alice's seat (a second browser) sends, and nobody hears it.
		const watcher = await connect(h.port, edgeHeaders('alice'));
		await watcher.request('forge:join', { matchId });
		watcher.socket.emit('forge:presence', message);
		await new Promise((r) => setTimeout(r, 80));
		expect(bob.presences, 'a spectator’s pointer belongs to nobody').toHaveLength(2);
	});
	it('refuses a third person, and a join for a match that does not exist', async () => {
		const { h, matchId, alice, bob } = await twoSeats();
		await alice.request('forge:join', { matchId });
		await bob.request('forge:join', { matchId });
		const carol = await connect(h.port, edgeHeaders('carol'));
		// A generic refusal keeps the bare `{ error }` shape it always had — only
		// `match-gone` carries the outcome and the words. See socket.ts's header.
		expect(await carol.request('forge:join', { matchId })).toEqual({ error: 'match-full' });
		expect(await carol.request('forge:resync', { matchId })).toEqual({ error: 'not-joined' });
		expect(await carol.request('forge:join', { matchId: 'm-000000000000' })).toMatchObject({
			error: 'unknown-match',
			outcome: 'match-gone',
		});
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
		const { h, matchId, alice, bob, host } = await twoSeats();
		const snaps = [
			(await alice.request('forge:join', { matchId })) as { cursor: { seq: number; epoch: string } },
			(await bob.request('forge:join', { matchId })) as { cursor: { seq: number; epoch: string } },
		];
		// The join re-sends the prompt and buttons of the moment after the snapshot.
		await waitUntil(() => alice.frames.length >= 2 && bob.frames.length >= 2, 'the post-snapshot re-sends');
		host.push(PROBE_ASK, ...AFTER_PROBE);
		// the transcript's own closing window (seat 1's opening
		// Upkeep priority) is auto-passed — Upkeep is not a stop phase — so
		// `match.ts` withholds it whole rather than forwarding it. Two fewer
		// frames than the bridge sent, for seat 1 only; read off the log,
		// never guessed, so a different fixture change cannot hide behind it.
		await waitUntil(() => h.logs.some((l) => l.evt === 'prompt-withheld'), 'the withheld window to be decided');
		const withheld = h.logs.filter((l) => l.evt === 'prompt-withheld') as { seat: number }[];
		const expected = [0, 1].map((seat) => {
			const bridgeCount = TRANSCRIPT.slice(PROBE_AT).filter((l) => l.t === 'frame' && l.seat === seat).length;
			// Each withheld window is TWO bridge frames (prompt, buttons) that
			// become ZERO emitted ones — never one, since neither half goes out.
			const withheldForSeat = withheld.filter((w) => w.seat === seat).length * 2;
			return bridgeCount - withheldForSeat;
		});
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

/*
 * Item 4's server half (wave 29 §B): *"i noticed you're still not pulling in
 * the watchparty selected avatars. why not?"* — `routes.ts`'s `startFromRoom`
 * carries `avatarIds` in seat order, `parseStartBody` normalizes them onto the
 * spec, and `Match.seatIdentities` sends them on `forge:seats`, beside
 * `playerId`, to every socket that joins or resyncs.
 *
 * These cases start a match DIRECTLY against `POST /api/play/matches` (not
 * through the room gate, which is `http/tables.test.ts`'s route) — the two
 * files' done-whens are deliberately split this way: this one proves the
 * WIRE shape reaching the client, that one proves the ROOM's member lands in
 * the right seat.
 */
describe('forge:seats: item 4’s server half', () => {
	it("carries the avatar beside playerId, and a seat with none carries the absent state — never null, never ''", async () => {
		const h = await boot();
		const { body } = await startMatch(h, 'alice', { opponent: 'human', avatarIds: ['wanderer', undefined] });
		const matchId = body.matchId as string;
		const alice = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));

		const a = (await alice.request('forge:join', { matchId })) as Record<string, unknown>;
		// Alice joins first: at the instant HER join is answered, bob has not
		// claimed his seat yet, so her own first `forge:seats` correctly reports
		// seat 1 unclaimed — that half is asserted separately below, from a
		// resync taken once both have joined.
		const b = (await bob.request('forge:join', { matchId })) as Record<string, unknown>;
		// The join ack itself is untouched: `MatchSnapshotSchema` is `.strict()`
		// and not this lane's schema to widen, so the new field rides a separate
		// event rather than this one.
		expect(transportMod.MatchSnapshotSchema.safeParse(a).success).toBe(true);
		expect(transportMod.MatchSnapshotSchema.safeParse(b).success).toBe(true);
		expect(a).not.toHaveProperty('seats');

		await waitUntil(() => alice.seatsEvents.length > 0 && bob.seatsEvents.length > 0, 'both seats to be told their identities');
		// Bob joined second, after alice's seat was already claimed, so his own
		// first event is the one that shows BOTH seats claimed.
		const event = bob.seatsEvents[0] as { matchId: string; seats: unknown[] };
		expect(event.matchId).toBe(matchId);
		expect(event.seats).toEqual([
			{ seat: 0, claimed: true, playerId: 0, avatarId: 'wanderer' },
			{ seat: 1, claimed: true, playerId: 1 },
		]);
		// ABSENT, not `avatarId: undefined` and not `avatarId: null` — the same
		// bug `D-avatar-field.md` §3 names: an empty/null value survives a
		// `!== undefined` check and draws as a broken image where the fallback
		// belonged.
		expect(event.seats[1]).not.toHaveProperty('avatarId');
		const wire = JSON.stringify(bob.seatsEvents);
		expect(wire).toContain('"avatarId":"wanderer"');
		expect(wire).not.toContain('"avatarId":null');
		expect(wire).not.toContain('"avatarId":""');
	});

	it('is told again, the same way, on a resync', async () => {
		const h = await boot();
		const { body } = await startMatch(h, 'alice', { opponent: 'human', avatarIds: ['sage', 'herald'] });
		const matchId = body.matchId as string;
		const alice = await connect(h.port, edgeHeaders('alice'));
		await alice.request('forge:join', { matchId });
		await waitUntil(() => alice.seatsEvents.length > 0, 'the join to carry it');

		await alice.request('forge:resync', { matchId });
		await waitUntil(() => alice.seatsEvents.length > 1, 'the resync to carry it too');
		expect(alice.seatsEvents[1]).toEqual(alice.seatsEvents[0]);
	});

	/*
	 * Wave 32, Q6 — *"watchparty chat and the game are desynced when i change
	 * avatars"*. The match was told each avatar once, at its start; `Match.setSeatAvatar`
	 * is what `routes.ts` calls when the identity route changes a member who holds a
	 * seat, and EVERY socket in the match must hear the new roster.
	 */
	it('Q6: an avatar changed mid-match reaches every socket in the match, on forge:seats', async () => {
		const h = await boot();
		const { body } = await startMatch(h, 'alice', { opponent: 'human', avatarIds: ['sage', 'herald'] });
		const matchId = body.matchId as string;
		const alice = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));
		await alice.request('forge:join', { matchId });
		await bob.request('forge:join', { matchId });
		await waitUntil(() => alice.seatsEvents.length > 0 && bob.seatsEvents.length > 0, 'both seats to have been told once');
		const before = { alice: alice.seatsEvents.length, bob: bob.seatsEvents.length };

		(h.handle.matches.get(matchId) as import('./match.ts').Match).setSeatAvatar(0, 'wanderer');

		await waitUntil(() => alice.seatsEvents.length > before.alice && bob.seatsEvents.length > before.bob, 'every socket to hear the change');
		for (const peer of [alice, bob]) {
			const event = peer.seatsEvents.at(-1) as { matchId: string; seats: { seat: number; avatarId?: string }[] };
			expect(event.matchId).toBe(matchId);
			expect(event.seats.map((x) => x.avatarId)).toEqual(['wanderer', 'herald']);
		}
	});

	it('a refused join is told nothing at all — there is no seat to name', async () => {
		const h = await boot();
		const { body } = await startMatch(h);
		const matchId = body.matchId as string;
		const alice = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));
		await alice.request('forge:join', { matchId });
		await bob.request('forge:join', { matchId });
		const carol = await connect(h.port, edgeHeaders('carol'));
		expect(await carol.request('forge:join', { matchId })).toEqual({ error: 'match-full' });
		await new Promise((r) => setTimeout(r, 200));
		expect(carol.seatsEvents).toEqual([]);
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

/*
 * Full control is a per-seat preference the server holds and no frame carries,
 * so a page that has just joined has no way to know it — which is exactly how a
 * refresh came to draw the toggle off while the server still had the seat in
 * full control. The server now says so on `forge:full-control`, the same event
 * and the same payload the client sends, to the socket it has just answered.
 *
 * These cases are over REAL sockets: what is asserted is the bytes a browser
 * would receive. The client's half — adopting it — is
 * `apps/ui/src/play/live/match.test.ts`.
 */
describe('full control survives a refresh', () => {
	it('tells a joining socket what this seat is set to, and a refreshed page is told ON', async () => {
		const h = await boot({ disconnectGraceMs: 1000 });
		const { body } = await startMatch(h);
		const matchId = body.matchId as string;
		const alice = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));
		await alice.request('forge:join', { matchId });
		await bob.request('forge:join', { matchId });

		// Every join is told, so a page that has it ON and a server that does not
		// is corrected too. The default is off, and that is what the first join says.
		await waitUntil(() => alice.fullControls.length > 0 && bob.fullControls.length > 0, 'both first joins to be told');
		expect(alice.fullControls).toEqual([{ matchId, on: false }]);
		expect(bob.fullControls).toEqual([{ matchId, on: false }]);

		// The player opens the hatch.
		alice.setFullControl({ matchId, on: true });
		await waitUntil(() => h.handle.matches.get(matchId)?.fullControl(0) === true, 'the server to hold full control');

		// The refresh, in the order a browser does it: the old socket goes, a new
		// one joins. It is a NEW page — it starts with the toggle off and nothing
		// of the old one's memory.
		alice.socket.disconnect();
		await waitUntil(() => h.logs.some((l) => l.evt === 'left' && l.seat === 0 && l.stillHere === false), 'the old page to go');
		const aliceAgain = await connect(h.port, edgeHeaders('alice'));
		const again = (await aliceAgain.request('forge:join', { matchId })) as { seat: number };
		expect(again.seat).toBe(0);

		await waitUntil(() => aliceAgain.fullControls.length > 0, 'the refreshed page to be told');
		expect(aliceAgain.fullControls).toEqual([{ matchId, on: true }]);
		// And it is the seat's own state, not the match's: bob is untouched.
		expect(bob.fullControls).toEqual([{ matchId, on: false }]);
		expect(h.handle.matches.get(matchId)?.fullControl(1)).toBe(false);

		// A resync is told too — the same reason a resync re-sends the prompt.
		await aliceAgain.request('forge:resync', { matchId });
		await waitUntil(() => aliceAgain.fullControls.length > 1, 'the resync to be told');
		expect(aliceAgain.fullControls).toEqual([
			{ matchId, on: true },
			{ matchId, on: true },
		]);

		// It is the parsed payload, nothing more: the client's own strict schema
		// accepts every one of these, which is what makes the echo adoptable.
		for (const payload of aliceAgain.fullControls) {
			expect(transportMod.FullControlSchema.safeParse(payload).success).toBe(true);
		}
	});

	it('a refused join is told nothing at all — there is no seat to have a preference', async () => {
		const h = await boot();
		const { body } = await startMatch(h);
		const matchId = body.matchId as string;
		const alice = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));
		await alice.request('forge:join', { matchId });
		await bob.request('forge:join', { matchId });
		const carol = await connect(h.port, edgeHeaders('carol'));
		expect(await carol.request('forge:join', { matchId })).toEqual({ error: 'match-full' });
		await new Promise((r) => setTimeout(r, 200));
		expect(carol.fullControls).toEqual([]);
	});
});

/*
 * Wave 30 §B item 2/6: *"i think by default this should be off, but can be
 * turned on in settings (always stop at endstep)."* `forge:stop-preference` is
 * the wire half — client → server only, over REAL sockets — of moving the
 * seat's OWN `StopPolicy` (`Match.setStopPolicy`, wave 26 §E); the shortcut
 * decision itself is `auto.test.ts`'s "item 2" case.
 */
describe('the stop-at-end-step preference (item 2/6)', () => {
	it('toggles END_OF_TURN in and out of stopOnTheirTurn, and only this seat’s', async () => {
		const h = await boot();
		const { body } = await startMatch(h);
		const matchId = body.matchId as string;
		const alice = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));
		await alice.request('forge:join', { matchId });
		await bob.request('forge:join', { matchId });
		const match = h.handle.matches.get(matchId);

		// The default: off, exactly `DEFAULT_STOP_POLICY` (wave 30 item 2 dropped
		// END_OF_TURN from it already), for both seats.
		expect(match?.stopPolicy(0)).toEqual(DEFAULT_STOP_POLICY);
		expect(match?.stopPolicy(1)).toEqual(DEFAULT_STOP_POLICY);

		alice.setStopPreference({ matchId, type: 'stopPreference', stopAtEndStep: true });
		await waitUntil(() => match?.stopPolicy(0).stopOnTheirTurn.includes('END_OF_TURN') === true, 'seat 0 to hold the setting');
		expect(match?.stopPolicy(0)).toEqual({ ...DEFAULT_STOP_POLICY, stopOnTheirTurn: ['COMBAT_DECLARE_BLOCKERS', 'END_OF_TURN'] });
		// Bob never asked for it — a preference of the person in the seat, exactly
		// like full control.
		expect(match?.stopPolicy(1)).toEqual(DEFAULT_STOP_POLICY);

		// Flipping it off again restores the default exactly — not a field wiped,
		// a value re-derived from whatever the seat was already on.
		alice.setStopPreference({ matchId, type: 'stopPreference', stopAtEndStep: false });
		await waitUntil(() => match?.stopPolicy(0).stopOnTheirTurn.includes('END_OF_TURN') === false, 'seat 0 to drop the setting');
		expect(match?.stopPolicy(0)).toEqual(DEFAULT_STOP_POLICY);
	});

	it('composes with a policy the seat already had, rather than resetting it', async () => {
		// Wave 27 §C's hatch — `CARDTABLE_PLAY_STOP_POLICY` — starts both seats on
		// STRICT_PAYMENT_POLICY, same device the suite above this one exercises.
		const original = process.env[STOP_POLICY_ENV];
		process.env[STOP_POLICY_ENV] = 'strictPayment';
		try {
			const h = await boot();
			const { body } = await startMatch(h);
			const matchId = body.matchId as string;
			const alice = await connect(h.port, edgeHeaders('alice'));
			await alice.request('forge:join', { matchId });
			const match = h.handle.matches.get(matchId);
			expect(match?.stopPolicy(0)).toEqual(STRICT_PAYMENT_POLICY);

			alice.setStopPreference({ matchId, type: 'stopPreference', stopAtEndStep: true });
			await waitUntil(() => match?.stopPolicy(0).stopOnTheirTurn.includes('END_OF_TURN') === true, 'the setting to land');
			// Every OTHER field of the seat's starting policy survives —
			// `unambiguousPayment` stays `'auto'`, not reset to the module default's
			// `'forgeAuto'`.
			expect(match?.stopPolicy(0)).toEqual({ ...STRICT_PAYMENT_POLICY, stopOnTheirTurn: ['COMBAT_DECLARE_BLOCKERS', 'END_OF_TURN'] });
		} finally {
			if (original === undefined) delete process.env[STOP_POLICY_ENV];
			else process.env[STOP_POLICY_ENV] = original;
		}
	});

	it('a malformed payload is logged and refused, never applied', async () => {
		const h = await boot();
		const { body } = await startMatch(h);
		const matchId = body.matchId as string;
		const alice = await connect(h.port, edgeHeaders('alice'));
		await alice.request('forge:join', { matchId });
		const match = h.handle.matches.get(matchId);

		alice.setStopPreference({ matchId, type: 'somethingElse', stopAtEndStep: true });
		await waitUntil(() => h.logs.some((l) => l.evt === 'stop-preference-malformed'), 'the refusal to be logged');
		expect(match?.stopPolicy(0)).toEqual(DEFAULT_STOP_POLICY);
	});

	it('a socket that never joined this match cannot move a seat it is not in', async () => {
		const h = await boot();
		const { body } = await startMatch(h);
		const matchId = body.matchId as string;
		const outsider = await connect(h.port, edgeHeaders('outsider'));
		outsider.setStopPreference({ matchId, type: 'stopPreference', stopAtEndStep: true });
		await waitUntil(() => h.logs.some((l) => l.evt === 'stop-preference-not-joined'), 'the refusal to be logged');
		expect(h.handle.matches.get(matchId)?.stopPolicy(0)).toEqual(DEFAULT_STOP_POLICY);
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

/* ── the test seed reaches the match spec ────────────────────────────── */

describe('CARDTABLE_PLAY_SEED', () => {
	const ORIGINAL = process.env.CARDTABLE_PLAY_SEED;
	afterEach(() => {
		if (ORIGINAL === undefined) delete process.env.CARDTABLE_PLAY_SEED;
		else process.env.CARDTABLE_PLAY_SEED = ORIGINAL;
	});

	/*
	 * `e2e/play.spec.ts` proves a spell resolves with nobody pressing a button,
	 * which it can only do if the game ever offers a castable spell. Unseeded,
	 * the shuffle decides that: on 2026-09-25 CI drew a hand where Forge
	 * offered nothing but lands (`casts: []`), and the proof failed on luck.
	 * `MatchSpec.seed` fixes Forge's shuffles, the coin toss and the precon
	 * pick, and `bridgeConfig` spreads the whole spec to the JVM — but nothing
	 * on the PRODUCT path ever set it, so only `jvm.test.ts` (which builds a
	 * spec by hand) could ask for one.
	 */
	it('rides onto the spec when set, and is absent otherwise', () => {
		delete process.env.CARDTABLE_PLAY_SEED;
		const unseeded = parseStartBody({});
		expect(unseeded.ok).toBe(true);
		if (!unseeded.ok) return;
		expect(unseeded.spec.seed, 'production must not be seeded').toBeUndefined();

		process.env.CARDTABLE_PLAY_SEED = '20260925';
		const seeded = parseStartBody({});
		expect(seeded.ok).toBe(true);
		if (!seeded.ok) return;
		expect(seeded.spec.seed).toBe(20260925);
	});

	it('ignores a value that is not a number rather than seeding with NaN', () => {
		process.env.CARDTABLE_PLAY_SEED = 'not-a-seed';
		const r = parseStartBody({});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.spec.seed).toBeUndefined();
	});
});

/* ── a seat can be set strict, from outside the process (wave 27 §C) ─── */

describe(STOP_POLICY_ENV, () => {
	const ORIGINAL = process.env[STOP_POLICY_ENV];
	afterEach(() => {
		if (ORIGINAL === undefined) delete process.env[STOP_POLICY_ENV];
		else process.env[STOP_POLICY_ENV] = ORIGINAL;
	});

	/*
	 * Wave 26 §E gave every seat its own `StopPolicy` (`match.ts`,
	 * `SeatState.policy`) and nothing could select one — the values are module
	 * constants in `auto.ts`, so naming `STRICT_PAYMENT_POLICY` meant importing
	 * it, which only a unit test can do. The visible cost: wave 27 §B could not
	 * screenshot a live mana payment, because `DEFAULT_STOP_POLICY`'s
	 * `unambiguousPayment: 'forgeAuto'` has the server press Forge's own Auto the
	 * instant the window opens, so no browser is ever shown the ask.
	 *
	 * Shaped after `CARDTABLE_PLAY_SEED` above, and for the same reason: read off
	 * THIS server's environment, unset in every deployment.
	 */
	it('names a policy when set, and names nothing otherwise', () => {
		delete process.env[STOP_POLICY_ENV];
		expect(parseStopPolicyEnv(process.env), 'production must not pick a policy').toBeNull();
		// An empty value is the same as unset — a shell that exports the variable
		// blank has not selected anything.
		expect(parseStopPolicyEnv({ [STOP_POLICY_ENV]: '' })).toBeNull();

		process.env[STOP_POLICY_ENV] = 'strictPayment';
		expect(parseStopPolicyEnv(process.env)).toEqual({ name: 'strictPayment', policy: STRICT_PAYMENT_POLICY });
		// …and that is the value that makes a payment the player's to click.
		expect(STRICT_PAYMENT_POLICY.unambiguousPayment).toBe('auto');
		expect(DEFAULT_STOP_POLICY.unambiguousPayment).toBe('forgeAuto');
	});

	it('resolves every name it advertises, and trims the shell whitespace off one', () => {
		expect(parseStopPolicyEnv({ [STOP_POLICY_ENV]: 'default' })?.policy).toEqual(DEFAULT_STOP_POLICY);
		expect(parseStopPolicyEnv({ [STOP_POLICY_ENV]: 'arena' })?.policy).toEqual(ARENA_STOP_POLICY);
		expect(parseStopPolicyEnv({ [STOP_POLICY_ENV]: 'fullControl' })?.policy).toEqual(FULL_CONTROL_POLICY);
		expect(parseStopPolicyEnv({ [STOP_POLICY_ENV]: '  strictPayment\n' })?.policy).toEqual(STRICT_PAYMENT_POLICY);
	});

	/*
	 * A typo must be loud. Falling back to the default silently would play the
	 * whole match under the policy the operator was trying to move off, and the
	 * screenshot would be of nothing — which is exactly the week
	 * `CARDTABLE_PLAY_SEED` spent set on a server that could not start Forge.
	 */
	it('reports an unknown name rather than quietly falling back', () => {
		const r = parseStopPolicyEnv({ [STOP_POLICY_ENV]: 'strict-payment' });
		expect(r).not.toBeNull();
		expect(r?.name).toBe('strict-payment');
		expect(r?.policy).toBeNull();
	});

	it('starts a real match’s seats on the named policy, and on the default when unset', async () => {
		delete process.env[STOP_POLICY_ENV];
		const plain = await boot();
		const { body: plainBody } = await startMatch(plain);
		const plainMatch = plain.handle.matches.get(plainBody.matchId as string);
		expect(plainMatch?.stopPolicy(0), 'production must keep DEFAULT_STOP_POLICY').toEqual(DEFAULT_STOP_POLICY);
		expect(plainMatch?.stopPolicy(1)).toEqual(DEFAULT_STOP_POLICY);
		expect(plain.logs.some((l) => l.evt === 'stop-policy-selected')).toBe(false);
		await plain.close();

		process.env[STOP_POLICY_ENV] = 'strictPayment';
		const strict = await boot();
		expect(strict.logs.find((l) => l.evt === 'stop-policy-selected')).toMatchObject({
			name: 'strictPayment',
			unambiguousPayment: 'auto',
		});
		const { body } = await startMatch(strict);
		const match = strict.handle.matches.get(body.matchId as string);
		expect(match?.stopPolicy(0)).toEqual(STRICT_PAYMENT_POLICY);
		expect(match?.stopPolicy(1)).toEqual(STRICT_PAYMENT_POLICY);
		// The per-seat mechanism is untouched: one seat still moves alone.
		expect(match?.setStopPolicy(1, DEFAULT_STOP_POLICY)).toEqual({ ok: true });
		expect(match?.stopPolicy(0)).toEqual(STRICT_PAYMENT_POLICY);
		expect(match?.stopPolicy(1)).toEqual(DEFAULT_STOP_POLICY);
	});

	it('logs an unknown name at attach and leaves the seats on the default', async () => {
		process.env[STOP_POLICY_ENV] = 'strict-payment';
		const h = await boot();
		expect(h.logs.find((l) => l.evt === 'stop-policy-unknown')).toMatchObject({ name: 'strict-payment' });
		const { body } = await startMatch(h);
		expect(h.handle.matches.get(body.matchId as string)?.stopPolicy(0)).toEqual(DEFAULT_STOP_POLICY);
	});
});

/* ── A refusal a player can read, and a shutdown that says so (Wave 22 §E) ── */

describe('a match that is gone says so, in words', () => {
	it("answers a join for a match nobody has heard of with the outcome AND the sentence, not just 'unknown-match'", async () => {
		const h = await boot();
		const alice = await connect(h.port, edgeHeaders('alice'));
		const ack = (await alice.request('forge:join', { matchId: 'm-000000000000' })) as Record<string, unknown>;
		// `error` is unchanged, so anything that only reads it behaves as before…
		expect(ack.error).toBe('unknown-match');
		// …and the two new fields are what the client renders instead of the code.
		expect(ack.outcome).toBe('match-gone');
		expect(ack.message).toBe(socketMod.MATCH_GONE_WORDS);
		expect(String(ack.message)).toMatch(/restarted/);
		expect(h.logs.find((l) => l.evt === 'match-gone')).toMatchObject({ matchId: 'm-000000000000', event: 'join' });
	});

	it('says the same to a stranger asking after a match that has ENDED, and names the reason when there is one', async () => {
		const { h, matchId, alice, host } = await twoSeatsFor();
		await alice.request('forge:join', { matchId });
		host.exit('the JVM exited (code 1, signal null); see /tmp/x/bridge.stderr.txt');
		await waitUntil(() => h.handle.matches.get(matchId)?.status === 'failed', 'the match to fail');

		// The seat that was playing still gets its board back, with the notice.
		expect(await alice.request('forge:resync', { matchId })).toMatchObject({ matchId, seat: 0 });
		// Anyone else is told it is gone, with the cause and no server path in it.
		const carol = await connect(h.port, edgeHeaders('carol'));
		const ack = (await carol.request('forge:join', { matchId })) as Record<string, unknown>;
		expect(ack).toMatchObject({ error: 'unknown-match', outcome: 'match-gone' });
		expect(String(ack.message)).toContain('code 1');
		expect(String(ack.message)).not.toContain('bridge.stderr.txt');
	});

	async function twoSeatsFor(): Promise<{ h: Harness; matchId: string; alice: Peer; host: ReplayHost }> {
		const h = await boot();
		const { body } = await startMatch(h);
		const alice = await connect(h.port, edgeHeaders('alice'));
		return { h, matchId: body.matchId as string, alice, host: h.hosts[0] as ReplayHost };
	}
});

describe('shutdown', () => {
	it('refuses a new match in a sentence, and tells the seats of one that cannot outlive the server', async () => {
		const h = await boot();
		const { body } = await startMatch(h);
		const matchId = body.matchId as string;
		const alice = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));
		await alice.request('forge:join', { matchId });
		await bob.request('forge:join', { matchId });
		const mark = { alice: alice.frames.length, bob: bob.frames.length };

		// The replay host's Forge dies with this process — it has no `handOver` —
		// so this match is in the `ended` half and its seats are owed words.
		const outcome = h.handle.shutdown('The server is restarting for a deploy.');
		// `reaped` is empty because a `ReplayHost` factory has no `reapOnExit` — it
		// runs no JVM to reap. `host.test.ts` is where that half is proved.
		expect(outcome).toEqual({ handed: [], ended: [matchId], reaped: { killed: [], kept: [], left: [] } });

		await waitUntil(() => alice.frames.length > mark.alice && bob.frames.length > mark.bob, 'the ending notice at both seats');
		for (const [peer, from] of [
			[alice, mark.alice],
			[bob, mark.bob],
		] as const) {
			const notice = peer.frames.slice(from).map((f) => (f as { frame: { method?: string; message?: string } }).frame);
			expect(notice.map((f) => f.method)).toContain('showErrorDialog');
			expect(notice.find((f) => f.method === 'showErrorDialog')?.message).toBe('The server is restarting for a deploy.');
		}
		expect(h.handle.matches.get(matchId)?.status).toBe('stopped');

		// And nothing new is started by a process on its way out.
		const res = await fetch(`http://127.0.0.1:${h.port}/api/play/matches`, {
			method: 'POST',
			headers: { ...edgeHeaders('carol'), 'content-type': 'application/json' },
			body: '{}',
		});
		expect(res.status).toBe(503);
		expect((await res.json()) as { error: string }).toEqual({ error: 'The server is restarting for a deploy.' });
	});

	/**
	 * The half lane U found missing. `MatchRegistry.handOver` only CONSIDERS a
	 * match that is `starting` or `running`, so a game that had already finished —
	 * status `over`, where it waits out `overGraceMs`, ten minutes — was in
	 * neither the handed list nor the ending list, and `shutdown` never called
	 * `stop()` on it. Its Forge JVM was therefore never even TOLD to go, which is
	 * why the record lane S found carried no `orphanedAt`: the server had neither
	 * handed it over nor asked it to stop.
	 */
	it("stops a match that had already FINISHED, which handOver() does not even consider — it was the leak's first half", async () => {
		const h = await boot();
		const { body } = await startMatch(h);
		const matchId = body.matchId as string;
		const host = h.hosts[0] as ReplayHost;
		const alice = await connect(h.port, edgeHeaders('alice'));
		await alice.request('forge:join', { matchId });

		host.push({ t: 'gameover', winner: 'Seat 1' });
		await waitUntil(() => h.handle.matches.get(matchId)?.status === 'over', 'the game to finish');
		expect(host.stopped).toBe(false);

		const outcome = h.handle.shutdown('The server is restarting for a deploy.');
		expect(outcome.handed).toEqual([]);
		expect(outcome.ended).toEqual([matchId]);
		// The point: something asked its host to stop. Before lane U nothing did.
		expect(host.stopped).toBe(true);
		expect(h.handle.matches.get(matchId)?.status).toBe('stopped');
	});
});

/*
 * Wave 31 §S: one controlling socket per seat. A second browser on an account
 * that holds a seat is a SPECTATOR — *"it would be really messy if two clients
 * were capable of performing game actions"*. The server enforces; the client
 * is only told (`forge:role`).
 */
describe('a second connection for a seat spectates', () => {
	async function aliceTwice(options: { disconnectGraceMs?: number } = {}): Promise<{
		h: Harness;
		matchId: string;
		first: Peer;
		second: Peer;
		host: ReplayHost;
		callId: string;
	}> {
		const h = await boot(options);
		const { body } = await startMatch(h);
		const matchId = body.matchId as string;
		const first = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));
		await first.request('forge:join', { matchId });
		await bob.request('forge:join', { matchId });
		const second = await connect(h.port, edgeHeaders('alice'));
		const joined = (await second.request('forge:join', { matchId })) as { seat: number };
		expect(joined.seat).toBe(0);
		const host = h.hosts[0] as ReplayHost;
		host.push(PROBE_ASK);
		await waitUntil(() => second.frames.some((f) => (f as { frame: { kind: string } }).frame.kind === 'ask'), 'the ask on both sockets');
		return { h, matchId, first, second, host, callId: (PROBE_ASK.frame as { callId: string }).callId };
	}

	it('tells each socket its role, on every join and resync', async () => {
		const { matchId, first, second } = await aliceTwice();
		await waitUntil(() => first.roles.length > 0 && second.roles.length > 0, 'both roles');
		expect(first.roles).toEqual([{ matchId, role: 'player' }]);
		expect(second.roles).toEqual([{ matchId, role: 'spectator' }]);
		await second.request('forge:resync', { matchId });
		await waitUntil(() => second.roles.length > 1, 'the resync to be told');
		expect(second.roles[1]).toEqual({ matchId, role: 'spectator' });
	});

	it('refuses a spectator’s answers, full control and stop preference — and logs c2s-spectator', async () => {
		const { h, matchId, first, second, host, callId } = await aliceTwice();
		const answer = { kind: 'reply', callId, method: 'showConfirmDialog', result: true };
		second.send({ matchId, frame: answer });
		second.setFullControl({ matchId, on: true });
		second.setStopPreference({ matchId, type: 'stopPreference', stopAtEndStep: true });
		await waitUntil(() => h.logs.filter((l) => l.evt === 'c2s-spectator').length === 3, 'three refusals');
		expect(h.logs.filter((l) => l.evt === 'c2s-spectator').map((l) => l.input)).toEqual(['c2s', 'full-control', 'stop-preference']);
		expect(host.commands).toEqual([]);
		expect(h.handle.matches.get(matchId)?.fullControl(0)).toBe(false);
		expect(h.handle.matches.get(matchId)?.stopPolicy(0)).toEqual(DEFAULT_STOP_POLICY);

		// The controller still can.
		first.send({ matchId, frame: answer });
		await waitUntil(() => host.commands.length > 0, 'the controller’s reply');
		expect(host.commands).toEqual([{ t: 'reply', seat: 0, callId, result: true }]);
	});

	it('a spectator whose controller never leaves stays refused', async () => {
		const { h, matchId, second, host, callId } = await aliceTwice();
		await new Promise((r) => setTimeout(r, 300));
		second.send({ matchId, frame: { kind: 'reply', callId, method: 'showConfirmDialog', result: true } });
		await waitUntil(() => h.logs.some((l) => l.evt === 'c2s-spectator'), 'the refusal');
		expect(host.commands).toEqual([]);
		expect(second.roles.every((r) => (r as { role: string }).role === 'spectator')).toBe(true);
	});

	it('promotes the spectator when the controller leaves: told, re-sent its asks, and able to act', async () => {
		const { h, matchId, first, second, host, callId } = await aliceTwice({ disconnectGraceMs: 1000 });
		const framesBefore = second.frames.length;
		first.socket.disconnect();
		await waitUntil(() => h.logs.some((l) => l.evt === 'spectator-promoted'), 'the promotion');
		await waitUntil(() => second.roles.some((r) => (r as { role: string }).role === 'player'), 'the role event');
		expect(second.roles.at(-1)).toEqual({ matchId, role: 'player' });
		await waitUntil(
			() => second.frames.slice(framesBefore).some((f) => (f as { frame: { callId?: string } }).frame.callId === callId),
			'the ask to be re-sent',
		);
		second.send({ matchId, frame: { kind: 'reply', callId, method: 'showConfirmDialog', result: true } });
		await waitUntil(() => host.commands.length > 0, 'the promoted socket’s reply');
		expect(host.commands).toEqual([{ t: 'reply', seat: 0, callId, result: true }]);
	});

	it('a refresh never locks the player out: the new tab spectates, the old one leaves, the new one is promoted', async () => {
		const h = await boot({ disconnectGraceMs: 1000 });
		const { body } = await startMatch(h);
		const matchId = body.matchId as string;
		const host = h.hosts[0] as ReplayHost;
		const oldTab = await connect(h.port, edgeHeaders('alice'));
		const bob = await connect(h.port, edgeHeaders('bob'));
		await oldTab.request('forge:join', { matchId });
		await bob.request('forge:join', { matchId });

		// The new socket opens BEFORE the old one's disconnect lands.
		const newTab = await connect(h.port, edgeHeaders('alice'));
		await newTab.request('forge:join', { matchId });
		await waitUntil(() => newTab.roles.length > 0, 'the new tab’s role');
		expect(newTab.roles[0]).toEqual({ matchId, role: 'spectator' });

		oldTab.socket.disconnect();
		await waitUntil(() => newTab.roles.some((r) => (r as { role: string }).role === 'player'), 'the new tab to be promoted');

		host.push(PROBE_ASK);
		const callId = (PROBE_ASK.frame as { callId: string }).callId;
		await waitUntil(() => newTab.frames.some((f) => (f as { frame: { kind: string } }).frame.kind === 'ask'), 'the ask');
		newTab.send({ matchId, frame: { kind: 'reply', callId, method: 'showConfirmDialog', result: true } });
		await waitUntil(() => host.commands.length > 0, 'the refreshed tab’s reply');
		expect(host.commands).toEqual([{ t: 'reply', seat: 0, callId, result: true }]);
	});
});

describe('POST /api/play/matches names (wave 31 §S)', () => {
	it('uses them as the Forge players’ names, sanitised, unique, and falls back to Seat N', () => {
		const named = parseStartBody({ opponent: 'human', names: ['  Had\u0000oku <b>the</b>\n  Great  ', 'hadoku the great'] });
		expect(named.ok).toBe(true);
		if (!named.ok) return;
		expect(named.spec.seats.map((s) => s.name)).toEqual(['Hadoku the Great', 'hadoku the great 2']);

		const half = parseStartBody({ names: ['Ann', undefined] });
		expect(half.ok && half.spec.seats.map((s) => s.name)).toEqual(['Ann', 'Seat 2']);
		const ai = parseStartBody({ opponent: 'ai', names: ['Ann', null] });
		expect(ai.ok && ai.spec.seats.map((s) => s.name)).toEqual(['Ann', 'Forge AI']);
		const blank = parseStartBody({ names: ['   ', '<i></i>'] });
		expect(blank.ok && blank.spec.seats.map((s) => s.name)).toEqual(['Seat 1', 'Seat 2']);
	});

	it('caps a name at 24 characters, including the uniqueness suffix', () => {
		const long = 'x'.repeat(40);
		const r = parseStartBody({ names: [long, long] });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const [a, b] = r.spec.seats.map((s) => s.name);
		expect(a).toHaveLength(24);
		expect(b).toHaveLength(24);
		expect(b?.endsWith(' 2')).toBe(true);
		expect(a).not.toBe(b);
	});

	it('refuses a names value that is not a pair', () => {
		expect(parseStartBody({ names: ['only one'] })).toEqual({ ok: false, error: 'names is a two-element array' });
	});

	it('reaches forge:seats as name, only for a seat that was named', async () => {
		const h = await boot();
		const { body } = await startMatch(h, 'alice', { opponent: 'human', names: ['Hadoku', undefined] });
		const matchId = body.matchId as string;
		const alice = await connect(h.port, edgeHeaders('alice'));
		await alice.request('forge:join', { matchId });
		await waitUntil(() => alice.seatsEvents.length > 0, 'forge:seats');
		const seats = (alice.seatsEvents[0] as { seats: Record<string, unknown>[] }).seats;
		expect(seats[0]?.name).toBe('Hadoku');
		expect('name' in (seats[1] as object)).toBe(false);
		expect(h.hosts[0]?.spec.seats.map((s) => s.name)).toEqual(['Hadoku', 'Seat 2']);
	});
});

describe('parseStartBody: scenario (wave 33 §S, shape 1)', () => {
	it('carries the text onto the spec unchanged', () => {
		const r = parseStartBody({ scenario: 'humanlife=20\nailife=5\n' });
		expect(r.ok && r.spec.scenario).toBe('humanlife=20\nailife=5\n');
	});

	it('is absent on the spec when the body has none', () => {
		const r = parseStartBody({});
		expect(r.ok && 'scenario' in r.spec).toBe(false);
	});

	it('refuses an empty scenario, a non-string one, and one over 64 KiB', () => {
		expect(parseStartBody({ scenario: '' }).ok).toBe(false);
		expect(parseStartBody({ scenario: 7 }).ok).toBe(false);
		expect(parseStartBody({ scenario: 'x'.repeat(64 * 1024 + 1) }).ok).toBe(false);
	});

	it('is still an unknown field alongside everything else parseStartBody refuses', () => {
		expect(parseStartBody({ scenario: 'ok', bogus: 1 })).toEqual({ ok: false, error: 'unknown field bogus' });
	});
});
