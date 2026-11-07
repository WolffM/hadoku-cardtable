import { describe, expect, it } from 'vitest';
import type { PodMatchResult, RoomTable } from '@hadoku/shared';

import { onPath, records, recordText, SWISS, swissLayout, type SwissCard } from './swiss.ts';
import { POD_SEATS, type PodView } from './wire.ts';

const player = (memberId: string) => ({ memberId, name: memberId });
const table = (id: string, ids: string[], over: Partial<RoomTable> = {}): RoomTable => ({
  id,
  players: ids.map(player),
  matchId: null,
  series: { length: 3, wins: [0, 0], games: [], phase: 'seating' },
  ...over,
});
const standing = (id: string, rank: number) => ({ id, matchPoints: 0, opponentMatchWinPct: 0, gameWinPct: 0, opponentGameWinPct: 0, medianGameMs: null, rank, decidedBy: null });

function pod(over: Partial<PodView>): PodView {
  return {
    phase: 'rounds',
    seats: Array.from({ length: POD_SEATS }, () => null),
    round: 1,
    rounds: 3,
    results: [],
    standings: [],
    pairings: [],
    bye: null,
    drafters: [],
    built: [],
    personas: {},
    plan: null,
    roundNames: null,
    verdict: null,
    ...over,
  };
}

const r = (round: number, playerA: string, playerB: string | null, gamesA = 2, gamesB = 0): PodMatchResult => ({ round, playerA, playerB, gamesA, gamesB });

/** Eight players, three rounds played: a, b, c, d win round 1; a and c round 2; a round 3. */
const EIGHT: PodMatchResult[] = [
  r(1, 'a', 'e'), r(1, 'b', 'f'), r(1, 'c', 'g'), r(1, 'd', 'h', 2, 1),
  r(2, 'a', 'b'), r(2, 'c', 'd'), r(2, 'e', 'f'), r(2, 'g', 'h'),
  r(3, 'a', 'c'), r(3, 'b', 'd'), r(3, 'e', 'g'), r(3, 'f', 'h'),
];
const done = pod({ phase: 'done', round: 4, results: EIGHT, standings: ['a', 'c', 'b', 'e', 'd', 'g', 'f', 'h'].map((id, i) => standing(id, i + 1)) });
const matches = (cards: ReturnType<typeof swissLayout>['cards'], col: number) => cards.filter((c): c is SwissCard => c.kind === 'match' && c.x === col * (SWISS.cardW + SWISS.gutter));

describe('swissLayout', () => {
  it('a column per round and a FINAL once done; each match on the row of its record going in', () => {
    const l = swissLayout(done, []);
    expect(l.columns.map((c) => [c.round, c.state])).toEqual([[1, 'past'], [2, 'past'], [3, 'past'], ['final', 'final']]);
    expect(l.groups.filter((g) => g.column === 0).map((g) => recordText(g.record))).toEqual(['0–0']);
    expect(l.groups.filter((g) => g.column === 1).map((g) => recordText(g.record)).sort()).toEqual(['0–1', '1–0']);
    expect(l.groups.filter((g) => g.column === 2).map((g) => recordText(g.record)).sort()).toEqual(['0–2', '1–1', '2–0']);
    // Higher records higher up: 2–0 over 1–1 over 0–2.
    const y = (rec: string) => l.groups.find((g) => g.column === 2 && recordText(g.record) === rec)!.cy;
    expect(y('2–0')).toBeLessThan(y('1–1'));
    expect(y('1–1')).toBeLessThan(y('0–2'));
    expect(matches(l.cards, 0)).toHaveLength(4);
  });

  it('the final column has everyone by place, on the row of the record they finished with', () => {
    const l = swissLayout(done, []);
    expect(l.finals.map((f) => [f.player, f.place, recordText(f.record)])).toEqual(
      expect.arrayContaining([['a', 1, '3–0'], ['c', 2, '2–1'], ['h', 8, '0–3']]),
    );
    expect(l.finals).toHaveLength(8);
  });

  it('never lets two groups of a column overlap, nor a card squeeze below its width', () => {
    const l = swissLayout(done, []);
    for (const col of [0, 1, 2, 3]) {
      const gs = l.groups.filter((g) => g.column === col).sort((a, b) => a.top - b.top);
      for (let i = 1; i < gs.length; i++) expect(gs[i]!.top - SWISS.chipH, `column ${col}`).toBeGreaterThanOrEqual(gs[i - 1]!.top + gs[i - 1]!.h);
    }
    expect(Math.min(...l.groups.map((g) => g.top - SWISS.chipH))).toBeGreaterThanOrEqual(SWISS.headH);
  });

  it('steps each group’s winners up a row and its losers down one, and a player’s path follows their own steps', () => {
    const l = swissLayout(done, []);
    const from00 = l.edges.filter((e) => e.from.column === 0);
    expect(from00.map((e) => e.step).sort()).toEqual(['loss', 'win']);
    // a: won rounds 1, 2 and 3 — every one of its edges is a win step.
    expect(l.edges.filter((e) => onPath(l, e, 'a')).map((e) => [e.from.column, e.step])).toEqual([[0, 'win'], [1, 'win'], [2, 'win']]);
    // d: won round 1, lost rounds 2 and 3.
    expect(l.edges.filter((e) => onPath(l, e, 'd')).map((e) => [e.from.column, e.step])).toEqual([[0, 'win'], [1, 'loss'], [2, 'loss']]);
  });

  it('mid-rounds: the round in play from its pairings, as its tables stand; an AI-vs-AI pairing settled at once beside it; rounds not paired yet empty', () => {
    const mid = pod({
      round: 2,
      results: [...EIGHT.filter((x) => x.round === 1), r(2, 'ai:5', 'ai:6')],
      pairings: [{ tableId: 't-9', players: ['a', 'b'] }],
    });
    const l = swissLayout(mid, [table('t-9', ['a', 'b'], { matchId: 'm-1', series: { length: 3, wins: [1, 0], games: [], phase: 'playing' } })]);
    expect(l.columns.map((c) => c.state)).toEqual(['past', 'now', 'next']);
    const live = matches(l.cards, 1);
    expect(live.map((c) => [c.match.players, c.match.wins, c.match.live])).toEqual([[['a', 'b'], [1, 0], true], [['ai:5', 'ai:6'], [2, 0], false]]);
    expect(live[0]!.h).toBeGreaterThan(live[1]!.h);
    expect(l.finals).toEqual([]);
  });

  it('mid-rounds: a bot game still being played is in its round as a match under way, with no table, and never takes a table', () => {
    const mid = pod({
      round: 2,
      results: EIGHT.filter((x) => x.round === 1),
      pairings: [{ tableId: 't-9', players: ['a', 'b'] }],
      botGames: [{ players: ['ai:5', 'ai:6'] }],
    });
    // An empty table (its players left) is never a bot game's.
    const l = swissLayout(mid, [table('t-9', ['a', 'b'], { matchId: 'm-1', series: { length: 3, wins: [1, 0], games: [], phase: 'playing' } }), table('t-0', [])]);
    const live = matches(l.cards, 1);
    expect(live.map((c) => [c.match.players, c.match.wins, c.match.phase, c.match.table?.id ?? null])).toEqual([
      [['a', 'b'], [1, 0], 'playing', 't-9'],
      [['ai:5', 'ai:6'], [0, 0], 'playing', null],
    ]);
  });

  it('a finished bot game never claims a table: no seat at any is an AI’s', () => {
    const over = pod({ phase: 'done', round: 2, rounds: 1, results: [r(1, 'ai:1', 'ai:2', 2, 1)], standings: [standing('ai:1', 1), standing('ai:2', 2)] });
    const l = swissLayout(over, [table('t-0', [])]);
    expect(matches(l.cards, 0).map((c) => [c.match.players, c.match.wins, c.match.table])).toEqual([[['ai:1', 'ai:2'], [2, 1], null]]);
  });

  it('a bye sits on its player’s row and counts as a win', () => {
    const odd = pod({ phase: 'done', round: 3, rounds: 2, results: [r(1, 'a', 'b'), r(1, 'c', null), r(2, 'c', 'a'), r(2, 'b', null)], standings: ['c', 'a', 'b'].map((id, i) => standing(id, i + 1)) });
    const l = swissLayout(odd, []);
    expect(l.cards.filter((c) => c.kind === 'bye').map((c) => (c.kind === 'bye' ? c.player : ''))).toEqual(['c', 'b']);
    expect(recordText(records(odd).get('c')!)).toBe('2–0');
  });

  it('finds a finished match’s table by its seats, an AI holding none', () => {
    const solo = pod({ phase: 'done', round: 2, rounds: 1, results: [r(1, 'u-alice', 'ai:3')], standings: [standing('u-alice', 1), standing('ai:3', 2)] });
    const l = swissLayout(solo, [table('t-1', ['u-alice'], { series: { length: 3, wins: [2, 0], games: [], phase: 'done' } })]);
    expect(matches(l.cards, 0)[0]!.match.table?.id).toBe('t-1');
  });
});
