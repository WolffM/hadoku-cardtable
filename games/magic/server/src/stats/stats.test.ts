/**
 * Match stats, from a REAL bridge transcript (`play/fixtures/bridge-two-seats.ndjson`)
 * played through a real `Match`, then carried past turn 1 by hand-written
 * deltas in the transcript's own shape: what a finished match is read as
 * (`facts.ts`), what is reported (`report.ts`), how the report is sent
 * (game-server's `stats/reporter`), and who it names (`keys.ts`, `index.ts`).
 */


import express, { type NextFunction, type Request, type Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { ClientFrame } from '@hadoku/forge-wire';
import { STAT_LIMITS, type MatchReport } from '@wolffm/prefs-client/games';

import { DELTA_TYPE, deltaKey } from '@hadoku/forge-wire';

import { loadTablesLibrary, type TablesLibrary } from '../http/library.js';
import { attachTables, type RoomViewLike, type StartedMatch, type TablesRooms } from '../http/routes.js';
import type { ForgeMatchSpec } from '../play/forge-spec.js';
import { identityFromHeaders } from '@hadoku/game-server/room/identity';
import type { BridgeLine } from '../play/bridge-protocol.js';
import { createMatchRegistry, type Match } from '../play/match.js';
import { loadTranscript, replayFactory, type ReplayHost } from '../play/fixtures/transcript.js';
import { matchFacts } from './facts.js';
import { createStatsReporter } from '@hadoku/game-server/stats/reporter';
import { createKeyBook, createMatchStats, summarizeDeck, type MatchStart } from './index.js';
import { buildMatchReport } from './report.js';
import type { PoolSource } from '@hadoku/shared';
import { REPO_ROOT } from '../root.js';

const TRANSCRIPT = loadTranscript();

interface Harness {
	match: Match;
	host: ReplayHost;
	over: Match[];
}

function harness(): Harness {
	const { factory, hosts } = replayFactory();
	const over: Match[] = [];
	const registry = createMatchRegistry({
		host: factory,
		log: () => undefined,
		overGraceMs: 60_000,
		emit: () => undefined,
		onGameOver: (m) => over.push(m),
	});
	const match = registry.create({
		seats: [
			{ name: 'Seat 1', ai: false, deck: null },
			{ name: 'Seat 2', ai: false, deck: null },
		],
	});
	match.claim('fk:aaaaaaaaaaaaaaaa');
	match.claim('fk:bbbbbbbbbbbbbbbb');
	const host = hosts[0] as ReplayHost;
	host.push(...TRANSCRIPT);
	return { match, host, over };
}

let seq = 100;

/** One `applyDelta` to both seats, changing tracked properties of existing objects or adding new ones. */
function delta(objectDeltas: Record<string, Record<string, unknown>>, newObjects: Record<string, Record<string, unknown>> = {}): BridgeLine[] {
	seq += 1;
	const packet = { seq, checksum: 0, checksumProperties: [], newObjects, objectDeltas, events: [] };
	return [0, 1].map((seat) => ({ t: 'frame', seat, frame: { kind: 'notify', method: 'applyDelta', payload: { packet } } }) as BridgeLine);
}

const int = (v: number) => ({ t: 'int', v });
const player = (id: number, props: Record<string, unknown>) => ({ [deltaKey(DELTA_TYPE.player, id)]: { _type: DELTA_TYPE.player, _id: id, ...props } });

/** Turn 1 is seat 1's (the transcript's own `PlayerTurn`). Seat 0 casts a spell, draws twice; seat 1 takes 20. */
function playOut(h: Harness): void {
	h.host.push(
		...delta(player(0, { NumDrawnThisTurn: int(1) })),
		...delta(player(0, { NumDrawnThisTurn: int(2), NumLandThisTurn: int(1) })),
		...delta({}, {
			[deltaKey(DELTA_TYPE.stackItem, 7001)]: { _type: DELTA_TYPE.stackItem, _id: 7001, ActivatingPlayer: int(0), Ability: { t: 'bool', v: false } },
		}),
		...delta(player(1, { Life: int(3) })),
		...delta(player(1, { Life: int(5) })),
		...delta(player(1, { Life: int(0), HasLost: { t: 'bool', v: true } })),
	);
}

const START: MatchStart = {
	mode: 'constructed',
	roomId: 'r-room1',
	startedAt: 0,
	attrs: { format: 'standard', pool: '2016-07-22', opponent: 'human' },
	seats: [
		{ kind: 'user', userKey: 'key-alice', displayName: 'Alice', avatarId: 'ava-1', deck: { name: 'Army of Entropy', id: 'army', colors: ['B', 'R'], cards: 60, basicLands: 20 } },
		{ kind: 'guest', displayName: 'Bob', deck: { name: 'Eternal Thirst', colors: ['U', 'B'], cards: 60, basicLands: 22 } },
	],
};


/** game-server's reporter, recording into `sent` with no network and no retry waits. */
function reporterInto(sent: MatchReport[], log: (e: Record<string, unknown>) => void) {
	return createStatsReporter({
		gameId: 'cardtable',
		serviceKey: 'k',
		record: async (_opts, r) => (sent.push(r), { matchId: r.matchId, duplicate: false, ratings: {} }),
		log,
		retryDelaysMs: [],
	});
}

describe('what a finished match is read as', () => {
	it('is null until Forge says the game is over', () => {
		const h = harness();
		expect(matchFacts(h.match)).toBeNull();
	});

	it('reads the winner, the turn, who was on the play and the end state off a real stream', () => {
		const h = harness();
		playOut(h);
		h.host.push({ t: 'gameover', winner: 'Seat 1' });
		expect(h.over).toEqual([h.match]);

		const facts = matchFacts(h.match)!;
		expect(facts.matchId).toBe(h.match.id);
		expect(facts.turns).toBe(1);
		expect(facts.endReason).toBe('life');
		expect(facts.seats.map((s) => s.placement)).toEqual([1, 2]);
		expect(facts.seats.map((s) => s.onPlay)).toEqual([false, true]);
		expect(facts.seats.map((s) => s.mulligans)).toEqual([0, 0]);

		const [alice, bob] = facts.seats;
		expect(alice!.play).toEqual({ cardsDrawn: 2, landsPlayed: 1, lifeLost: 0, lifeGained: 0, spellsCast: 1, abilitiesActivated: 0 });
		expect(bob!.play).toMatchObject({ lifeLost: 20 - 3 + 5, lifeGained: 2 });
		expect(bob!.end).toMatchObject({ life: 0, hasLost: true, poison: 0 });
		expect(alice!.end!.library + alice!.end!.hand).toBeGreaterThan(0);
	});

	it('counts every frame of a game whose histories were compacted at each new turn, the frames that carried the counts long gone', () => {
		const h = harness();
		const game = (props: Record<string, unknown>) => ({ [deltaKey(DELTA_TYPE.game, 1)]: { _type: DELTA_TYPE.game, _id: 1, ...props } });
		h.host.push(
			...delta(player(0, { NumDrawnThisTurn: int(1), NumLandThisTurn: int(1) })),
			...delta({ ...game({ Turn: int(2), PlayerTurn: int(0) }), ...player(0, { NumDrawnThisTurn: null, NumLandThisTurn: null }) }),
			...delta(player(0, { NumDrawnThisTurn: int(1) })),
			...delta({}, {
				[deltaKey(DELTA_TYPE.stackItem, 7002)]: { _type: DELTA_TYPE.stackItem, _id: 7002, ActivatingPlayer: int(1), Ability: { t: 'bool', v: true } },
			}),
			...delta({ ...game({ Turn: int(3), PlayerTurn: int(1) }), ...player(1, { Life: int(15) }) }),
			...delta(player(1, { Life: int(0), HasLost: { t: 'bool', v: true } })),
		);
		h.host.push({ t: 'gameover', winner: 'Seat 1' });
		// Turn 3's base and the one frame since: the draws, the land, the ability and the first life loss are not in it.
		for (const s of h.match.seats) expect(s.history.frames().map((f) => f.method)).toEqual(['openView', 'setGameView', 'applyDelta']);

		const facts = matchFacts(h.match)!;
		expect(facts.turns).toBe(3);
		expect(facts.seats.map((s) => s.onPlay)).toEqual([false, true]);
		const [alice, bob] = facts.seats;
		expect(alice!.play).toEqual({ cardsDrawn: 2, landsPlayed: 1, lifeLost: 0, lifeGained: 0, spellsCast: 0, abilitiesActivated: 0 });
		expect(bob!.play).toEqual({ cardsDrawn: 0, landsPlayed: 0, lifeLost: 20, lifeGained: 0, spellsCast: 0, abilitiesActivated: 1 });
		expect(bob!.end).toMatchObject({ life: 0, hasLost: true });
		expect(facts.endReason).toBe('life');
	});

	it('a concede is the end reason, whatever the board says', () => {
		const h = harness();
		expect(h.match.fromClient(1, { kind: 'act', method: 'concede' } as ClientFrame)).toEqual({ ok: true });
		h.host.push({ t: 'gameover', winner: 'Seat 1' });
		const facts = matchFacts(h.match)!;
		expect(facts.endReason).toBe('concede');
		expect(facts.seats.map((s) => s.placement)).toEqual([1, 2]);
	});

	it('a concede Forge ends with no winner named is the conceder’s loss, not a draw', () => {
		const h = harness();
		expect(h.match.fromClient(1, { kind: 'act', method: 'concede' } as ClientFrame)).toEqual({ ok: true });
		h.host.push({ t: 'gameover', winner: null });
		const facts = matchFacts(h.match)!;
		expect(facts.seats.map((s) => s.placement)).toEqual([1, 2]);
		expect(facts.endReason).toBe('concede');
	});

	it('Forge’s own losers place the seats, even when the winner’s name says otherwise', () => {
		const h = harness();
		playOut(h);
		h.host.push({ t: 'gameover', winner: 'Seat 1', losers: [h.match.seats[0]!.playerId!] });
		expect(matchFacts(h.match)!.seats.map((s) => s.placement)).toEqual([2, 1]);
	});

	it.each([
		['stopped', (h: Harness) => h.match.stop()],
		['failed', (h: Harness) => h.host.push({ t: 'fatal', message: 'the JVM died' })],
	])('a game the server already %s is not finished when a late gameover line arrives', (_, end) => {
		const h = harness();
		playOut(h);
		end(h);
		h.host.push({ t: 'gameover', winner: 'Seat 1' });
		expect(h.over).toEqual([]);
		expect(h.match.outcome()).toBeNull();
		expect(matchFacts(h.match)).toBeNull();
	});

	it('a draw places everybody first and names no end reason', () => {
		const h = harness();
		h.host.push({ t: 'gameover', winner: null });
		const facts = matchFacts(h.match)!;
		expect(facts.seats.map((s) => s.placement)).toEqual([1, 1]);
		expect(facts.endReason).toBeNull();
	});

	it('counts a press of Mulligan on the opening Keep/Mulligan bar, and not a Cancel anywhere else', () => {
		const h = harness();
		const bar = (label1: string, label2: string): BridgeLine => ({
			t: 'frame',
			seat: 0,
			frame: { kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: 0 }, label1, label2, enable1: true, enable2: true, focus1: true },
		});
		h.host.push(bar('Keep', 'Mulligan'));
		h.match.fromClient(0, { kind: 'act', method: 'selectButtonCancel' } as ClientFrame);
		h.host.push(bar('OK', 'Cancel'));
		h.match.fromClient(0, { kind: 'act', method: 'selectButtonCancel' } as ClientFrame);
		expect(h.match.seats[0]!.mulligans).toBe(1);
	});
});

describe('the report', () => {
	function finished(): Harness {
		const h = harness();
		playOut(h);
		h.host.push({ t: 'gameover', winner: 'Seat 1' });
		return h;
	}

	it('carries every stat, the user seat by its key and the guest by name', () => {
		const h = finished();
		const report = buildMatchReport(matchFacts(h.match)!, START)!;
		expect(report).toMatchObject({
			matchId: h.match.id,
			mode: 'constructed',
			roomId: 'r-room1',
			startedAt: 0,
			endedAt: h.match.endedAt,
			attrs: { format: 'standard', pool: '2016-07-22', opponent: 'human', endReason: 'life' },
			counters: { turns: 1, durationMs: h.match.endedAt },
		});
		const [alice, bob] = report.seats;
		expect(alice).toMatchObject({
			seat: 0,
			kind: 'user',
			userKey: 'key-alice',
			displayName: 'Alice',
			placement: 1,
			attrs: { deck: 'Army of Entropy', deckId: 'army', colors: ['B', 'R'], avatar: 'ava-1', onPlay: false },
			counters: { colorCount: 2, cardsInDeck: 60, basicLandsInDeck: 20, mulligans: 0, cardsDrawn: 2, landsPlayed: 1, spellsCast: 1 },
		});
		expect(Object.keys(alice!.counters!)).toEqual(
			expect.arrayContaining(['lifeEnd', 'poisonEnd', 'libraryEnd', 'handEnd', 'graveyardEnd', 'exileEnd', 'permanentsEnd', 'landsEnd', 'creaturesEnd', 'lifeLost', 'lifeGained', 'abilitiesActivated']),
		);
		expect(bob).toMatchObject({ kind: 'guest', displayName: 'Bob', placement: 2, attrs: { deck: 'Eternal Thirst', onPlay: true } });
		expect(bob).not.toHaveProperty('userKey');
		expect(bob!.attrs).not.toHaveProperty('deckId');
	});

	it('every stat key is one the store accepts', () => {
		const report = buildMatchReport(matchFacts(finished().match)!, START)!;
		const keys = [report.attrs, report.counters, ...report.seats.flatMap((s) => [s.attrs, s.counters])].flatMap((o) => Object.keys(o ?? {}));
		for (const key of keys) expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
	});

	it('ranks only a match between signed-in players, none of them a test account', () => {
		const facts = matchFacts(finished().match)!;
		const user = (displayName: string) => ({ ...START.seats[0]!, displayName });
		const rated = (seats: MatchStart['seats']) => buildMatchReport(facts, { ...START, seats })!.rated;
		expect(rated([user('Alice'), user('Carol')])).toBe(true);
		expect(rated(START.seats)).toBe(false);
		expect(rated([user('Alice'), { kind: 'bot', deck: null }])).toBe(false);
		expect(rated([user('Alice'), user('Bella')])).toBe(false);
		expect(rated([user('wp-ada'), user('Alice')])).toBe(false);
		expect(rated([user('Alice'), user('Bellamy')])).toBe(true);
	});

	it('is refused for an id the store would refuse', () => {
		const facts = matchFacts(finished().match)!;
		expect(buildMatchReport({ ...facts, matchId: 'short' }, START)).toBeNull();
	});
});

describe("a deck's summary", () => {
	it('folds a real library deck into its size, basics and colours', () => {
		const library = loadTablesLibrary(REPO_ROOT);
		const deck = library.decks.find((d) => d.deck.name === 'Mono Green Infect') ?? library.decks[0]!;
		const summary = summarizeDeck(deck.text, {}, deck.id);
		expect(summary.name).toBe(deck.deck.name);
		expect(summary.id).toBe(deck.id);
		expect(summary.cards).toBeGreaterThanOrEqual(40);
		expect(summary.basicLands).toBeGreaterThan(0);
		expect(summary.colors, 'no cost map: only what the costs say, and there are none').toEqual([]);
		// It parses the whole real deck library off disk: 2.1 s alone, past vitest's 5 s default under a full check on a loaded host.
	}, 30_000);

	it('reads colours from the cost map, Phyrexian adding none', () => {
		const text = '[metadata]\nName=Test\n[Main]\n4 Gut Shot\n4 Llanowar Elves\n12 Forest\n';
		const summary = summarizeDeck(text, { 'Gut Shot': '{R/P}', 'Llanowar Elves': '{G}' });
		expect(summary).toEqual({ name: 'Test', colors: ['G'], cards: 20, basicLands: 12 });
	});
});

describe('who a report names', () => {
	function requestWith(key: string | undefined): Request {
		// The edge stamps the key beside the userId it signs in; `user-<name>` for `k-<name>`.
		return { headers: key === undefined ? {} : { 'x-user-key': key, 'x-user-id': `user-${key.slice(2)}` } } as unknown as Request;
	}

	it('remembers a caller’s key under the id the room knows them by, bounded', () => {
		const book = createKeyBook(2);
		const next = vi.fn() as NextFunction;
		for (const key of ['k-alice', 'k-bob', 'k-carol']) book.remember(requestWith(key), {} as Response, next);
		book.remember(requestWith(undefined), {} as Response, next);
		expect(next).toHaveBeenCalledTimes(4);
		const id = (key: string) => identityFromHeaders({ 'x-user-id': `user-${key.slice(2)}` }, 'unused');
		expect(book.keyOf(id('k-alice'))).toBeNull();
		expect(book.keyOf(id('k-bob'))).toBe('k-bob');
		expect(book.keyOf(id('k-carol'))).toBe('k-carol');
	});

	it('files no key the edge stamped without a userId: that id is the socket’s, and names nobody', () => {
		const book = createKeyBook();
		book.remember({ headers: { 'x-user-key': 'k-dave' } } as unknown as Request, {} as Response, () => undefined);
		expect(book.keyOf(identityFromHeaders({}, ''))).toBeNull();
	});

	it('reports a room member with a key as a user, one without as a guest, the AI as a bot', async () => {
		const book = createKeyBook();
		book.remember(requestWith('k-alice'), {} as Response, () => undefined);
		const sent: MatchReport[] = [];
		const logs: Record<string, unknown>[] = [];
		const h = harness();
		const stats = createMatchStats({
			keys: book,
			log: (e) => logs.push(e),
			reporter: reporterInto(sent, (e) => logs.push(e)),
			startOf: (m) =>
				m.id !== h.match.id
					? null
					: {
							mode: 'constructed',
							startedAt: 0,
							attrs: {},
							seats: [
								{ ai: false, memberId: identityFromHeaders({ 'x-user-id': 'user-alice' }, 'unused'), displayName: 'Alice', deck: null },
								{ ai: false, memberId: 'fk:nobodyknowsme0', displayName: 'Bob', deck: null },
							],
						},
		});
		playOut(h);
		h.host.push({ t: 'gameover', winner: 'Seat 1' });
		stats.gameOver(h.match);
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]!.seats.map((s) => [s.kind, s.userKey])).toEqual([
			['user', 'k-alice'],
			['guest', undefined],
		]);
		expect(JSON.stringify(logs)).not.toContain('k-alice');
	});

	it('skips a match no room started, and says so', () => {
		const logs: Record<string, unknown>[] = [];
		const record = vi.fn();
		const stats = createMatchStats({
			keys: createKeyBook(),
			log: (e) => logs.push(e),
			reporter: createStatsReporter({ gameId: 'cardtable', serviceKey: 'k', record, log: (e) => logs.push(e) }),
			startOf: () => null,
		});
		const h = harness();
		playOut(h);
		h.host.push({ t: 'gameover', winner: 'Seat 1' });
		stats.gameOver(h.match);
		expect(logs).toEqual([{ evt: 'stats-skipped', matchId: h.match.id, reason: 'no room started this match' }]);
		expect(record).not.toHaveBeenCalled();
	});
});

describe('a series result', () => {
	const ALICE_ID = identityFromHeaders({ 'x-user-id': 'user-alice' }, 'unused');
	const GAMES = [
		{ matchId: 'm-aaaaaaaaaaaa', winner: 1 as const },
		{ matchId: 'm-bbbbbbbbbbbb', winner: 0 as const },
		{ matchId: 'm-cccccccccccc', winner: 1 as const },
	];

	function seriesStats() {
		const book = createKeyBook();
		book.remember({ headers: { 'x-user-key': 'k-alice', 'x-user-id': 'user-alice' } } as unknown as Request, {} as Response, () => undefined);
		const sent: MatchReport[] = [];
		const stats = createMatchStats({
			keys: book,
			log: () => undefined,
			reporter: reporterInto(sent, () => undefined),
			startOf: () => null,
		});
		return { stats, sent };
	}

	it('is one report in its own pool, keyed off its first game: the score, the mode and how many games it was best of', async () => {
		const { stats, sent } = seriesStats();
		stats.seriesEnd({
			roomId: 'r-abcdefabcdef',
			tableId: 't-00000001',
			mode: 'classic',
			bestOf: 3,
			seats: [
				{ memberId: ALICE_ID, name: 'Alice' },
				{ memberId: 'fk:nobodyknowsme0', name: 'Bob' },
			],
			wins: [1, 2],
			games: GAMES,
			winner: 1,
		});
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		const report = sent[0]!;
		expect(report).toMatchObject({
			matchId: 'm-aaaaaaaaaaaa-series',
			mode: 'constructed-series',
			roomId: 'r-abcdefabcdef',
			rated: false,
			attrs: { mode: 'classic', bestOf: 3, score: '1-2', opponent: 'human' },
			counters: { games: 3 },
		});
		expect(report.attrs, 'every recorded series is a finished one').not.toHaveProperty('complete');
		expect(report.seats.map((s) => [s.seat, s.kind, s.userKey, s.displayName, s.placement, s.counters?.wins])).toEqual([
			[0, 'user', 'k-alice', 'Alice', 2, 1],
			[1, 'guest', undefined, 'Bob', 1, 2],
		]);
	});

	it('names the AI seat a bot, and a drawn Bo1 places both seats first', async () => {
		const { stats, sent } = seriesStats();
		stats.seriesEnd({
			roomId: 'r-abcdefabcdef',
			tableId: 't-00000001',
			mode: 'random',
			bestOf: 1,
			seats: [{ memberId: ALICE_ID, name: 'Alice' }, null],
			wins: [0, 0],
			games: GAMES.slice(0, 1),
			winner: null,
		});
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toMatchObject({ rated: false, attrs: { mode: 'random', bestOf: 1, score: '0-0', opponent: 'bot' } });
		expect(sent[0]!.seats.map((s) => [s.kind, s.placement])).toEqual([
			['user', 1],
			['bot', 1],
		]);
	});

	it('a Bo3 that ended undecided at 1-1 is a draw: both seats first, one game won each', async () => {
		const { stats, sent } = seriesStats();
		stats.seriesEnd({
			roomId: 'r-abcdefabcdef',
			tableId: 't-00000001',
			mode: 'classic',
			bestOf: 3,
			seats: [
				{ memberId: ALICE_ID, name: 'Alice' },
				{ memberId: 'fk:nobodyknowsme0', name: 'Bob' },
			],
			wins: [1, 1],
			games: GAMES.slice(0, 2),
			winner: null,
		});
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toMatchObject({ attrs: { mode: 'classic', bestOf: 3, score: '1-1' }, counters: { games: 2 } });
		expect(sent[0]!.seats.map((s) => [s.displayName, s.placement, s.counters?.wins])).toEqual([
			['Alice', 1, 1],
			['Bob', 1, 1],
		]);
	});
});

describe('where a match was played from', () => {
	const ROOM = 'r-source1';
	const DEALT = Date.UTC(2026, 10, 23, 20, 0, 0);
	const cube = (cubeId: string): PoolSource => ({ kind: 'cube', cubeId });
	const set = (code: string, style: 'realistic' | 'set-cube' = 'realistic'): PoolSource => ({ kind: 'set', code, style });
	/** No era and no deck: every pool here is a drafted one or a constructed room's, and the source is the room's. */
	const NO_LIBRARY: TablesLibrary = { formats: [], decks: [], faults: [], format: () => undefined, deck: () => undefined };

	/** A room as `roomOfMatch` hands it over: the lobby's view, its pod carrying the plan a draft room drafted. */
	function roomView(over: { gameType: string; rounds?: PoolSource[] | null; dealt?: number | null; tournament?: boolean }): RoomViewLike {
		const drafting = over.gameType === 'draft' || over.tournament === true;
		return {
			id: ROOM,
			name: 'Source room',
			gameType: over.gameType,
			leader: 'm-alice',
			members: [{ id: 'm-alice', name: 'Alice' }],
			tables: [],
			settings: { handSmoothing: true, tournament: over.tournament ?? false },
			game: {
				format: '2016-07-22',
				draftStartedAt: over.dealt === undefined || over.dealt === null ? null : new Date(over.dealt).toISOString(),
				pod: drafting ? { phase: 'rounds', results: [], plan: over.rounds === undefined || over.rounds === null ? null : { rounds: over.rounds } } : null,
			} as RoomViewLike['game'],
		};
	}

	/** Every line the table routes logged, last `startIn` only. */
	let logged: Record<string, unknown>[] = [];

	/** `tables.matchStart` for one match in `room`, dealt in `pool`: the half of the report the room answers. */
	function startIn(room: RoomViewLike, pool: string) {
		const rooms = { roomOfMatch: () => room, get: () => room, list: () => [room] } as unknown as TablesRooms;
		logged = [];
		const tables = attachTables(express.Router(), { draftRooms: null, library: NO_LIBRARY, rooms, log: (e) => logged.push(e) });
		const spec = { format: pool, seats: [{ name: 'Alice', ai: false, deck: null }, { name: 'Forge', ai: true, deck: null }] } as unknown as ForgeMatchSpec;
		const match: StartedMatch = { id: 'm-source00001', spec, startedAt: 0, seats: [{ owner: 'm-alice', displayName: 'Alice' }, { owner: null }] };
		const start = tables.matchStart(match);
		expect(start).not.toBeNull();
		return start!;
	}

	/** The report a finished match sends, built from the room's answer. */
	function reported(room: RoomViewLike, pool: string) {
		const h = harness();
		playOut(h);
		h.host.push({ t: 'gameover', winner: 'Seat 1' });
		return buildMatchReport(matchFacts(h.match)!, { ...START, attrs: startIn(room, pool).attrs })!;
	}

	it('a draft room on one cube names the cube, the draft and its tournament, and keeps the pool it was dealt in', () => {
		const report = reported(roomView({ gameType: 'draft', rounds: [cube('cc-2plnt'), cube('cc-2plnt'), cube('cc-2plnt')], dealt: DEALT }), `draft:${ROOM}`);
		expect(report.attrs).toMatchObject({ source: 'cube', cube: 'cc-2plnt', draftId: ROOM, event: `${ROOM}-${String(DEALT)}`, pool: `draft:${ROOM}`, format: 'draft' });
		expect(report.attrs).not.toHaveProperty('set');
		// The server log says the same, for a stack with no stats key (every e2e one).
		expect(logged.filter((e) => e.evt === 'match-source')).toEqual([
			{ evt: 'match-source', matchId: 'm-source00001', roomId: ROOM, source: 'cube', cube: 'cc-2plnt', draftId: ROOM, event: `${ROOM}-${String(DEALT)}` },
		]);
	});

	it('a set draft names the set, whatever style each pack was dealt in', () => {
		const attrs = startIn(roomView({ gameType: 'draft', rounds: [set('ISD'), set('ISD', 'set-cube'), set('ISD')], dealt: DEALT }), `draft:${ROOM}`).attrs;
		expect(attrs).toMatchObject({ source: 'set', set: 'ISD', draftId: ROOM });
		expect(attrs).not.toHaveProperty('cube');
	});

	it('a Custom draft whose rounds mix sources is custom, and names no cube or set', () => {
		for (const rounds of [
			[set('ALA'), set('ALA'), set('ARB')],
			[cube('vintage'), set('ISD'), cube('vintage')],
		]) {
			const attrs = startIn(roomView({ gameType: 'draft', rounds, dealt: DEALT }), `draft:${ROOM}`).attrs;
			expect(attrs).toMatchObject({ source: 'custom', draftId: ROOM });
			expect(attrs).not.toHaveProperty('cube');
			expect(attrs).not.toHaveProperty('set');
		}
	});

	it('a constructed room is constructed, from no draft and no event; its tournament names its event', () => {
		const casual = startIn(roomView({ gameType: 'constructed-1v1' }), '2016-07-22').attrs;
		expect(casual).toMatchObject({ source: 'constructed', pool: '2016-07-22' });
		for (const key of ['cube', 'set', 'draftId', 'event']) expect(casual).not.toHaveProperty(key);

		const tournament = startIn(roomView({ gameType: 'constructed-1v1', tournament: true, rounds: null, dealt: DEALT }), '2016-07-22').attrs;
		expect(tournament).toMatchObject({ source: 'constructed', event: `${ROOM}-${String(DEALT)}` });
		expect(tournament).not.toHaveProperty('draftId');
	});

	it('clips every string the report carries to what the store keeps', () => {
		const long = `cc-${'x'.repeat(STAT_LIMITS.stringLength + 50)}`;
		const attrs = reported(roomView({ gameType: 'draft', rounds: [cube(long), cube(long), cube(long)], dealt: DEALT }), `draft:${ROOM}`).attrs ?? {};
		expect(attrs.cube).toBe(long.slice(0, STAT_LIMITS.stringLength));
		for (const value of Object.values(attrs)) if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(STAT_LIMITS.stringLength);
	});
});
