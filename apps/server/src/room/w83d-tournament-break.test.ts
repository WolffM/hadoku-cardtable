/**
 * Breaking tournament mode at the `Lobby` interface — wave 83 §D: the edge
 * cases a big public tournament will hit, each one either holding or failing
 * with its cause named. The cases that need a real Forge match (a reload, a
 * closed tab, a restart with a game in play, a JVM that dies) are
 * `e2e/w83d-*.spec.ts`; everything here is the room's own bookkeeping, which
 * needs no engine.
 *
 * Every room is a Classic tournament with locked decks, entrants seated in
 * join order, readiness faked by `PodChecks` (`lobby.test.ts`'s own
 * `fakeChecks` shape). A game is "played" the way the play side reports one:
 * `setTableMatch`, then `recordGameResult` for its winner.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pairRound, roundsFor, standings, type MatchResult } from '@hadoku/draft';
import { afterAll, describe, expect, it } from 'vitest';

import { roundNamesOf } from './plan.ts';
import { openLobby, type Lobby, type PodChecks, type RoomView, type SeriesEnd } from './lobby.ts';

const dirs: string[] = [];

/** One fixed clock: every game lasts 0 ms, so the median-game tiebreak never depends on how fast a test ran. */
const now = () => 1_800_000_000_000;

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-w83d-'));
	dirs.push(dir);
	return dir;
}

afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function member(n: number): { id: string; name: string } {
	return { id: `fk:${String(n).repeat(16).slice(0, 16)}`, name: `user-${n}` };
}

function checks(ready: ReadonlySet<string>): PodChecks {
	return {
		draftComplete: () => true,
		built: () => true,
		seatState: (_podId, memberId) => ({ seatedFor: memberId }),
		holdsSeriesDeck: () => true,
		roundNamesOf: (plan) => roundNamesOf(plan, (source) => (source.kind === 'cube' ? source.cubeId : source.code)),
		hasLegalSeatDeck: (_roomId, memberId) => ready.has(memberId),
		currentTournamentDeck: (_roomId, entrant) => ({ deckOf: entrant }),
		seatTournamentDeck: () => {},
	};
}

interface Pod {
	lobby: Lobby;
	dir: string;
	id: string;
	players: { id: string; name: string }[];
	ended: SeriesEnd[];
	/** The leader: the first player unless `watchingLeader`, who then leads without an entrant seat. */
	leader: { id: string; name: string };
}

/**
 * A Classic tournament of `n` humans, locked and in round 1. `watchingLeader`
 * adds a leader who created the room and sits nowhere.
 */
async function tournament(n: number, opts: { watchingLeader?: boolean; dir?: string } = {}): Promise<Pod> {
	const dir = opts.dir ?? (await tempDir());
	const ended: SeriesEnd[] = [];
	const lobby = await openLobby({ dir, now, onSeriesEnd: (end) => ended.push(end) });
	const players = Array.from({ length: n }, (_, i) => member(i + 1));
	const leader = opts.watchingLeader === true ? member(9) : players[0]!;
	const made = lobby.create(leader, { name: `Break it ${n}`, gameType: 'constructed-1v1', clientMode: 'builtin', mode: { mode: 'classic', modeOptions: {} } });
	if (!made.ok) throw new Error(`create: ${made.reason}`);
	const id = made.room.id;
	for (const p of players) if (p.id !== leader.id) expect(lobby.join(id, p).ok).toBe(true);
	expect(lobby.setSettings(id, leader.id, { tournament: true, tournamentDecks: 'locked' }).ok).toBe(true);
	// Seated before anyone counts as ready, or the lock would fire on the second seat.
	players.forEach((p, seat) => expect(lobby.sitPod(id, p.id, seat).ok, `seat ${seat}`).toBe(true));
	lobby.setPodChecks(checks(new Set(players.map((p) => p.id))));
	const started = lobby.startDraft(id, leader.id);
	expect(started.ok, 'the field locks').toBe(true);
	expect(lobby.get(id)?.pod?.phase).toBe('rounds');
	return { lobby, dir, id, players, ended, leader };
}

function view(pod: Pod): RoomView {
	const v = pod.lobby.get(pod.id);
	if (v === undefined) throw new Error('room gone');
	return v;
}

let matchSeq = 0;

/** One game at `tableId`, won by seat `winner` (null: drawn), the way play reports it. */
function game(pod: Pod, tableId: string, winner: 0 | 1 | null): string {
	const matchId = `m-${(++matchSeq).toString(16).padStart(12, '0')}`;
	expect(pod.lobby.setTableMatch(pod.id, tableId, matchId), `${tableId}: a game starts`).toBe(true);
	expect(pod.lobby.recordGameResult(pod.id, tableId, { matchId, winner }).ok).toBe(true);
	return matchId;
}

/** Every live pairing of the current round settled 2-0 for whichever player `wins` names. */
function playRound(pod: Pod, wins: (a: string, b: string) => string = (a) => a): void {
	const { pairings, round } = view(pod).pod!;
	for (const { tableId, players: [a, b] } of pairings) {
		const winner = wins(a, b) === a ? 0 : 1;
		game(pod, tableId, winner);
		// The first game alone is never the end of a Bo3.
		expect(view(pod).pod!.round, `round ${round} waits for its second game`).toBe(round);
		game(pod, tableId, winner);
	}
}

/** The whole tournament to its end, a fixed winner rule per pairing. */
function playOut(pod: Pod, wins?: (a: string, b: string) => string): void {
	for (let guard = 0; view(pod).pod!.phase === 'rounds'; guard++) {
		expect(guard, 'the tournament reaches its end').toBeLessThan(10);
		playRound(pod, wins);
	}
}

const byesOf = (results: readonly MatchResult[]) => results.filter((r) => r.playerB === null).map((r) => r.playerA);
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

describe('odd and full counts: every entrant plays each round once, byes rotate, nobody meets twice', () => {
	for (const n of [5, 6, 7, 8]) {
		it(`${n} entrants play ${roundsFor(n)} rounds to done, no bye or pairing repeated`, async () => {
			const pod = await tournament(n);
			expect(view(pod).pod!.rounds).toBe(roundsFor(n));
			// The lower seat always wins: a lopsided field is the one that pushes byes and repeats hardest.
			const seat = (id: string) => pod.players.findIndex((p) => p.id === id);
			const roundsSeen: number[] = [];
			while (view(pod).pod!.phase === 'rounds') {
				const p = view(pod).pod!;
				roundsSeen.push(p.round);
				const inRound = [...p.pairings.flatMap((x) => x.players), ...(p.bye === null ? [] : [p.bye])];
				expect(inRound.slice().sort(), `round ${p.round}: every entrant exactly once`).toEqual(pod.players.map((x) => x.id).sort());
				expect(p.bye === null, `round ${p.round}: a bye exactly when the count is odd`).toBe(n % 2 === 0);
				playRound(pod, (a, b) => (seat(a) < seat(b) ? a : b));
			}
			const done = view(pod).pod!;
			expect(roundsSeen).toEqual(Array.from({ length: roundsFor(n) }, (_, i) => i + 1));
			expect(done.phase).toBe('done');
			const byes = byesOf(done.results);
			expect(byes, 'one bye per round when odd').toHaveLength(n % 2 === 1 ? roundsFor(n) : 0);
			expect(new Set(byes).size, 'no entrant gets a second bye').toBe(byes.length);
			const met = done.results.filter((r) => r.playerB !== null).map((r) => pairKey(r.playerA, r.playerB!));
			expect(new Set(met).size, 'no pairing repeats').toBe(met.length);
			expect(done.standings, 'everyone is ranked').toHaveLength(n);
			expect(done.standings.map((r) => r.rank)).toEqual([...done.standings.map((r) => r.rank)].sort((a, b) => a - b));
		});
	}

	it('a full 8-seat pod has no bye in any round', async () => {
		const pod = await tournament(8);
		playOut(pod);
		expect(byesOf(view(pod).pod!.results)).toEqual([]);
	});

	it('byes never repeat while avoidable, over many random fields (3–8 entrants, seeded results)', () => {
		let seed = 0x83d;
		const rand = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		for (let n = 3; n <= 8; n++) {
			for (let trial = 0; trial < 200; trial++) {
				const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, podSeat: i + 1 }));
				const results: MatchResult[] = [];
				for (let round = 1; round <= roundsFor(n); round++) {
					const { tables, bye } = pairRound({ players, results, round });
					if (bye !== null) results.push({ round, playerA: bye, playerB: null, gamesA: 2, gamesB: 0 });
					for (const [a, b] of tables) {
						const r = rand();
						results.push({ round, playerA: a, playerB: b, gamesA: r < 0.45 ? 2 : r < 0.55 ? 1 : 0, gamesB: r < 0.45 ? 0 : r < 0.55 ? 1 : 2 });
					}
				}
				const byes = byesOf(results);
				expect(new Set(byes).size, `n=${n} trial ${trial}: ${byes.join(',')}`).toBe(byes.length);
			}
		}
	});
});

describe('ties: a full tie on every key is still decided, the same however the results arrive', () => {
	it('a 4-entrant field tied two-and-two orders identically across result orders', () => {
		const players = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
		// a and c each beat one of b/d and lost to the other: a full tie on every key, timed games and all.
		const results: MatchResult[] = [
			{ round: 1, playerA: 'a', playerB: 'b', gamesA: 2, gamesB: 1, gameMs: [100, 200, 300] },
			{ round: 1, playerA: 'c', playerB: 'd', gamesA: 2, gamesB: 1, gameMs: [100, 200, 300] },
			{ round: 2, playerA: 'a', playerB: 'd', gamesA: 1, gamesB: 2, gameMs: [100, 200, 300] },
			{ round: 2, playerA: 'c', playerB: 'b', gamesA: 1, gamesB: 2, gameMs: [100, 200, 300] },
		];
		const base = standings(players, results);
		for (let i = 0; i < 24; i++) {
			// Every rotation and reversal of the results list: two results posting at once can land either way round.
			const shuffled = [...results.slice(i % 4), ...results.slice(0, i % 4)];
			if (i >= 4) shuffled.reverse();
			expect(standings(players, shuffled).map((r) => r.id)).toEqual(base.map((r) => r.id));
		}
		const ranks = new Set(base.map((r) => r.matchPoints));
		expect(ranks.size, 'all four on 3 points').toBe(1);
	});

	it('a tournament whose standings fully tie is decided past the five keys, and a restart reads the same order back', async () => {
		const pod = await tournament(4);
		// Round 1: the top seat of each table wins. Round 2: the winners meet and the losers meet; the bottom seat wins each.
		const seat = (id: string) => pod.players.findIndex((p) => p.id === id);
		playRound(pod, (a, b) => (seat(a) < seat(b) ? a : b));
		playRound(pod, (a, b) => (seat(a) > seat(b) ? a : b));
		const done = view(pod).pod!;
		expect(done.phase).toBe('done');
		const reopened = await openLobby({ dir: pod.dir, now });
		expect(reopened.get(pod.id)!.pod!.standings, 'the same order and ranks after a restart').toEqual(done.standings);
		// Every row its own place; rows equal on every key are decided by head-to-head or the seeded draw.
		for (let i = 1; i < done.standings.length; i++) {
			const [above, row] = [done.standings[i - 1]!, done.standings[i]!];
			const tied = above.matchPoints === row.matchPoints && above.opponentMatchWinPct === row.opponentMatchWinPct && above.gameWinPct === row.gameWinPct && above.opponentGameWinPct === row.opponentGameWinPct && above.medianGameMs === row.medianGameMs;
			expect(row.rank).toBe(i + 1);
			if (tied) expect(['headToHead', 'seededDraw']).toContain(row.decidedBy);
		}
	});
});

describe('dropping out: a self-drop versus leaving the room mid-round', () => {
	it('a self-drop mid-round is a loss and the round goes on', async () => {
		const pod = await tournament(4);
		const [first] = view(pod).pod!.pairings;
		const dropper = first!.players[1];
		game(pod, first!.tableId, 1);
		expect(pod.lobby.dropTableMatch(pod.id, dropper, first!.tableId).ok).toBe(true);
		const r1 = view(pod).pod!.results.find((r) => r.playerB === dropper || r.playerA === dropper)!;
		expect(r1, 'the dropper keeps the game they won and loses the match').toMatchObject({ gamesA: 2, gamesB: 1 });
		expect(view(pod).pod!.round).toBe(1);
		playRound(pod);
		expect(view(pod).pod!.round, 'the other table finishing advances the round').toBe(2);
	});

	it('a player who leaves the room mid-round, before any game, does not strand the round', async () => {
		const pod = await tournament(4);
		const [first] = view(pod).pod!.pairings;
		const [stayer, leaver] = first!.players;
		expect(pod.lobby.leave(pod.id, leaver).ok).toBe(true);
		// The other table plays out.
		const other = view(pod).pod!.pairings.find((p) => p.tableId !== first!.tableId)!;
		game(pod, other.tableId, 0);
		game(pod, other.tableId, 0);
		const after = view(pod).pod!;
		expect(after.round, 'round 1 is over: the leaver’s match cannot be played, so it is settled').toBe(2);
		expect(after.results.find((r) => r.round === 1 && (r.playerA === leaver || r.playerB === leaver)), 'the leaver’s match records as their loss').toMatchObject(
			first!.players[0] === stayer ? { playerA: stayer, gamesA: 2, gamesB: 0 } : { playerB: stayer, gamesA: 0, gamesB: 2 },
		);
	});

	it('a player who leaves the room mid-round after a game does not strand the round', async () => {
		const pod = await tournament(4);
		const [first, second] = view(pod).pod!.pairings;
		game(pod, first!.tableId, 0);
		expect(pod.lobby.leave(pod.id, first!.players[1]).ok).toBe(true);
		game(pod, second!.tableId, 0);
		game(pod, second!.tableId, 0);
		const after = view(pod).pod!;
		expect(after.round, 'round 1 is over').toBe(2);
		expect(after.results.filter((r) => r.round === 1 && r.playerB !== null), 'both of round 1’s matches are in the results').toHaveLength(2);
		expect(after.results.find((r) => r.round === 1 && r.playerA === first!.players[0]), 'the leaver’s match is the stayer’s win').toMatchObject({ playerB: first!.players[1], gamesA: 2, gamesB: 0 });
	});

	it('a player who left is never paired into a live table again', async () => {
		const pod = await tournament(4);
		const [first] = view(pod).pod!.pairings;
		const leaver = first!.players[1];
		expect(pod.lobby.leave(pod.id, leaver).ok).toBe(true);
		for (const { tableId } of view(pod).pod!.pairings.filter((p) => !p.players.includes(leaver))) {
			game(pod, tableId, 0);
			game(pod, tableId, 0);
		}
		const later = view(pod).pod!;
		expect(later.round).toBe(2);
		const stuck = later.pairings.filter((p) => p.players.includes(leaver));
		expect(stuck, `round 2 pairs nobody against ${leaver}, who is gone`).toEqual([]);
	});
});

describe('the leader leaving mid-tournament', () => {
	it('an entrant leader leaves: leadership passes to the earliest remaining member, and the tournament plays on', async () => {
		const pod = await tournament(4);
		const before = view(pod).pod!;
		const leaderTable = before.pairings.find((p) => p.players.includes(pod.leader.id))!;
		game(pod, leaderTable.tableId, 0);
		expect(pod.lobby.leave(pod.id, pod.leader.id).ok).toBe(true);
		expect(view(pod).leader, 'the second to join leads now').toBe(pod.players[1]!.id);
		for (const { tableId } of view(pod).pod!.pairings.filter((p) => p.tableId !== leaderTable.tableId)) {
			game(pod, tableId, 0);
			game(pod, tableId, 0);
		}
		expect(view(pod).pod!.round, 'the departed leader does not strand round 1').toBe(2);
	});

	it('a watching leader leaves mid-round: leadership passes, pairings and standings are untouched', async () => {
		const pod = await tournament(4, { watchingLeader: true });
		const before = view(pod).pod!;
		expect(pod.lobby.leave(pod.id, pod.leader.id).ok).toBe(true);
		const after = view(pod);
		expect(after.leader, 'the first entrant to join leads now').toBe(pod.players[0]!.id);
		expect(after.pod!.pairings).toEqual(before.pairings);
		playOut(pod);
		expect(view(pod).pod!.phase).toBe('done');
	});
});

describe('round end: results posting at once', () => {
	it('the last two tables finishing back to back advance the round exactly once', async () => {
		const pod = await tournament(4);
		const logged: Record<string, unknown>[] = [];
		const lobby = await openLobby({ dir: pod.dir, now, log: (e) => logged.push(e) });
		lobby.setPodChecks(checks(new Set(pod.players.map((p) => p.id))));
		const live: Pod = { ...pod, lobby };
		const [a, b] = view(live).pod!.pairings;
		game(live, a!.tableId, 0);
		game(live, b!.tableId, 0);
		// Both deciding games end in the same tick: two match ids, two writes, one round boundary.
		const ma = 'm-aaaaaaaaaaaa';
		const mb = 'm-bbbbbbbbbbbb';
		expect(lobby.setTableMatch(pod.id, a!.tableId, ma) && lobby.setTableMatch(pod.id, b!.tableId, mb)).toBe(true);
		const [ra, rb] = [lobby.recordGameResult(pod.id, a!.tableId, { matchId: ma, winner: 0 }), lobby.recordGameResult(pod.id, b!.tableId, { matchId: mb, winner: 0 })];
		expect(ra.ok && rb.ok).toBe(true);
		const p = view(live).pod!;
		expect(p.round).toBe(2);
		expect(p.results.filter((r) => r.round === 1)).toHaveLength(2);
		expect(logged.filter((e) => e.event === 'pod-round-started' && e.round === 2), 'round 2 started once').toHaveLength(1);
		expect(p.pairings).toHaveLength(2);
	});

	it('the same final result reported twice counts once', async () => {
		const pod = await tournament(2);
		const tableId = view(pod).pod!.pairings[0]!.tableId;
		game(pod, tableId, 0);
		const last = game(pod, tableId, 0);
		expect(view(pod).pod!.phase).toBe('done');
		pod.lobby.recordGameResult(pod.id, tableId, { matchId: last, winner: 1 });
		const done = view(pod).pod!;
		expect(done.results).toHaveLength(1);
		expect(done.results[0]).toMatchObject({ gamesA: 2, gamesB: 0 });
		expect(pod.ended, 'one series result to stats').toHaveLength(1);
		expect(view(pod).tables.find((t) => t.id === tableId)!.series, 'the table’s series is not touched by the echo').toMatchObject({ wins: [2, 0], games: [{ winner: 0 }, { winner: 0 }] });
	});
});

describe('a match whose JVM dies', () => {
	it('a game that ends with no outcome leaves the series where it was and the table free for the next game', async () => {
		const pod = await tournament(2);
		const tableId = view(pod).pod!.pairings[0]!.tableId;
		game(pod, tableId, 0);
		expect(pod.lobby.setTableMatch(pod.id, tableId, 'm-deadbeef0001')).toBe(true);
		// What play does when the bridge is gone: no outcome, so the match is let go (`endTableMatch`).
		expect(pod.lobby.releaseTableMatch(pod.id, tableId)).toBe(true);
		const table = view(pod).tables.find((t) => t.id === tableId)!;
		expect(table.matchId).toBeNull();
		expect(table.series).toMatchObject({ wins: [1, 0], games: [{ winner: 0 }] });
		expect(view(pod).pod!.round, 'the round is still on').toBe(1);
		game(pod, tableId, 0);
		expect(view(pod).pod!.phase, 'the replayed game decides the match').toBe('done');
	});
});

describe('odd series results', () => {
	it('a Bo3 at 1-1 whose third game is drawn by the time limit is a drawn match: one point each', async () => {
		const pod = await tournament(2);
		const tableId = view(pod).pod!.pairings[0]!.tableId;
		game(pod, tableId, 0);
		game(pod, tableId, 1);
		game(pod, tableId, null);
		const done = view(pod).pod!;
		expect(done.phase).toBe('done');
		expect(done.results[0]).toMatchObject({ gamesA: 1, gamesB: 1 });
		expect(done.standings.map((r) => r.matchPoints)).toEqual([1, 1]);
		expect(done.standings.map((r) => [r.rank, r.decidedBy]), 'a drawn match leaves head-to-head level, so the draw decides').toEqual([[1, null], [2, 'seededDraw']]);
		expect(pod.ended.map((e) => e.winner)).toEqual([null]);
	});

	it('a drawn first game does not end a Bo3', async () => {
		const pod = await tournament(2);
		const tableId = view(pod).pod!.pairings[0]!.tableId;
		game(pod, tableId, null);
		expect(view(pod).pod!.phase).toBe('rounds');
		game(pod, tableId, 0);
		game(pod, tableId, 0);
		expect(view(pod).pod!.results[0]).toMatchObject({ gamesA: 2, gamesB: 0 });
	});

	it('three drawn games end the match drawn, never stranded', async () => {
		const pod = await tournament(2);
		const tableId = view(pod).pod!.pairings[0]!.tableId;
		for (let i = 0; i < 3; i++) game(pod, tableId, null);
		expect(view(pod).pod!).toMatchObject({ phase: 'done', results: [{ gamesA: 0, gamesB: 0 }] });
	});
});

describe('a restart mid-tournament', () => {
	it('a restart in round 2 resumes with the same pairings, bye, standings and next round as a run with no restart', async () => {
		const seat = (players: { id: string }[]) => (id: string) => players.findIndex((p) => p.id === id);
		const plain = await tournament(5);
		const restarted = await tournament(5);
		for (const pod of [plain, restarted]) playRound(pod, (a, b) => (seat(pod.players)(a) < seat(pod.players)(b) ? a : b));
		// One game into round 2, then the restart.
		for (const pod of [plain, restarted]) game(pod, view(pod).pod!.pairings[0]!.tableId, 0);
		const before = view(restarted).pod!;
		const lobby = await openLobby({ dir: restarted.dir, now });
		lobby.setPodChecks(checks(new Set(restarted.players.map((p) => p.id))));
		const after: Pod = { ...restarted, lobby };
		expect(view(after).pod!).toEqual(before);
		expect(view(after).tables.find((t) => t.id === before.pairings[0]!.tableId)!.series.wins, 'the game played before the restart still counts').toEqual([1, 0]);
		for (const pod of [plain, after]) {
			game(pod, view(pod).pod!.pairings[0]!.tableId, 0);
			for (const { tableId } of view(pod).pod!.pairings.slice(1)) {
				game(pod, tableId, 0);
				game(pod, tableId, 0);
			}
		}
		const ids = (pod: Pod) => (id: string) => `p${seat(pod.players)(id)}`;
		const shape = (pod: Pod) => {
			const p = view(pod).pod!;
			return { round: p.round, bye: p.bye === null ? null : ids(pod)(p.bye), pairings: p.pairings.map((x) => x.players.map(ids(pod))), standings: p.standings.map((r) => ({ ...r, id: ids(pod)(r.id) })) };
		};
		expect(shape(after), 'round 3 after the restart is round 3 without one').toEqual(shape(plain));
	});

	it('a restart with a game in play keeps the table’s match id', async () => {
		const pod = await tournament(2);
		const tableId = view(pod).pod!.pairings[0]!.tableId;
		expect(pod.lobby.setTableMatch(pod.id, tableId, 'm-0123456789ab')).toBe(true);
		const reopened = await openLobby({ dir: pod.dir, now });
		expect(reopened.get(pod.id)!.tables.find((t) => t.id === tableId)!.matchId).toBe('m-0123456789ab');
	});
});
