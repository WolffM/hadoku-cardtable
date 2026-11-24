/**
 * The draft record (wave 127): a draft completed through the real socket and engine is written
 * once, with its cube, its seats' picks and its duration; the store counts it; an erase
 * anonymises a seat; a closed room's unfinished pod is kept as abandoned; and the backfill decides
 * a finished pod's source the way its header says, over cards reduced from prod's drafts.
 *
 * `config.ts` reads the environment once, at module load, so the state dir and the edge secret are
 * set before the modules under test are imported (as `room/socket.test.ts` does).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { DRAFT_CHANNEL, joinDraft, pickCard, safeParseServerMessage, type DraftCard, type DraftPlan, type DraftView, type PoolSource } from '@hadoku/shared';
import type { DraftState } from '@hadoku/draft';

import type { DraftFile, SourceList } from '../cli/backfill-draft-records.ts';
import type { DraftRecord } from './drafts.ts';

const EDGE_SECRET = 'test-edge-auth-secret';
const CUBE_ID = 'w127-fixture-cube';
const CUBE_NAME = 'W127 Fixture Cube';
const OWNER_USER = 'user-w127-owner';

let socketMod: typeof import('../room/socket.ts');
let roomsMod: typeof import('../room/draftRooms.ts');
let lobbyMod: typeof import('../room/lobby.ts');
let history: typeof import('./index.ts');
let eraseMod: typeof import('@hadoku/game-server/erase/index');
let eraseDrafts: typeof import('@hadoku/game-server/erase/drafts');
let backfill: typeof import('../cli/backfill-draft-records.ts');

let stateDir = '';
const dirs: string[] = [];
const saved = { state: process.env.CARDTABLE_STATE_DIR, secret: process.env.EDGE_AUTH_SECRET, insecure: process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH };

beforeAll(async () => {
	stateDir = await mkdtemp(join(tmpdir(), 'cardtable-history-test-'));
	dirs.push(stateDir);
	process.env.CARDTABLE_STATE_DIR = stateDir;
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	socketMod = await import('../room/socket.ts');
	roomsMod = await import('../room/draftRooms.ts');
	lobbyMod = await import('../room/lobby.ts');
	history = await import('./index.ts');
	eraseMod = await import('@hadoku/game-server/erase/index');
	eraseDrafts = await import('@hadoku/game-server/erase/drafts');
	backfill = await import('../cli/backfill-draft-records.ts');
}, 60_000);

afterAll(async () => {
	for (const [name, value] of [
		['CARDTABLE_STATE_DIR', saved.state],
		['EDGE_AUTH_SECRET', saved.secret],
		['CARDTABLE_INSECURE_NO_EDGE_AUTH', saved.insecure],
	] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A cube of plain cards, more than a pod of eight deals in three rounds. */
function fixtureCube(size: number, setCode = 'W27'): DraftCard[] {
	return Array.from({ length: size }, (_, i) => ({
		cardId: `w${i}`,
		name: `W127 Card ${i}`,
		manaCost: ['1'],
		manaValue: 1,
		colors: [],
		typeLine: 'Artifact',
		oracleText: '',
		setCode,
		collectorNumber: String(i),
		rarity: 'common',
	}));
}

const CUBE: PoolSource = { kind: 'cube', cubeId: CUBE_ID };
const PLAN: DraftPlan = { rounds: [CUBE, CUBE, CUBE] };

function resolver(cards: readonly DraftCard[]) {
	return { cards: () => cards, name: (src: PoolSource) => (src.kind === 'cube' ? CUBE_NAME : src.code) };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
	await vi.waitFor(
		async () => {
			if (!(await predicate())) throw new Error(`timed out waiting for ${label}`);
		},
		{ timeout: timeoutMs, interval: 5 },
	);
}

async function recordLines(dir: string): Promise<DraftRecord[]> {
	const text = await readFile(join(dir, 'drafts.jsonl'), 'utf8').catch(() => '');
	return text
		.split('\n')
		.filter((l) => l !== '')
		.map((l) => JSON.parse(l) as DraftRecord);
}

/* ── A draft completed through the socket ────────────────────────────── */

describe('a draft completed through the socket', () => {
	let http: HttpServer | null = null;
	let io: SocketIOServer | null = null;
	let close: (() => void) | null = null;
	let peer: ClientSocket | null = null;

	afterEach(async () => {
		peer?.disconnect();
		close?.();
		io?.close();
		if (http !== null) await new Promise<void>((done) => http!.close(() => done()));
	});

	it('writes one record naming its cube, every seat with 15 × 3 picks, and how long it took', { timeout: 60_000 }, async () => {
		const owner = { id: eraseMod.fkOf(OWNER_USER), name: 'w127 owner', userId: OWNER_USER };
		const lobbyDir = await mkdtemp(join(tmpdir(), 'cardtable-history-lobby-'));
		dirs.push(lobbyDir);
		const lobby = await lobbyMod.openLobby({ dir: lobbyDir });
		const made = lobby.create(owner, { name: 'w127 record', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error(`the lobby refused the room: ${made.reason}`);
		const roomId = made.room.id;
		for (let seat = 1; seat < 8; seat++) expect(lobby.aiSeat(roomId, owner.id, seat, true).ok).toBe(true);
		expect(lobby.setPodPlan(roomId, owner.id, PLAN, { ok: true, cards: 400 }).ok).toBe(true);
		expect(lobby.setReady(roomId, owner.id, true)).toBe(true);
		const started = lobby.startDraft(roomId, owner.id);
		if (!started.ok) throw new Error(`the lobby refused to start: ${started.reason}`);

		let rooms: ReturnType<typeof roomsMod.createDraftRooms>;
		const presence = socketMod.createSeatPresence({ seatReleaseMs: socketMod.SEAT_RELEASE_MS, draftGraceOf: (id) => rooms.find(id)?.app.disconnectGraceMs ?? 0 });
		rooms = roomsMod.createDraftRooms({ resolver: resolver(fixtureCube(400)), defaultPlan: PLAN, presence });
		rooms.setPodLookup((id) => lobby.podDraft(id));
		http = createServer();
		io = new SocketIOServer(http, { serveClient: false });
		const handle = socketMod.attachDraftSocket(io, { rooms, lobby, minTier: 'friend', log: () => {}, presence, rateLimit: { capacity: 100, refillAmount: 100, refillIntervalMs: 1 } });
		close = () => {
			handle.close();
			presence.dispose();
		};
		await new Promise<void>((done) => http!.listen(0, '127.0.0.1', done));
		const port = (http.address() as AddressInfo).port;

		const views: DraftView[] = [];
		peer = ioClient(`http://127.0.0.1:${port}`, {
			transports: ['polling'],
			extraHeaders: { 'x-edge-auth': EDGE_SECRET, 'x-hadoku-tier': 'friend', 'x-user-id': OWNER_USER, 'x-user-key': 'friend-key-w127' },
			forceNew: true,
			reconnection: false,
		});
		peer.on(DRAFT_CHANNEL.serverToClient, (payload: unknown) => {
			const parsed = safeParseServerMessage(payload);
			if (parsed.ok && (parsed.value.type === 'state' || parsed.value.type === 'update')) views.push(parsed.value.view);
		});
		await new Promise<void>((done, fail) => {
			peer!.on('connect', () => done());
			peer!.on('connect_error', fail);
		});
		peer.emit(DRAFT_CHANNEL.clientToServer, joinDraft(roomId));
		await waitUntil(() => views.length > 0, 'the owner to be seated');

		// The owner picks the first card of every pack; at `botPickMs: 0` the bots catch up within each pick.
		for (let picks = 0; picks < 45; picks++) {
			await waitUntil(() => views.at(-1)?.viewer.kind === 'seat' && (views.at(-1)!.viewer as { pack: DraftCard[] }).pack.length > 0, `pack ${picks + 1}`);
			const before = views.length;
			const pack = (views.at(-1)!.viewer as { pack: DraftCard[] }).pack;
			peer.emit(DRAFT_CHANNEL.clientToServer, pickCard(roomId, pack[0]!.cardId));
			await waitUntil(() => views.length > before, `pick ${picks + 1} to land`);
		}

		const dir = join(stateDir, 'history');
		await waitUntil(async () => (await recordLines(dir)).length > 0, 'the record to be written');
		const records = await recordLines(dir);
		expect(records).toHaveLength(1);
		const [record] = records as [DraftRecord];
		const room = rooms.find(roomId)!;
		expect(record).toMatchObject({ v: 1, draftId: roomId, roomId, pod: null, eventId: `${roomId}-${Date.parse(lobby.get(roomId)!.game!.draftStartedAt!)}`, outcome: 'complete', startedAt: room.createdAt });
		expect(record.rounds).toEqual([0, 1, 2].map(() => ({ kind: 'cube', cubeId: CUBE_ID, name: CUBE_NAME, origin: 'shortlist' })));
		expect(record.seats).toHaveLength(8);
		expect(record.seats.map((s) => s.picks)).toEqual(Array(8).fill(15 * 3));
		expect(record.seats[0]).toEqual({ kind: 'user', userId: OWNER_USER, displayName: 'w127 owner', picks: 45 });
		expect(record.seats.slice(1).every((s) => s.kind === 'bot' && s.userId === null)).toBe(true);
		expect(record.eventId).toMatch(/^r-[0-9a-f]+-\d{13}$/);
		expect(roomsMod.stateOf(room).status).toBe('complete');
		expect(record.durationMs).toBe(record.endedAt - record.startedAt);
		expect(record.backfilled).toBeUndefined();
		expect(history.draftRecordStore().countBySource().get(`cube:${CUBE_ID}`)).toEqual({ drafts: 1, lastAt: record.endedAt });
	});
});

/* ── The store ───────────────────────────────────────────────────────── */

function record(over: Partial<DraftRecord> & Pick<DraftRecord, 'draftId'>): DraftRecord {
	return {
		v: 1,
		roomId: over.draftId,
		pod: null,
		eventId: null,
		rounds: [0, 1, 2].map(() => ({ kind: 'cube', cubeId: CUBE_ID, name: CUBE_NAME, origin: 'shortlist' }) as const),
		seats: [
			{ kind: 'user', userId: 'u-alice', displayName: 'Alice', picks: 45 },
			{ kind: 'user', userId: 'u-bob', displayName: 'Bob', picks: 45 },
			{ kind: 'bot', userId: null, displayName: 'Sunny', picks: 45 },
		],
		startedAt: 1_000,
		endedAt: 2_000,
		durationMs: 1_000,
		outcome: 'complete',
		...over,
	};
}

async function freshDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-history-store-'));
	dirs.push(dir);
	return dir;
}

describe('the draft record store', () => {
	it('counts completed drafts by source, a round once per draft and a set under its code, and reads them back on open', async () => {
		const dir = await freshDir();
		const log: Record<string, unknown>[] = [];
		const store = history.createDraftRecordStore(dir, (e) => log.push(e));
		await store.append(record({ draftId: 'r-a', endedAt: 5_000 }));
		await store.append(record({ draftId: 'r-b', endedAt: 9_000, rounds: [{ kind: 'set', code: 'BLB', style: 'realistic' }, { kind: 'set', code: 'BLB', style: 'set-cube' }, { kind: 'cube', cubeId: CUBE_ID, name: CUBE_NAME, origin: 'shortlist' }] }));
		await store.append(record({ draftId: 'r-c', endedAt: 20_000, outcome: 'abandoned' }));
		const expected = new Map([
			[`cube:${CUBE_ID}`, { drafts: 2, lastAt: 9_000 }],
			['set:BLB', { drafts: 1, lastAt: 9_000 }],
		]);
		expect(store.countBySource()).toEqual(expected);
		expect(store.has('r-a')).toBe(true);
		expect(store.has('r-a', 1_000)).toBe(true);
		expect(store.has('r-a', 7)).toBe(false);

		// A line nothing can read counts nothing, is logged, and survives a rewrite.
		await writeFile(join(dir, 'drafts.jsonl'), `${await readFile(join(dir, 'drafts.jsonl'), 'utf8')}{"v":9}\n`);
		const reopened = history.createDraftRecordStore(dir, (e) => log.push(e));
		expect(reopened.countBySource()).toEqual(expected);
		expect(log.some((e) => e.event === 'draft-record-unreadable' && e.line === 4)).toBe(true);
		expect(await reopened.anonymise(new Set(['u-alice']))).toBe(3);
		expect((await readFile(join(dir, 'drafts.jsonl'), 'utf8')).trimEnd().split('\n').at(-1)).toBe('{"v":9}');
	});

	it("an account erase anonymises the person's seats and keeps the draft; a merge moves them", async () => {
		const dir = await freshDir();
		const store = history.createDraftRecordStore(dir, () => {});
		await store.append(record({ draftId: 'r-a' }));
		await store.append(record({ draftId: 'r-b', seats: [{ kind: 'user', userId: 'u-bob', displayName: 'Bob', picks: 45 }] }));
		const step = eraseDrafts.draftsEraseStep(store);
		expect(step.what).toBe('drafts');

		expect(await step.erase(eraseMod.personOf('u-alice'))).toBe(1);
		const erased = await recordLines(dir);
		expect(erased).toHaveLength(2);
		expect(erased[0]!.seats[0]).toEqual({ kind: 'user', userId: null, displayName: 'friend', picks: 45 });
		expect(erased[0]!.seats[1]).toEqual({ kind: 'user', userId: 'u-bob', displayName: 'Bob', picks: 45 });
		expect(JSON.stringify(erased)).not.toContain('u-alice');
		expect(JSON.stringify(erased)).not.toContain('Alice');
		expect(await step.erase(eraseMod.personOf('u-alice'))).toBe(0);

		expect(await step.merge(eraseMod.mergedAccountsOf('u-bob', 'u-carol'))).toBe(2);
		const merged = await recordLines(dir);
		expect(merged.flatMap((r) => r.seats.map((s) => s.userId))).toEqual([null, 'u-carol', null, 'u-carol']);
		expect(store.countBySource().get(`cube:${CUBE_ID}`)?.drafts).toBe(2);
	});
});

/* ── A closed room's unfinished pod ──────────────────────────────────── */

describe('a room closed mid-draft', () => {
	it('keeps its unfinished pod as abandoned, once, its rounds read from the draft, a realistic round by the set its boosters came from', async () => {
		const presence = socketMod.createSeatPresence({ seatReleaseMs: socketMod.SEAT_RELEASE_MS, draftGraceOf: () => 0 });
		const plan: DraftPlan = { rounds: [CUBE, { kind: 'set', code: 'BLB', style: 'realistic' }, CUBE] };
		const rooms = roomsMod.createDraftRooms({ resolver: resolver(fixtureCube(400)), defaultPlan: plan, presence });
		rooms.setPodLookup(() => ({ seats: 8, humans: [], bots: [], plan }));
		const boosters = Array.from({ length: 8 }, (_, s) => fixtureCube(15, 'BLB').map((c) => ({ ...c, cardId: `blb-${s}-${c.cardId}` })));
		rooms.cacheRealisticRound('r-w127abandon', 1, boosters);
		const room = rooms.open('r-w127abandon');
		const dir = await freshDir();
		const store = history.createDraftRecordStore(dir, () => {});

		history.recordDraftsAbandoned('r-w127abandon', rooms, store, room.createdAt + 50_000);
		history.recordDraftsAbandoned('r-w127abandon', rooms, store, room.createdAt + 60_000);
		await waitUntil(async () => (await recordLines(dir)).length > 0, 'the abandoned record');
		presence.dispose();

		const records = await recordLines(dir);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ draftId: 'r-w127abandon', outcome: 'abandoned', durationMs: 50_000, pod: null });
		expect(records[0]!.rounds).toEqual([
			{ kind: 'cube', cubeId: CUBE_ID, name: CUBE_NAME, origin: 'shortlist' },
			{ kind: 'set', code: 'BLB', style: 'realistic' },
			{ kind: 'cube', cubeId: CUBE_ID, name: CUBE_NAME, origin: 'shortlist' },
		]);
		expect(records[0]!.seats.every((seat) => seat.kind === 'bot' && seat.picks === 0)).toBe(true);
		// Abandoned is kept, never counted.
		expect(store.countBySource().size).toBe(0);
	});
});

/* ── The backfill ────────────────────────────────────────────────────── */

/** A dealt card as a pod file keeps it: `[cardId, name, rarity, setCode]`. */
type Row = [string, string, DraftCard['rarity'], string];
const card = ([cardId, name, rarity, setCode]: Row): DraftCard => ({ cardId, name, manaCost: [], manaValue: 0, colors: [], typeLine: '', oracleText: '', setCode, collectorNumber: '0', rarity });

// Reduced from prod's drafts dir on 2026-11-23 (`docs/handoff/snapshot/drafts/`): one seat's first pack each.
/** r-39dded1c935a: Powered Vintage Cube, imported from Cube Cobra. */
const CUBE_COBRA_PACK: Row[] = [
	['cc-2plnt-398#0:0:11', 'Mox Emerald', 'rare', 'LEA'],
	['cc-2plnt-99#0:7:8', 'Flash', 'rare', 'MIR'],
	['cc-2plnt-257#0:6:8', 'Birds of Paradise', 'rare', 'LEA'],
	['cc-2plnt-379#0:5:2', 'Phyrexian Metamorph', 'rare', 'PNPH'],
];
/** r-93d9930e0214: Bloomburrow realistic boosters, one mythic in the pack. */
const BLB_REALISTIC_PACK: Row[] = [
	["alania's pathmaker#0:3:14", "Alania's Pathmaker", 'common', 'BLB'],
	["bandit's talent#0:3:3", "Bandit's Talent", 'uncommon', 'BLB'],
	['banishing light#0:3:5', 'Banishing Light', 'common', 'BLB'],
	['brambleguard captain#0:3:1', 'Brambleguard Captain', 'uncommon', 'BLB'],
	['cindering cutthroat#0:3:7', 'Cindering Cutthroat', 'common', 'BLB'],
	['fell#0:3:2', 'Fell', 'uncommon', 'BLB'],
	['finch formation#0:3:12', 'Finch Formation', 'common', 'BLB'],
	['hidden grotto#0:3:9', 'Hidden Grotto', 'common', 'BLB'],
	['lightshell duo#0:3:13', 'Lightshell Duo', 'common', 'BLB'],
	['mind spiral#0:3:11', 'Mind Spiral', 'common', 'BLB'],
	['moonrise cleric#0:3:8', 'Moonrise Cleric', 'common', 'BLB'],
	['rust-shield rampager#0:3:10', 'Rust-Shield Rampager', 'common', 'BLB'],
	["sazacap's brew#0:3:4", "Sazacap's Brew", 'common', 'BLB'],
	['season of weaving#0:3:0', 'Season of Weaving', 'mythic', 'BLB'],
	['tempest angler#0:3:6', 'Tempest Angler', 'common', 'BLB'],
];
/** r-1001cf0cb04a: Bloomburrow as a set-cube, four rares in the pack. */
const BLB_SET_CUBE_PACK: Row[] = [
	['kastral, the windcrested#0:3:0', 'Kastral, the Windcrested', 'rare', 'BLB'],
	['lilypad village#0:3:5', 'Lilypad Village', 'uncommon', 'BLB'],
	['barkform harvester#0:3:13', 'Barkform Harvester', 'common', 'BLB'],
	['conduct electricity#0:3:9', 'Conduct Electricity', 'common', 'BLB'],
	["long river's pull#0:3:8", "Long River's Pull", 'uncommon', 'BLB'],
	['fecund greenshell#0:3:2', 'Fecund Greenshell', 'rare', 'BLB'],
	['thought shucker#0:3:11', 'Thought Shucker', 'common', 'BLB'],
	['mockingbird#0:3:3', 'Mockingbird', 'rare', 'BLB'],
	['agate assault#0:3:12', 'Agate Assault', 'common', 'BLB'],
	['seedglaive mentor#0:3:4', 'Seedglaive Mentor', 'uncommon', 'BLB'],
	["sazacap's brew#0:3:10", "Sazacap's Brew", 'common', 'BLB'],
	['rust-shield rampager#0:3:14', 'Rust-Shield Rampager', 'common', 'BLB'],
	['calamitous tide#0:3:7', 'Calamitous Tide', 'uncommon', 'BLB'],
	['feed the cycle#0:3:6', 'Feed the Cycle', 'uncommon', 'BLB'],
	['festival of embers#0:3:1', 'Festival of Embers', 'rare', 'BLB'],
];

const names = (rows: readonly Row[], extra: string[] = []): Set<string> => new Set([...rows.map((r) => r[1]), ...extra].map((n) => backfill.nameKey(n)));

describe('the backfill', () => {
	const blb = (): SourceList => ({ kind: 'set', code: 'BLB', names: names([...BLB_REALISTIC_PACK, ...BLB_SET_CUBE_PACK]) });
	const lists = (): SourceList[] => [{ kind: 'cube', id: 'cc-2plnt', name: 'Powered Vintage Cube', names: names(CUBE_COBRA_PACK) }, blb()];

	it("decides an imported cube by its card ids, and a set by name overlap, realistic or set-cube by its rarity mix", () => {
		expect(backfill.decideRoundFromCards(CUBE_COBRA_PACK.map(card), lists())).toEqual({ source: { kind: 'cube', cubeId: 'cc-2plnt', name: 'Powered Vintage Cube', origin: 'cubecobra' }, how: 'card-id prefix' });
		expect(backfill.decideRoundFromCards(BLB_REALISTIC_PACK.map(card), lists())).toMatchObject({ source: { kind: 'set', code: 'BLB', style: 'realistic' } });
		expect(backfill.decideRoundFromCards(BLB_SET_CUBE_PACK.map(card), lists())).toMatchObject({ source: { kind: 'set', code: 'BLB', style: 'set-cube' } });
	});

	it('leaves a round undecided when no list holds 90% of its names, or more than one does', () => {
		const shortOf = BLB_REALISTIC_PACK.slice(0, 13).map((r) => r[1]);
		const thin: SourceList = { kind: 'set', code: 'BLB', names: names([], shortOf) };
		expect(backfill.decideRoundFromCards(BLB_REALISTIC_PACK.map(card), [thin])).toEqual({ source: null, why: 'no list holds 90% of its 15 names (best: set BLB at 87%)' });
		const twin: SourceList = { kind: 'cube', id: 'blb-cube', name: 'A Bloomburrow cube', names: names(BLB_REALISTIC_PACK) };
		expect(backfill.decideRoundFromCards(BLB_REALISTIC_PACK.map(card), [blb(), twin])).toEqual({ source: null, why: '2 lists hold 90% of its names: set BLB 100%, cube blb-cube 100%' });
	});

	it('reads roundSources first, then the room plan, then the cards; and writes a finished pod only, marked backfilled', () => {
		const file = (status: DraftState['status'], roundSources: (string | null)[]): DraftFile => ({
			roomId: 'r-w127back',
			createdAt: 1_000,
			updatedAt: 4_000,
			app: {
				state: {
					draftId: 'r-w127back',
					packCount: 3,
					seatCount: 1,
					status,
					roundSources,
					table: { capacity: 1, seats: [{ id: 0, occupant: { kind: 'human', participantId: 'fk:w127' } }], remembered: {}, reservations: {}, reservationTtlMs: 0 },
					displayNames: { 0: 'Alice' },
					pools: [[...CUBE_COBRA_PACK, ...BLB_SET_CUBE_PACK.map((r): Row => [r[0].replace('#0:', '#2:'), r[1], r[2], r[3]])].map(card)],
					queues: [[]],
					rounds: [],
				} as unknown as DraftState,
			},
		});
		const finished = file('complete', ['cube:mtgo-vintage-cube-2025-04', null, null]);
		const decision = backfill.decideDraft(finished, lists(), () => [CUBE, CUBE, CUBE]);
		expect(decision.rounds.map((r) => (r.source === null ? r.why : r.how))).toEqual(['roundSources', 'room plan', 'room plan']);
		const fromCards = backfill.decideDraft(finished, lists(), () => null);
		expect(fromCards.rounds.map((r) => (r.source === null ? 'undecided' : r.how))).toEqual(['roundSources', 'undecided', expect.stringMatching(/^name overlap 100%/)]);
		expect(backfill.decisionLine(fromCards)).toContain('undecided — round 2: no card dealt in this round is left');

		const written = backfill.backfilledRecord(finished, decision, null, 'r-w127back-900', (pid) => (pid === 'fk:w127' ? 'u-alice' : null));
		expect(written).toMatchObject({ eventId: 'r-w127back-900', backfilled: true, outcome: 'complete', startedAt: 1_000, endedAt: 4_000, durationMs: 3_000, seats: [{ kind: 'user', userId: 'u-alice', displayName: 'Alice', picks: 19 }] });
		expect(written?.rounds[0]).toEqual({ kind: 'cube', cubeId: 'mtgo-vintage-cube-2025-04', name: 'mtgo-vintage-cube-2025-04', origin: 'shortlist' });
		expect(backfill.backfilledRecord(finished, fromCards, null, null, () => null)).toBeNull();
		expect(backfill.backfilledRecord(file('drafting', ['cube:x', 'cube:x', 'cube:x']), decision, null, null, () => null)).toBeNull();
	});

	it("names the pod tournament the room played after the deal's start, as a live record does", () => {
		const played = [
			{ id: 'r-w127back-500', startedAt: 500 },
			{ id: 'r-w127back-900', startedAt: 900 },
			{ id: 'r-w127back-5000', startedAt: 5_000 },
			{ id: 'r-other-950', startedAt: 950 },
		];
		expect(backfill.eventOf('r-w127back', 1_000, played)).toBe('r-w127back-900');
		expect(backfill.eventOf('r-w127back', 400, played)).toBeNull();
	});
});
