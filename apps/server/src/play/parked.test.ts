/**
 * Park and resume: the registry letting go of a match that ended (and what it keeps of one), the
 * parked store on disk, and the routes a player resumes from — end to end on a real lobby, a real
 * `attachPlay` over socket.io, and matches whose Forge is the recorded transcript (`ReplayHost`).
 */

import express from 'express';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

import type { MatchSpec } from './host.js';
import type { BridgeLine } from './bridge-protocol.js';
import { loadTranscript, replayFactory, type ReplayHost } from './fixtures/transcript.js';
import { createMatchRegistry, type Match } from './match.js';
import { ENDED_KEPT, restoredSpec } from './match/registry.js';
import { openParkedStore, type ParkedStore, type ParkedStoreDeps } from './parked.js';
import { identityFromHeaders } from '../room/identity.js';
import type { Lobby } from '../room/lobby.js';

/**
 * A real parked file, sanitized (`fixtures/parked.sample.json`'s own header note at the point it
 * is read, below, says what changed): `michael` → `A`, the real owner id → the fixture convention's
 * `fk:aaaa…`, the room's junk name → `Test game`. The decks' own `Pilot=`/`Comment=` credits
 * (`Patxi`, `ATmagic`) are public mtgtop8.com handles the deck data already carries everywhere
 * else in this repo, not this app's own users, so nothing there needed scrubbing.
 */
const PARKED_SAMPLE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'parked.sample.json');
const EDGE_SECRET = 'test-edge-auth-secret';
const TRANSCRIPT = loadTranscript();
const OPENING = TRANSCRIPT.slice(0, TRANSCRIPT.findIndex((l) => l.t === 'frame' && (l.frame as { kind: string }).kind === 'ask'));
const SNAPSHOT = { t: 'snapshot', turn: 4, state: 'turn=4\nactiveplayer=p1\nactivephase=UNTAP\nactivephaseadvance=UPKEEP\np0life=12\n', ms: 2 } as const satisfies BridgeLine;
const DECK = (name: string): string => `[metadata]\nName=${name}\n[main]\n20 Mountain\n`;
const TWO_HUMANS: MatchSpec = { seats: [{ name: 'alice', ai: false, deck: DECK('Burn') }, { name: 'bob', ai: false, deck: DECK('Ramp') }], format: 'free' };

let socketMod: typeof import('./socket.ts');
let edgeMod: typeof import('../edge-auth.ts');
let lobbyMod: typeof import('../room/lobby.ts');
let parkedRoutesMod: typeof import('../http/parked.ts');

beforeAll(async () => {
	// config.ts reads the environment once, at load — see room/socket.test.ts.
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	socketMod = await import('./socket.ts');
	edgeMod = await import('../edge-auth.ts');
	lobbyMod = await import('../room/lobby.ts');
	parkedRoutesMod = await import('../http/parked.ts');
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'cardtable-parked-'));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function edgeHeaders(user: string): Record<string, string> {
	return { 'x-edge-auth': EDGE_SECRET, 'x-hadoku-tier': 'friend', 'x-user-id': `user-${user}`, 'x-user-key': `friend-key-${user}`, 'x-user-name': user };
}
const idOf = (user: string): string => identityFromHeaders(edgeHeaders(user), 'test');

async function waitUntil(predicate: () => boolean, label: string, timeout = 5000): Promise<void> {
	await vi.waitFor(
		() => {
			if (!predicate()) throw new Error(`timed out waiting for ${label}`);
		},
		{ timeout, interval: 5 },
	);
}

/* ── The registry ────────────────────────────────────────────────────── */

describe('the registry lets go of a match that ended', () => {
	function registry(overGraceMs = 60_000) {
		const { factory, hosts } = replayFactory();
		const logs: Record<string, unknown>[] = [];
		const freed: string[] = [];
		const r = createMatchRegistry({ host: factory, log: (e) => logs.push(e), overGraceMs, emit: () => undefined, freed: (m) => freed.push(m.id) });
		return { r, hosts, logs, freed };
	}

	it('a stopped match: gone from get, kept by find as what its readers ask — status, seats, decks — with no game under way', () => {
		const { r, hosts, freed } = registry();
		const match = r.create({ ...TWO_HUMANS, scenario: 'turn=1\n' });
		match.claim('fk:aaaaaaaaaaaaaaaa');
		(hosts[0] as ReplayHost).push(...OPENING);
		match.stop();
		expect(r.get(match.id)).toBeUndefined();
		const ended = r.find(match.id);
		expect(ended).not.toBe(match);
		expect(ended).toMatchObject({ id: match.id, status: 'stopped', failure: null, winner: null });
		expect(ended?.seats.map((s) => s.owner)).toEqual(['fk:aaaaaaaaaaaaaaaa', null]);
		expect(ended?.seatOf('fk:aaaaaaaaaaaaaaaa')).toBe(0);
		expect(ended?.spec.seats.map((s) => s.deck)).toEqual([DECK('Burn'), DECK('Ramp')]);
		expect(ended?.spec, 'a board is the parked record’s to keep, not the tombstone’s').not.toHaveProperty('scenario');
		expect(ended?.live()).toBeNull();
		expect(freed).toEqual([match.id]);
		expect(r.active()).toEqual([]);
	});

	it('a finished match is let go of when its grace ends and its JVM exits, not at game over', () => {
		const { r, hosts } = registry();
		const match = r.create(TWO_HUMANS);
		const host = hosts[0] as ReplayHost;
		host.push(...OPENING, { t: 'gameover', winner: 'alice' });
		expect(r.get(match.id)?.status).toBe('over');
		host.exit('stopped');
		expect(r.get(match.id)).toBeUndefined();
		expect(r.find(match.id)?.status).toBe('stopped');
		expect(r.find(match.id)?.winner).toBe('alice');
	});

	it('a failed match stays held, and restorable, for the over grace; then it is let go of', () => {
		vi.useFakeTimers();
		const { r, hosts } = registry(10_000);
		const match = r.create(TWO_HUMANS);
		(hosts[0] as ReplayHost).push(...OPENING);
		(hosts[0] as ReplayHost).exit('the JVM exited (code null, signal SIGKILL)');
		expect(r.get(match.id)?.status).toBe('failed');
		vi.advanceTimersByTime(9_999);
		expect(r.get(match.id)).toBe(match);
		vi.advanceTimersByTime(1);
		expect(r.get(match.id)).toBeUndefined();
		expect(r.find(match.id)).toMatchObject({ status: 'failed', failure: expect.stringContaining('SIGKILL') });
	});

	it('a restore’s old match stopping lets go of nothing: the restored one is the match now', () => {
		const { r, hosts, freed } = registry();
		const match = r.create(TWO_HUMANS);
		(hosts[0] as ReplayHost).push(...OPENING, SNAPSHOT);
		const restored = r.restore(match.id);
		expect(match.status).toBe('stopped');
		expect(r.get(match.id)).toBe(restored?.match);
		expect(freed).toEqual([]);
	});

	it('keeps only the newest ENDED_KEPT', () => {
		const { r } = registry();
		const ids = Array.from({ length: ENDED_KEPT + 1 }, () => {
			const m = r.create(TWO_HUMANS);
			m.stop();
			return m.id;
		});
		expect(r.find(ids[0]!)).toBeUndefined();
		expect(r.find(ids[1]!)?.status).toBe('stopped');
		expect(r.find(ids.at(-1)!)?.status).toBe('stopped');
	});

	it('creates a resumed game on its snapshot’s board, its seats already held and its clock where it was left', () => {
		const { r, hosts } = registry();
		const from = { owners: ['fk:aaaaaaaaaaaaaaaa', null], snapshot: { turn: 4, state: SNAPSHOT.state }, clockMs: [30_000, 40_000] as [number, number] };
		const match = r.create({ ...TWO_HUMANS, chooser: 1 }, from);
		expect((hosts[0] as ReplayHost).spec).toEqual(restoredSpec(TWO_HUMANS, from.snapshot));
		expect(match.owners()).toEqual(['fk:aaaaaaaaaaaaaaaa', null]);
		expect(match.latestSnapshot).toEqual(from.snapshot);
		// `ParkedRecord.snapshot` — the value a resume hands `create` as `from.snapshot` — is Forge's
		// checkpoint: it reaches the resumed match as `latestCheckpoint` too, through `restore.checkpoint`.
		expect(match.latestCheckpoint).toEqual(from.snapshot);
		expect(match.clockLeft()).toEqual([30_000, 40_000]);
		expect(match.claim('fk:bbbbbbbbbbbbbbbb')).toMatchObject({ ok: true, seat: 1 });
		expect(match.claim('fk:cccccccccccccccc')).toEqual({ ok: false, error: 'match-full' });
	});
});

/* ── The store ───────────────────────────────────────────────────────── */

type StoreRoom = NonNullable<ReturnType<ParkedStoreDeps['roomOf']>>;
const ROOM: StoreRoom = {
	id: 'r-00000001',
	name: 'Friday night',
	gameType: 'constructed-1v1',
	game: { format: 'free', mode: 'classic', modeOptions: {}, clientMode: 'builtin', draftStartedAt: null, pod: null },
	settings: { handSmoothing: false, tournament: false, tournamentDecks: 'locked', clock: 'on', pickTimer: { on: false, speed: 1 } },
	testing: false,
	members: [
		{ id: 'fk:aaaaaaaaaaaaaaaa', name: 'Alice', joinedAt: '', ready: false },
		{ id: 'fk:bbbbbbbbbbbbbbbb', name: 'Bob', joinedAt: '', ready: false },
	],
} as StoreRoom;

describe('the parked store', () => {
	function running(spec: MatchSpec = TWO_HUMANS, snapshot = true): Match {
		const { factory, hosts } = replayFactory();
		// A still clock: the seats' time left is what the record says, to the millisecond.
		const r = createMatchRegistry({ host: factory, log: () => undefined, overGraceMs: 60_000, emit: () => undefined, now: () => 1_000 });
		const match = r.create({ ...spec, clockMs: [60_000, 60_000] });
		match.claim('fk:aaaaaaaaaaaaaaaa');
		match.claim('fk:bbbbbbbbbbbbbbbb');
		(hosts[0] as ReplayHost).push(...OPENING, ...(snapshot ? [SNAPSHOT] : []));
		return match;
	}

	function store(dir: string, room: StoreRoom | null = ROOM) {
		const logs: Record<string, unknown>[] = [];
		const s = openParkedStore({ dir, log: (e) => logs.push(e), roomOf: () => room ?? undefined, formatName: (p) => `pool ${p}`, pin: 'abc1234', now: () => Date.parse('2026-11-02T12:00:00Z') });
		return { s, logs };
	}

	it("deletes every parked game a person held a seat in, from disk too, on their account's erase", () => {
		const dir = tempDir();
		const { s } = store(dir);
		const record = s.park(running());
		expect(record).not.toBeNull();
		expect(s.forget('fk:cccccccccccccccc')).toBe(0);
		expect(s.forget('fk:aaaaaaaaaaaaaaaa')).toBe(1);
		expect(s.listFor('fk:bbbbbbbbbbbbbbbb')).toEqual([]);
		expect(readdirSync(dir)).toEqual([]);
		expect(store(dir).s.listFor('fk:bbbbbbbbbbbbbbbb')).toEqual([]);
		expect(s.forget('fk:aaaaaaaaaaaaaaaa')).toBe(0);
	});

	it('parks a running game: its room, seats, decks, snapshot, clock and pin, written atomically and listed for each player', () => {
		const dir = tempDir();
		const { s } = store(dir);
		const match = running({ ...TWO_HUMANS, scenario: 'turn=2\n', skipOpening: true, restore: true });
		const record = s.park(match);
		expect(record).toMatchObject({
			matchId: match.id,
			room: { id: ROOM.id, name: 'Friday night', format: 'free', mode: { mode: 'classic', modeOptions: {} }, settings: { clock: 'on' } },
			seats: [
				{ ai: false, owner: 'fk:aaaaaaaaaaaaaaaa', name: 'Alice', deckName: 'Burn' },
				{ ai: false, owner: 'fk:bbbbbbbbbbbbbbbb', name: 'Bob', deckName: 'Ramp' },
			],
			format: 'free',
			formatName: 'pool free',
			turn: 4,
			pin: 'abc1234',
			parkedAt: '2026-11-02T12:00:00.000Z',
			snapshot: { turn: 4, state: SNAPSHOT.state },
			clockMs: [60_000, 60_000],
		});
		expect(record?.spec, 'the opening a resume adds back goes').toEqual({ ...TWO_HUMANS, clockMs: [60_000, 60_000] });
		expect(readdirSync(dir)).toEqual([`${match.id}.json`]);
		expect(JSON.parse(readFileSync(join(dir, `${match.id}.json`), 'utf8'))).toEqual(record);
		expect(s.listFor('fk:bbbbbbbbbbbbbbbb').map((g) => g.matchId)).toEqual([match.id]);
		expect(s.listFor('fk:cccccccccccccccc')).toEqual([]);
		expect(s.listFor('fk:aaaaaaaaaaaaaaaa')[0]).not.toHaveProperty('snapshot');

		const reopened = store(dir).s;
		expect(reopened.get(match.id)).toEqual(record);
	});

	/**
	 * Persisted records decode old files: this decodes a real, sanitized parked record
	 * (`fixtures/parked.sample.json`, above `PARKED_SAMPLE`'s own doc), written by a server before
	 * checkpoint parking existed, exactly as it is on disk — never hand-typed.
	 */
	it('decodes a real parked file written before checkpoint parking existed', () => {
		const dir = tempDir();
		const matchId = 'm-cdb6dd6c983a';
		writeFileSync(join(dir, `${matchId}.json`), readFileSync(PARKED_SAMPLE, 'utf8'));
		const { s } = store(dir);
		const record = s.get(matchId);
		expect(record).toMatchObject({
			matchId,
			room: { id: 'r-d15770389b2d', name: 'Test game', format: '2025-06-30' },
			seats: [
				{ ai: false, owner: 'fk:aaaaaaaaaaaaaaaa', name: 'A', deckName: 'Dimir Aggro (Patxi)' },
				{ ai: true, owner: null, name: 'Recluse', deckName: 'Mono Green Aggro (ATmagic)' },
			],
			format: '2025-06-30',
			formatName: 'Standard (2025-06-30)',
			turn: 8,
			pin: '47dd04f8608f05144aa32d2524a29aedb8a2bd62',
		});
		expect(record?.snapshot).toMatchObject({ turn: 8 });
		expect(record?.spec.seats).toHaveLength(2);
		expect(s.listFor('fk:aaaaaaaaaaaaaaaa')).toEqual([expect.objectContaining({ matchId, turn: 8 })]);
	});

	it('does not park a game with nothing to go back to, or one a resume would report differently', () => {
		const dir = tempDir();
		const { s, logs } = store(dir);
		expect(s.park(running(TWO_HUMANS, false))).toBeNull();
		expect(store(dir, null).s.park(running())).toBeNull();
		expect(store(dir, { ...ROOM, testing: true }).s.park(running())).toBeNull();
		const over = running();
		over.stop();
		expect(s.park(over)).toBeNull();
		expect(readdirSync(dir)).toEqual([]);
		expect(logs.map((l) => l.reason)).toEqual(['it was left before its first turn began', 'it is stopped']);
	});

	it('a resumed game parked again supersedes its record; one played to the end removes it', () => {
		const dir = tempDir();
		const { s } = store(dir);
		const first = running();
		s.park(first);
		const second = running();
		expect(s.resumed(first.id, { roomId: 'r-00000002', tableId: 't-00000002', matchId: second.id })).toBe(true);
		expect(s.listFor('fk:aaaaaaaaaaaaaaaa')[0]?.resumedAs).toMatchObject({ roomId: 'r-00000002', matchId: second.id });
		s.park(second);
		expect(s.listFor('fk:aaaaaaaaaaaaaaaa').map((g) => g.matchId)).toEqual([second.id]);
		expect(s.get(first.id)).toBeNull();

		const third = running();
		s.resumed(second.id, { roomId: 'r-00000003', tableId: 't-00000003', matchId: third.id });
		s.finished(third.id);
		expect(s.listFor('fk:aaaaaaaaaaaaaaaa')).toEqual([]);
		expect(readdirSync(dir)).toEqual([]);
	});

	it('skips a file it cannot read, and says so', () => {
		const dir = tempDir();
		writeFileSync(join(dir, 'm-0123456789ab.json'), '{"v":1');
		writeFileSync(join(dir, 'notes.txt'), 'not a record');
		const { s, logs } = store(dir);
		expect(s.listFor('fk:aaaaaaaaaaaaaaaa')).toEqual([]);
		expect(logs).toEqual([expect.objectContaining({ evt: 'parked-unreadable', matchId: 'm-0123456789ab' })]);
	});
});

/* ── The routes ──────────────────────────────────────────────────────── */

interface Stack {
	origin: string;
	hosts: ReplayHost[];
	handle: import('./socket.ts').PlayHandle;
	lobby: Lobby;
	store: ParkedStore;
	logs: Record<string, unknown>[];
}

async function stack(): Promise<Stack> {
	const { factory, hosts } = replayFactory();
	const logs: Record<string, unknown>[] = [];
	const lobby = await lobbyMod.openLobby({ dir: tempDir(), defaultFormat: 'free' });
	const store = openParkedStore({ dir: tempDir(), log: (e) => logs.push(e), roomOf: (id) => lobby.roomOfMatch(id), formatName: (p) => p, pin: null });
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json());
	app.use('/api', api);
	const http = createServer(app);
	const io = new SocketIOServer(http, { serveClient: false });
	const handle = socketMod.attachPlay(io, api, {
		minTier: 'friend',
		host: factory,
		log: (e) => logs.push(e),
		startTimeoutMs: 2000,
		joinWaitMs: 1000,
		disconnectGraceMs: 20,
		// Long enough for a test's own joins to land first on a loaded runner.
		rejoinGraceMs: 1000,
		onAbandoned: (m) => store.park(m),
		onGameOver: (m) => store.finished(m.id),
	});
	parkedRoutesMod.attachParked(api, { store, lobby, play: () => handle, log: (e) => logs.push(e), resumeRateLimit: null });
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	cleanups.push(async () => {
		handle.close();
		io.close();
		await new Promise<void>((done) => http.close(() => done()));
	});
	return { origin: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, hosts, handle, lobby, store, logs };
}

async function send(s: Stack, user: string, method: 'GET' | 'POST', path: string): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(`${s.origin}/api${path}`, { method, headers: { ...edgeHeaders(user), 'content-type': 'application/json' } });
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function joinMatch(s: Stack, user: string, matchId: string): Promise<ClientSocket> {
	const socket = ioClient(s.origin, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: edgeHeaders(user) });
	cleanups.push(() => void socket.disconnect());
	await new Promise<void>((done, fail) => {
		socket.once('connect', () => done());
		socket.once('connect_error', fail);
	});
	await socket.timeout(2000).emitWithAck('forge:join', { matchId });
	return socket;
}

/** A room game between alice and bob, both seated and gone, parked at turn 4. */
async function parkedGame(s: Stack): Promise<string> {
	const caller = (user: string) => ({ id: idOf(user), name: user, userId: `user-${user}` });
	const made = s.lobby.create(caller('alice'), { name: 'Friday night', gameType: 'constructed-1v1', clientMode: 'builtin' });
	if (!made.ok) throw new Error('no room');
	s.lobby.join(made.room.id, caller('bob'));
	const started = s.handle.start({ headers: edgeHeaders('alice') } as never, TWO_HUMANS, [idOf('alice')]);
	await waitUntil(() => s.hosts.length > 0, 'the host');
	(s.hosts.at(-1) as ReplayHost).push(...OPENING);
	const outcome = await started;
	if (!outcome.ok) throw new Error(outcome.error);
	const { match } = outcome;
	s.lobby.setTableMatch(made.room.id, made.room.tables[0]!.id, match.id);
	const sockets = [await joinMatch(s, 'alice', match.id), await joinMatch(s, 'bob', match.id)];
	(s.hosts.at(-1) as ReplayHost).push(SNAPSHOT);
	for (const socket of sockets) socket.disconnect();
	await waitUntil(() => s.store.get(match.id) !== null && s.handle.matches.get(match.id) === undefined, 'the game to be parked and let go of');
	return match.id;
}

describe('the parked games’ routes', () => {
	it('lists a parked game for each of its players, with the other player, the decks, the turn and when', async () => {
		const s = await stack();
		const matchId = await parkedGame(s);
		const listed = await send(s, 'bob', 'GET', '/play/parked');
		expect(listed.status).toBe(200);
		expect(listed.body.games).toEqual([
			{
				matchId,
				room: 'Friday night',
				format: 'free',
				turn: 4,
				parkedAt: expect.any(String),
				seats: [
					{ name: 'alice', deck: 'Burn', ai: false, you: false },
					{ name: 'bob', deck: 'Ramp', ai: false, you: true },
				],
				resumed: null,
			},
		]);
		expect((await send(s, 'carol', 'GET', '/play/parked')).body.games).toEqual([]);
		expect((await send(s, 'carol', 'POST', `/play/parked/${matchId}/resume`)).status).toBe(404);
	});

	it('resumes into a new room with both players seated in the game’s order; the second player joins that room, not a copy', async () => {
		const s = await stack();
		const matchId = await parkedGame(s);
		const rooms = s.lobby.list().length;
		const resuming = send(s, 'bob', 'POST', `/play/parked/${matchId}/resume`);
		await waitUntil(() => s.hosts.length === 2, 'the resumed game’s host');
		const host = s.hosts[1] as ReplayHost;
		expect(host.spec).toMatchObject({ scenario: SNAPSHOT.state, restore: true, skipOpening: true });
		host.push(...OPENING);
		const resumed = await resuming;
		expect(resumed.status).toBe(201);
		const { roomId, tableId, matchId: newId } = resumed.body as { roomId: string; tableId: string; matchId: string };
		// Bob is at the table, so the game is not parked again under the assertions.
		await joinMatch(s, 'bob', newId);
		expect(s.lobby.list()).toHaveLength(rooms + 1);
		const room = s.lobby.get(roomId)!;
		expect(room).toMatchObject({ name: 'Friday night', leader: idOf('bob') });
		expect(room.members.map((m) => m.id).sort()).toEqual([idOf('alice'), idOf('bob')].sort());
		expect(s.lobby.seats(roomId, tableId).map((seat) => seat.memberId)).toEqual([idOf('alice'), idOf('bob')]);
		expect(room.tables[0]?.matchId).toBe(newId);
		expect(s.handle.matches.get(newId)?.owners()).toEqual([idOf('alice'), idOf('bob')]);

		const second = await send(s, 'alice', 'POST', `/play/parked/${matchId}/resume`);
		expect(second).toEqual({ status: 200, body: { roomId, tableId, matchId: newId } });
		expect(s.hosts).toHaveLength(2);
		expect(((await send(s, 'alice', 'GET', '/play/parked')).body.games as { resumed: unknown }[])[0]?.resumed).toEqual({ roomId, tableId });
	});

	it('a restore Forge refuses answers why, and leaves the record and the lobby as they were', async () => {
		const s = await stack();
		const matchId = await parkedGame(s);
		const rooms = s.lobby.list().length;
		const resuming = send(s, 'alice', 'POST', `/play/parked/${matchId}/resume`);
		await waitUntil(() => s.hosts.length === 2, 'the resumed game’s host');
		(s.hosts[1] as ReplayHost).push({ t: 'fatal', message: 'Puzzle: no card named Grizzly Bearz' });
		const refused = await resuming;
		expect(refused.status).toBe(500);
		expect(refused.body.error).toBe('This game could not be picked up again: Puzzle: no card named Grizzly Bearz');
		expect(s.lobby.list()).toHaveLength(rooms);
		expect(s.store.get(matchId)?.resumedAs).toBeUndefined();
		expect(((await send(s, 'alice', 'GET', '/play/parked')).body.games as unknown[]).length).toBe(1);
	});

	it('a resumed game abandoned again parks again in its place; one played to the end leaves the list', async () => {
		const s = await stack();
		const matchId = await parkedGame(s);
		const resuming = send(s, 'alice', 'POST', `/play/parked/${matchId}/resume`);
		await waitUntil(() => s.hosts.length === 2, 'the resumed game’s host');
		(s.hosts[1] as ReplayHost).push(...OPENING);
		const { matchId: secondId } = (await resuming).body as { matchId: string };
		// Nobody comes: it parks again, from the snapshot it opened on.
		await waitUntil(() => s.store.get(secondId) !== null, 'the resumed game to park again');
		expect(s.store.get(matchId)).toBeNull();
		expect(s.store.get(secondId)).toMatchObject({ turn: 4, seats: [{ owner: idOf('alice') }, { owner: idOf('bob') }] });

		const again = send(s, 'alice', 'POST', `/play/parked/${secondId}/resume`);
		await waitUntil(() => s.hosts.length === 3, 'the third game’s host');
		(s.hosts[2] as ReplayHost).push(...OPENING);
		const { matchId: thirdId } = (await again).body as { matchId: string };
		const sockets = [await joinMatch(s, 'alice', thirdId)];
		(s.hosts[2] as ReplayHost).push({ t: 'gameover', winner: 'alice' });
		// The host's line is handled asynchronously: read the list only once the game's end has
		// reached the parked store, or a loaded runner reads it a moment before.
		await waitUntil(() => s.logs.some((l) => l.evt === 'parked-finished'), 'the finished game to leave the parked list');
		expect(sockets).toHaveLength(1);
		expect((await send(s, 'alice', 'GET', '/play/parked')).body.games).toEqual([]);
		expect(s.logs.find((l) => l.evt === 'parked-finished')).toMatchObject({ matchId: secondId, as: thirdId });
	});
});
