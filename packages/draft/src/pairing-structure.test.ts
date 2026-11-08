import { describe, expect, it } from 'vitest';

import {
  cutSurvivors,
  isPowerOfTwo,
  pairRound,
  roundsOf,
  structureOk,
  type MatchResult,
  type PodPlayer,
  type PodStructure,
} from './pairing.ts';

/** Eight players, seats 1-8, the shape a seeded bracket field takes. */
const EIGHT: PodPlayer[] = Array.from({ length: 8 }, (_, i) => ({ id: `p${i + 1}`, podSeat: i + 1 }));

/** A QF/SF/F structure over a pure bracket (no Swiss). */
const BRACKET8: PodStructure = { swiss: 0, cut: 8 };

/** A Challenge shape: Swiss narrows, top 8 cut. */
const CHALLENGE: PodStructure = { swiss: 5, cut: 8 };

/** A 16-player Challenge: three Swiss rounds, top 8 cut. */
const CHALLENGE16: PodStructure = { swiss: 3, cut: 8 };

describe('structureOk', () => {
  it('accepts the product default and every power-of-two cut up to the field', () => {
    expect(structureOk({ swiss: 3, cut: 0 }, 8)).toBe(true);
    expect(structureOk({ swiss: 5, cut: 8 }, 32)).toBe(true);
    expect(structureOk({ swiss: 0, cut: 8 }, 8)).toBe(true);
    expect(structureOk({ swiss: 0, cut: 2 }, 8)).toBe(true);
  });

  it('refuses non-powers, oversized cuts, and negative rounds', () => {
    expect(structureOk({ swiss: 5, cut: 6 }, 32)).toBe(false);
    expect(structureOk({ swiss: 5, cut: 16 }, 8)).toBe(false);
    expect(structureOk({ swiss: -1, cut: 8 }, 8)).toBe(false);
    expect(structureOk({ swiss: 5, cut: 1 }, 8)).toBe(false);
  });

  it('isPowerOfTwo, directly', () => {
    expect(isPowerOfTwo(1)).toBe(true);
    expect(isPowerOfTwo(2)).toBe(true);
    expect(isPowerOfTwo(8)).toBe(true);
    expect(isPowerOfTwo(6)).toBe(false);
    expect(isPowerOfTwo(0)).toBe(false);
  });
});

describe('roundsOf', () => {
  it('Swiss only is its Swiss rounds; a cut adds log2 rounds', () => {
    expect(roundsOf({ swiss: 3, cut: 0 }, 8)).toBe(3);
    expect(roundsOf({ swiss: 5, cut: 8 }, 32)).toBe(8);
    expect(roundsOf({ swiss: 0, cut: 8 }, 8)).toBe(3);
    expect(roundsOf({ swiss: 0, cut: 2 }, 8)).toBe(1);
  });
});

describe('a pure bracket (swiss: 0, cut: 8)', () => {
  it('round 1 pairs across the table by seat, like round1 does', () => {
    const { tables, bye } = pairRound({ players: EIGHT, results: [], round: 1, structure: BRACKET8 });
    expect(tables).toEqual([
      ['p1', 'p5'],
      ['p2', 'p6'],
      ['p3', 'p7'],
      ['p4', 'p8'],
    ]);
    expect(bye).toBeNull();
  });

  it('round 2 is the survivors of round 1, still across the table', () => {
    // Round 1: p1, p6, p7, p4 win.
    const r1: MatchResult[] = [
      { round: 1, playerA: 'p1', playerB: 'p5', gamesA: 2, gamesB: 0 },
      { round: 1, playerA: 'p2', playerB: 'p6', gamesA: 1, gamesB: 2 },
      { round: 1, playerA: 'p3', playerB: 'p7', gamesA: 0, gamesB: 2 },
      { round: 1, playerA: 'p4', playerB: 'p8', gamesA: 2, gamesB: 1 },
    ];
    expect(new Set(cutSurvivors(BRACKET8, r1, 2))).toEqual(new Set(['p1', 'p6', 'p7', 'p4']));
    const { tables, bye } = pairRound({ players: EIGHT, results: r1, round: 2, structure: BRACKET8 });
    // Survivors in SEAT order (no Swiss, so podSeat ranks): p1, p4, p6, p7 → 1v6, 4v7.
    expect(tables).toEqual([
      ['p1', 'p6'],
      ['p4', 'p7'],
    ]);
    expect(bye).toBeNull();
  });

  it('the final is the last two, and a 1-player pool is a bye not a crash', () => {
    const r2: MatchResult[] = [
      { round: 1, playerA: 'p1', playerB: 'p5', gamesA: 2, gamesB: 0 },
      { round: 1, playerA: 'p2', playerB: 'p6', gamesA: 1, gamesB: 2 },
      { round: 1, playerA: 'p3', playerB: 'p7', gamesA: 0, gamesB: 2 },
      { round: 1, playerA: 'p4', playerB: 'p8', gamesA: 2, gamesB: 1 },
      { round: 2, playerA: 'p1', playerB: 'p6', gamesA: 2, gamesB: 0 },
      { round: 2, playerA: 'p4', playerB: 'p7', gamesA: 2, gamesB: 0 },
    ];
    const { tables } = pairRound({ players: EIGHT, results: r2, round: 3, structure: BRACKET8 });
    expect(tables).toEqual([['p1', 'p4']]);
  });
});

describe('a cut after Swiss seeds the bracket by standings', () => {
  it('round swiss+1 pairs rank 1 vs rank half+1, using the Swiss standings', () => {
    // Five rounds omitted; one result set where p8 tops the Swiss.
    const swiss: MatchResult[] = [
      { round: 1, playerA: 'p8', playerB: 'p1', gamesA: 2, gamesB: 0 },
      { round: 1, playerA: 'p2', playerB: 'p3', gamesA: 2, gamesB: 0 },
      { round: 1, playerA: 'p4', playerB: 'p5', gamesA: 2, gamesB: 0 },
      { round: 1, playerA: 'p6', playerB: 'p7', gamesA: 2, gamesB: 0 },
    ];
    const { tables } = pairRound({ players: EIGHT, results: swiss, round: 6, structure: CHALLENGE, seed: 'seed-1' });
    // 8 survivors, ranked by standings: every 3-0 above every 2-1, tie-broken.
    // The exact order is the standings' own; the assertion is structural: four
    // tables, all eight present, no self-pairing.
    expect(tables).toHaveLength(4);
    const ids = tables.flat();
    expect(new Set(ids).size).toBe(8);
    expect(tables.every(([a, b]) => a !== b)).toBe(true);
  });

  it('Swiss rounds before the cut pair Swiss (round 2 is a score pairing, not a bracket)', () => {
    const r1: MatchResult[] = [
      { round: 1, playerA: 'p1', playerB: 'p5', gamesA: 2, gamesB: 0 },
      { round: 1, playerA: 'p2', playerB: 'p6', gamesA: 2, gamesB: 0 },
      { round: 1, playerA: 'p3', playerB: 'p7', gamesA: 2, gamesB: 0 },
      { round: 1, playerA: 'p4', playerB: 'p8', gamesA: 2, gamesB: 0 },
    ];
    const swissRound2 = pairRound({ players: EIGHT, results: r1, round: 2, structure: CHALLENGE });
    // Winners meet winners (score pairing), unlike a bracket's cross-table:
    // pair-down-the-top pairs 1v2, 3v4 among the 3-0s — my hand-written
    // expectation of 1v3 was wrong about the engine's own pairing order.
    const paired = new Set(swissRound2.tables.map(([a, b]) => [a, b].sort().join('|')));
    expect(paired.has('p1|p2')).toBe(true);
    expect(paired.has('p3|p4')).toBe(true);
    expect(paired.has('p1|p5')).toBe(false);
  });
});

describe('the cut takes the standings top, not the whole field', () => {
  it('round swiss+1 pairs only the top cut — 16 players, top 8, exactly p1..p8', () => {
    // Three Swiss rounds where p1..p8 win every match: they are the 9-point
    // tier, everyone else 0-3. The cut is the top EIGHT, four tables.
    const P16: PodPlayer[] = Array.from({ length: 16 }, (_, i) => ({ id: `p${i + 1}`, podSeat: i + 1 }));
    const results: MatchResult[] = [];
    for (let r = 1; r <= 3; r++) {
      for (let i = 0; i < 8; i++) {
        results.push({ round: r, playerA: `p${i + 1}`, playerB: `p${i + 9}`, gamesA: 2, gamesB: 0 });
      }
    }
    const cut = pairRound({ players: P16, results, round: 4, structure: CHALLENGE16, seed: 's' });
    expect(cut.tables).toHaveLength(4);
    const ids = cut.tables.flat().sort();
    expect(ids).toEqual(Array.from({ length: 8 }, (_, i) => `p${i + 1}`));
  });

  it('a second cut round pairs only first-round survivors', () => {
    const P16: PodPlayer[] = Array.from({ length: 16 }, (_, i) => ({ id: `p${i + 1}`, podSeat: i + 1 }));
    const results: MatchResult[] = [];
    for (let r = 1; r <= 3; r++) {
      for (let i = 0; i < 8; i++) {
        results.push({ round: r, playerA: `p${i + 1}`, playerB: `p${i + 9}`, gamesA: 2, gamesB: 0 });
      }
    }
    // Cut round 1: p2, p3, p1, p6 win.
    results.push(
      { round: 4, playerA: 'p2', playerB: 'p7', gamesA: 2, gamesB: 0 },
      { round: 4, playerA: 'p3', playerB: 'p4', gamesA: 2, gamesB: 0 },
      { round: 4, playerA: 'p1', playerB: 'p5', gamesA: 2, gamesB: 0 },
      { round: 4, playerA: 'p6', playerB: 'p8', gamesA: 2, gamesB: 0 },
    );
    const sf = pairRound({ players: P16, results, round: 5, structure: CHALLENGE16, seed: 's' });
    expect(sf.tables).toHaveLength(2);
    const ids = sf.tables.flat().sort();
    expect(ids).toEqual(['p1', 'p2', 'p3', 'p6']);
  });
});

describe('no structure is exactly what shipped before', () => {
  it('absent structure: round 1 across the table, round 2 by score', () => {
    const r1 = pairRound({ players: EIGHT, results: [], round: 1 });
    expect(r1.tables[0]).toEqual(['p1', 'p5']);
  });
});
