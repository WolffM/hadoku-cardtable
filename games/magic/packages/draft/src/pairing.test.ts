/*
 * Pod pairing and standings.
 *
 * `pairRound`'s two halves (round 1's seat formula, later rounds' score-based
 * backtracking) are each checked directly against a hand-worked case, then
 * against a randomized property (no repeat pairing, no double bye) over many
 * seeded simulated pods — the backtracking search is the part worth
 * stress-testing, since a hand-worked case alone would not have caught a
 * regression that only shows up when the "pair down from the top" greedy
 * choice needs to backtrack.
 */

import { describe, expect, it } from 'vitest';
import { rngFromSeed, type Rng } from './rng.ts';
import {
  pairRound,
  rankedStandings,
  rankStandings,
  roundsFor,
  standings,
  type MatchResult,
  type PodPlayer,
} from './pairing.ts';

function players(ids: string[]): PodPlayer[] {
  return ids.map((id, i) => ({ id, podSeat: i + 1 }));
}

/** A 2-0 result: `a` beats `b`. */
function win(round: number, a: string, b: string): MatchResult {
  return { round, playerA: a, playerB: b, gamesA: 2, gamesB: 0 };
}

function bye(round: number, a: string): MatchResult {
  return { round, playerA: a, playerB: null, gamesA: 2, gamesB: 0 };
}

describe('roundsFor: one field-wide Swiss, at most 3 rounds (the operator, 2026-10-31)', () => {
  it('13 entrants play 3 rounds', () => expect(roundsFor(13)).toBe(3));
  it('40 entrants play 3 rounds', () => expect(roundsFor(40)).toBe(3));
});

describe('roundsFor', () => {
  it.each([
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 2],
    [5, 3],
    [6, 3],
    [7, 3],
    [8, 3],
    [9, 3],
    [13, 3],
    [16, 3],
    [17, 3],
    [40, 3],
    [64, 3],
  ])('roundsFor(%i) === %i', (n, expected) => {
    expect(roundsFor(n)).toBe(expected);
  });
});

describe('pairRound round 1 (across the table)', () => {
  for (let h = 2; h <= 8; h++) {
    it(`H=${h}: every player appears exactly once, bye matches the seat formula`, () => {
      const ids = Array.from({ length: h }, (_, i) => `p${i + 1}`);
      const { tables, bye: byeId } = pairRound({ players: players(ids), results: [], round: 1 });

      const half = Math.ceil(h / 2);
      const expectedPairs: [string, string][] = [];
      for (let i = 0; i < h - half; i++) {
        expectedPairs.push([ids[i] as string, ids[i + half] as string]);
      }
      const expectedBye = h % 2 === 1 ? (ids[half - 1] as string) : null;

      expect(tables).toEqual(expectedPairs);
      expect(byeId).toBe(expectedBye);

      // Every player appears exactly once, whether paired or on the bye.
      const seen = tables.flat();
      if (byeId !== null) seen.push(byeId);
      expect(seen.slice().sort()).toEqual(ids.slice().sort());
    });
  }

  it('H=5 names seat 3 as the one who sits out (this wave\'s reading of the odd-H formula)', () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
    const { tables, bye: byeId } = pairRound({ players: players(ids), results: [], round: 1 });
    expect(tables).toEqual([
      ['p1', 'p4'],
      ['p2', 'p5'],
    ]);
    expect(byeId).toBe('p3');
  });
});

describe('pairRound later rounds: score-based, avoiding a repeat pairing', () => {
  it('pairs by match points when no repeat is at stake', () => {
    // Round 1: p1 beats p3, p2 beats p4. Round 2 should pair the two leaders
    // (p1, p2) and the two trailers (p3, p4) — neither pair is a repeat of
    // round 1's (p1,p3)/(p2,p4).
    const ids = ['p1', 'p2', 'p3', 'p4'];
    const results = [win(1, 'p1', 'p3'), win(1, 'p2', 'p4')];
    const { tables, bye: byeId } = pairRound({ players: players(ids), results, round: 2 });
    expect(byeId).toBeNull();
    expect(tables).toEqual([
      ['p1', 'p2'],
      ['p3', 'p4'],
    ]);
  });

  it('backtracks away from a repeat the naive top-down greedy would make', () => {
    // A 4-player mini round-robin. Round 1 = {p1-p3, p2-p4} (this wave's
    // round-1 seat formula). Round 2 results are chosen so round 2's own
    // pairing is {p1-p2, p3-p4} (see the next test). After those two rounds,
    // every pair has played except {p1-p4, p2-p3} — the only pairing left
    // that repeats nothing. Round 3's standings put p1 alone on top (won
    // both), p2 and p3 tied in the middle (one win each), p4 last (lost
    // both) — so the naive "pair adjacent ranks" greedy would try p1-p2
    // first, which already played in round 2. A correct search must notice
    // that and back off to the only repeat-free matching.
    const ids = ['p1', 'p2', 'p3', 'p4'];
    const results = [
      win(1, 'p1', 'p3'),
      win(1, 'p2', 'p4'),
      win(2, 'p1', 'p2'),
      win(2, 'p3', 'p4'),
    ];
    const { tables, bye: byeId } = pairRound({ players: players(ids), results, round: 3 });
    expect(byeId).toBeNull();
    const asSets = tables.map((t) => new Set(t));
    expect(asSets.some((s) => s.has('p1') && s.has('p4'))).toBe(true);
    expect(asSets.some((s) => s.has('p2') && s.has('p3'))).toBe(true);
    // Neither round-1 nor round-2 pair reappears.
    for (const pair of tables) {
      const s = new Set(pair);
      expect(s.has('p1') && s.has('p3')).toBe(false);
      expect(s.has('p2') && s.has('p4')).toBe(false);
      expect(s.has('p1') && s.has('p2')).toBe(false);
      expect(s.has('p3') && s.has('p4')).toBe(false);
    }
  });

  it('gives the bye to the lowest-ranked player who has not already had one', () => {
    // H=5. Round 1 bye went to p3 (the seat formula). Round 2: p3 has the
    // fewest points among those without a prior bye tie only with... make p3
    // clearly last by match points too, so the "lowest-ranked" and "no prior
    // bye" criteria would agree even without the no-double-bye rule — then
    // flip it: give p3 the most points, so the bye must skip the
    // lowest-ranked-but-already-byed player and land on the next one down.
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
    const results = [
      bye(1, 'p3'),
      win(1, 'p1', 'p4'),
      win(1, 'p2', 'p5'),
      // Round 2: p3 wins big, everyone else stays put, so by points p3 is on
      // top and should never be offered the bye again regardless.
      win(2, 'p3', 'p1'),
    ];
    const { bye: byeId } = pairRound({ players: players(ids), results, round: 3 });
    expect(byeId).not.toBe('p3');
  });
});

describe('no player gets two byes, and no pairing repeats, over a simulated pod', () => {
  function simulate(h: number, seed: string): { allTables: [string, string][][]; byes: (string | null)[] } {
    const ids = Array.from({ length: h }, (_, i) => `p${i + 1}`);
    const rounds = roundsFor(h);
    const results: MatchResult[] = [];
    const allTables: [string, string][][] = [];
    const byes: (string | null)[] = [];
    const rng: Rng = rngFromSeed(seed);

    for (let round = 1; round <= rounds; round++) {
      const { tables, bye: byeId } = pairRound({ players: players(ids), results, round });
      allTables.push(tables);
      byes.push(byeId);
      if (byeId !== null) results.push(bye(round, byeId));
      for (const [a, b] of tables) {
        // A random, possibly-drawn result, seeded for reproducibility.
        const roll = rng.int(5); // 0,1 draw; 2,3 a wins; 4 b wins
        if (roll <= 1) results.push({ round, playerA: a, playerB: b, gamesA: 1, gamesB: 1 });
        else if (roll <= 3) results.push(win(round, a, b));
        else results.push(win(round, b, a));
      }
    }
    return { allTables, byes };
  }

  // One pod's sizes take 200 seeds each; a field-wide Swiss over several pods (9–64 entrants) takes 20.
  const sizes = Array.from({ length: 63 }, (_, i) => i + 2);
  for (const h of sizes) {
    const seeds = h <= 8 ? 200 : 20;
    it(`H=${h}: ${seeds} seeded fields never repeat a pairing and never double-bye`, () => {
      for (let seed = 0; seed < seeds; seed++) {
        const { allTables, byes } = simulate(h, `h${h}-seed${seed}`);

        const seenPairs = new Set<string>();
        for (const tables of allTables) {
          for (const [a, b] of tables) {
            const key = a < b ? `${a}|${b}` : `${b}|${a}`;
            expect(seenPairs.has(key)).toBe(false);
            seenPairs.add(key);
          }
        }

        const byeCounts = new Map<string, number>();
        for (const b of byes) {
          if (b === null) continue;
          byeCounts.set(b, (byeCounts.get(b) ?? 0) + 1);
        }
        for (const count of byeCounts.values()) {
          expect(count).toBeLessThanOrEqual(1);
        }
      }
    });
  }
});

describe('standings', () => {
  it('ranks by match points first', () => {
    const ps = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
    const results = [win(1, 'p1', 'p2'), bye(1, 'p3')];
    const rows = standings(ps, results);
    expect(rows.map((r) => r.id)).toEqual(['p1', 'p3', 'p2']);
    expect(rows[0]?.matchPoints).toBe(3);
    expect(rows[2]?.matchPoints).toBe(0);
  });

  it('breaks a match-point tie by opponents match-win percentage, floored at 33%', () => {
    // p1 and p2 both have one win (3 points). p1 beat p3, who has gone on to
    // beat nobody (0% match wins, floored to 33%). p2 beat p4, who then beat
    // p3 (p4's match-win % is 50%, well above the floor). So p2's opponent
    // (p4) outranks p1's opponent (p3) on the floor-adjusted percentage, and
    // p2 should rank above p1 despite equal match points.
    const ps = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }];
    const results = [
      win(1, 'p1', 'p3'),
      win(1, 'p2', 'p4'),
      win(2, 'p4', 'p3'),
    ];
    const rows = standings(ps, results);
    const p1 = rows.find((r) => r.id === 'p1');
    const p2 = rows.find((r) => r.id === 'p2');
    expect(p1?.matchPoints).toBe(p2?.matchPoints);
    expect(p2 !== undefined && p1 !== undefined && p2.opponentMatchWinPct > p1.opponentMatchWinPct).toBe(true);
    expect(rows.findIndex((r) => r.id === 'p2')).toBeLessThan(rows.findIndex((r) => r.id === 'p1'));
  });

  it('a bye counts as a 2-0 win toward the bye recipient\'s own game-win percentage', () => {
    const ps = [{ id: 'p1' }];
    const rows = standings(ps, [bye(1, 'p1')]);
    expect(rows[0]?.gameWinPct).toBe(1);
    expect(rows[0]?.matchPoints).toBe(3);
  });
});

/** `a` beats `b` 2-1, its three games lasting `ms` each. */
function timed(round: number, a: string, b: string, ms: number[], games: [number, number] = [2, 1]): MatchResult {
  return { round, playerA: a, playerB: b, gamesA: games[0], gamesB: games[1], gameMs: ms };
}

describe('standings: five tiebreakers, the fifth the fastest median game (the operator, 2026-10-23)', () => {
  it('ranks by median game length after the four Swiss tiebreakers, faster first', () => {
    // A round robin of three at 1-1 each: equal points, and every opponent percentage equal by symmetry;
    // each won 2-1 and lost 1-2, so equal game-win %. Only the speed of their games separates them.
    const ps = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
    const results = [timed(1, 'p1', 'p2', [600_000, 600_000, 600_000]), timed(2, 'p2', 'p3', [300_000, 300_000, 300_000]), timed(3, 'p3', 'p1', [900_000, 900_000, 900_000])];
    const rows = standings(ps, results);
    expect(new Set(rows.map((r) => r.matchPoints)).size).toBe(1);
    expect(new Set(rows.map((r) => r.opponentMatchWinPct)).size).toBe(1);
    expect(new Set(rows.map((r) => r.gameWinPct)).size).toBe(1);
    expect(new Set(rows.map((r) => r.opponentGameWinPct)).size).toBe(1);
    // p2's games: 600,600,600,300,300,300 → median 450 s; p3's: 300×3, 900×3 → 600 s; p1's: 600×3, 900×3 → 750 s.
    expect(rows.map((r) => [r.id, r.medianGameMs])).toEqual([
      ['p2', 450_000],
      ['p3', 600_000],
      ['p1', 750_000],
    ]);
  });

  it('puts a player with no timed game after any player with one, and a bye times nothing', () => {
    const ps = [{ id: 'p1' }, { id: 'p2' }];
    const results = [bye(1, 'p1'), bye(1, 'p2'), timed(2, 'p2', 'x', [60_000, 60_000, 60_000]), { round: 2, playerA: 'p1', playerB: 'y', gamesA: 2, gamesB: 1 }];
    const rows = standings(ps, results);
    expect(rows.find((r) => r.id === 'p1')?.medianGameMs).toBeNull();
    expect(rows.find((r) => r.id === 'p2')?.medianGameMs).toBe(60_000);
  });

  it('separates three players at 2-1 by each tiebreaker in turn, and says which one decided each pair', () => {
    const ranked = rankStandings([
      { id: 'a', matchPoints: 6, opponentMatchWinPct: 0.6, gameWinPct: 0.6, opponentGameWinPct: 0.5, medianGameMs: 500 },
      { id: 'b', matchPoints: 6, opponentMatchWinPct: 0.5, gameWinPct: 0.7, opponentGameWinPct: 0.5, medianGameMs: 500 },
      { id: 'c', matchPoints: 6, opponentMatchWinPct: 0.5, gameWinPct: 0.6, opponentGameWinPct: 0.6, medianGameMs: 500 },
      { id: 'd', matchPoints: 6, opponentMatchWinPct: 0.5, gameWinPct: 0.6, opponentGameWinPct: 0.5, medianGameMs: 400 },
      { id: 'e', matchPoints: 6, opponentMatchWinPct: 0.5, gameWinPct: 0.6, opponentGameWinPct: 0.5, medianGameMs: 500 },
      { id: 'f', matchPoints: 6, opponentMatchWinPct: 0.5, gameWinPct: 0.6, opponentGameWinPct: 0.5, medianGameMs: null },
      { id: 'g', matchPoints: 3, opponentMatchWinPct: 0.9, gameWinPct: 0.9, opponentGameWinPct: 0.9, medianGameMs: 100 },
    ]);
    expect(ranked.map((r) => [r.id, r.rank, r.decidedBy])).toEqual([
      ['a', 1, null],
      ['b', 2, 'opponentMatchWinPct'],
      ['c', 3, 'gameWinPct'],
      ['d', 4, 'opponentGameWinPct'],
      ['e', 5, 'medianGameMs'],
      ['f', 6, 'medianGameMs'],
      ['g', 7, 'matchPoints'],
    ]);
  });


});

describe('a complete order: head-to-head, then a seeded draw (the operator, 2026-10-31)', () => {
  const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

  it('40 entrants over 3 field-wide rounds rank in one total order: every rank its own, every row a reason', () => {
    const rng = rngFromSeed('field-40');
    const field = players(Array.from({ length: 40 }, (_, i) => `p${i + 1}`));
    const results: MatchResult[] = [];
    for (let round = 1; round <= roundsFor(field.length); round++) {
      const { tables, bye: byeId } = pairRound({ players: field, results, round });
      if (byeId !== null) results.push(bye(round, byeId));
      for (const [a, b] of tables) results.push(rng.int(2) === 0 ? win(round, a, b) : win(round, b, a));
    }
    const ranked = rankedStandings(field, results, 'room-1-1700000000000');
    expect(ranked.map((r) => r.rank)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(ranked[0]?.decidedBy).toBeNull();
    for (const row of ranked.slice(1)) expect(row.decidedBy).not.toBeNull();
  });

  // a beat b, b beat c, c beat a, d beat e, e beat f, f beat d — then the two triangles cross: a–d, b–e, c–f
  // all drawn 1–1. Six players, each 1 win 1 loss 1 draw, every percentage equal, no game timed: a full
  // tie on all five keys. Head-to-head inside the tie: each one's points against the other five are the
  // same (3+0+1), so it cannot separate them either, and the seeded draw has to.
  const sixWay: MatchResult[] = [
    win(1, 'a', 'b'),
    win(1, 'd', 'e'),
    { round: 1, playerA: 'c', playerB: 'f', gamesA: 1, gamesB: 1 },
    win(2, 'b', 'c'),
    win(2, 'e', 'f'),
    { round: 2, playerA: 'a', playerB: 'd', gamesA: 1, gamesB: 1 },
    win(3, 'c', 'a'),
    win(3, 'f', 'd'),
    { round: 3, playerA: 'b', playerB: 'e', gamesA: 1, gamesB: 1 },
  ];
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id }));

  it('a full tie on all five keys is broken by the seeded draw, and every row names it', () => {
    const ranked = rankedStandings(six, sixWay, 'tourney-x');
    expect(new Set(ranked.map((r) => r.matchPoints)).size).toBe(1);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ranked.slice(1).map((r) => r.decidedBy)).toEqual(Array(5).fill('seededDraw'));
  });

  it('the seeded draw is a function of the tournament id: the same id draws the same order, another id may not', () => {
    const order = ids(rankedStandings(six, sixWay, 'tourney-x'));
    expect(ids(rankedStandings(six, sixWay, 'tourney-x'))).toEqual(order);
    const others = ['tourney-y', 'tourney-z', 'room-7-1', 'room-7-2'].map((seed) => ids(rankedStandings(six, sixWay, seed)).join());
    expect(others.some((o) => o !== order.join()), 'four other ids all drew the identical order').toBe(true);
  });

  it('head-to-head breaks a five-key tie before the draw: where the tied players met, the winner ranks higher', () => {
    // Rows tied on all five keys, injected directly; only the results among them can separate them.
    const row = { matchPoints: 6, opponentMatchWinPct: 0.5, gameWinPct: 0.6, opponentGameWinPct: 0.5, medianGameMs: null };
    const results = [win(1, 'q', 'p'), win(2, 'r', 'q'), win(3, 'q', 's')];
    // Of the tied p, q, r: q took 3 from p and lost to r (3 points among the tied), r took 3 from q (3), p none.
    // q and r tie on head-to-head too, so the draw separates them; p is last on head-to-head whatever the seed.
    for (const seed of ['s1', 's2', 's3', 's4', 's5']) {
      const tied = [{ id: 'p', ...row }, { id: 'q', ...row }, { id: 'r', ...row }];
      const ranked = rankStandings(tied, results, seed);
      expect(ranked.map((r) => r.id).at(-1), `seed ${seed}`).toBe('p');
      expect(ranked.at(-1)?.decidedBy).toBe('headToHead');
      expect(ranked[1]?.decidedBy).toBe('seededDraw');
    }
  });

  it('the order and every reason are the same however the results arrive', () => {
    const base = rankedStandings(six, sixWay, 'tourney-x');
    for (let i = 0; i < sixWay.length * 2; i++) {
      const rotated = [...sixWay.slice(i % sixWay.length), ...sixWay.slice(0, i % sixWay.length)];
      if (i >= sixWay.length) rotated.reverse();
      expect(rankedStandings([...six].reverse(), rotated, 'tourney-x')).toEqual(base);
    }
  });
});
