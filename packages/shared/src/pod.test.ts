/**
 * The wire shape of `RoomView.pod` (wave 72 §P), checked at the schema — the
 * one thing `apps/server/src/room/lobby.ts` and the pod screen both have to
 * agree on without `@hadoku/shared` importing `@hadoku/draft` (the
 * dependency only runs the other way).
 */

import { describe, expect, it } from 'vitest';
import {
  isPodAi,
  POD_PHASES,
  POD_MAX_SEATS,
  POD_SEATS,
  PodMatchResultSchema,
  PodMemberSchema,
  PodPairingSchema,
  PodPhaseSchema,
  PodSeatsSchema,
  PodStandingsRowSchema,
  PodViewSchema,
  RoomPodSchema,
  splitPods,
} from './pod.ts';

const MEMBER = { memberId: 'fk:alice', name: 'alice' } as const;
const EMPTY_SEATS = new Array(8).fill(null);
const RESULT = { round: 1, playerA: 'fk:alice', playerB: 'fk:bob', gamesA: 2, gamesB: 1 } as const;
const BYE_RESULT = { round: 1, playerA: 'fk:carol', playerB: null, gamesA: 0, gamesB: 0 } as const;
const STANDING = { id: 'fk:alice', matchPoints: 3, opponentMatchWinPct: 0.5, gameWinPct: 0.6, opponentGameWinPct: 0.5, rank: 1 } as const;
const PAIRING = { tableId: 't-aaaaaaaa', players: ['fk:alice', 'fk:bob'] } as const;

/** wave 73 §A: the room's pool choice, present in every phase (frozen once the draft starts). */
const PLAN = {
  rounds: [
    { kind: 'cube', cubeId: 'mtgo-vintage-cube-2025-12' },
    { kind: 'cube', cubeId: 'mtgo-vintage-cube-2025-12' },
    { kind: 'cube', cubeId: 'mtgo-vintage-cube-2025-12' },
  ],
} as const;
const VERDICT = { ok: true, cards: 540 } as const;

const LOBBY_VIEW = {
  phase: 'lobby',
  seats: [MEMBER, ...new Array(7).fill(null)],
  round: 0,
  rounds: 0,
  results: [],
  standings: [],
  pairings: [],
  bye: null,
  drafters: [],
  built: [],
  personas: {},
  plan: PLAN,
  roundNames: ['MTGO Vintage Cube 2025-12', 'MTGO Vintage Cube 2025-12', 'MTGO Vintage Cube 2025-12'],
  verdict: VERDICT,
} as const;

const ROUNDS_VIEW = {
  phase: 'rounds',
  seats: EMPTY_SEATS,
  round: 2,
  rounds: 3,
  results: [RESULT, BYE_RESULT],
  standings: [STANDING],
  pairings: [PAIRING],
  bye: 'fk:carol',
  drafters: ['fk:alice', 'fk:bob', 'fk:carol'],
  built: ['fk:alice', 'fk:bob', 'fk:carol'],
  personas: {},
  plan: PLAN,
  roundNames: ['MTGO Vintage Cube 2025-12', 'MTGO Vintage Cube 2025-12', 'MTGO Vintage Cube 2025-12'],
  verdict: VERDICT,
} as const;

describe('PodPhaseSchema', () => {
  it('is exactly the five phases, lobby to done', () => {
    expect(POD_PHASES).toEqual(['lobby', 'drafting', 'building', 'rounds', 'done']);
    for (const p of POD_PHASES) expect(PodPhaseSchema.safeParse(p).success).toBe(true);
    expect(PodPhaseSchema.safeParse('seating').success).toBe(false);
  });
});

describe('PodMemberSchema', () => {
  it('accepts a seated member and refuses an unknown field', () => {
    expect(PodMemberSchema.safeParse(MEMBER).success).toBe(true);
    expect(PodMemberSchema.safeParse({ ...MEMBER, extra: 1 }).success).toBe(false);
  });
});

describe('PodSeatsSchema', () => {
  it('is exactly 8 seats, each a member or null', () => {
    expect(POD_SEATS).toBe(8);
    expect(PodSeatsSchema.safeParse(EMPTY_SEATS).success).toBe(true);
    expect(PodSeatsSchema.safeParse([MEMBER, ...new Array(7).fill(null)]).success).toBe(true);
    expect(PodSeatsSchema.safeParse(new Array(7).fill(null)).success).toBe(false);
    expect(PodSeatsSchema.safeParse(new Array(9).fill(null)).success).toBe(false);
  });
});

describe('PodMatchResultSchema', () => {
  it('accepts a decided match and a bye, refusing a negative game count', () => {
    expect(PodMatchResultSchema.safeParse(RESULT).success).toBe(true);
    expect(PodMatchResultSchema.safeParse(BYE_RESULT).success).toBe(true);
    expect(PodMatchResultSchema.safeParse({ ...RESULT, gamesA: -1 }).success).toBe(false);
  });
});

describe('PodStandingsRowSchema', () => {
  it('accepts a ranked row and refuses a percentage outside 0..1', () => {
    expect(PodStandingsRowSchema.safeParse(STANDING).success).toBe(true);
    expect(PodStandingsRowSchema.safeParse({ ...STANDING, gameWinPct: 1.5 }).success).toBe(false);
    expect(PodStandingsRowSchema.safeParse({ ...STANDING, rank: 0 }).success).toBe(false);
  });
});

describe('PodPairingSchema', () => {
  it('is exactly two players, and refuses a third', () => {
    expect(PodPairingSchema.safeParse(PAIRING).success).toBe(true);
    expect(PodPairingSchema.safeParse({ ...PAIRING, players: ['a', 'b', 'c'] }).success).toBe(false);
  });
});

describe('PodViewSchema', () => {
  it('accepts a lobby-phase pod, seats and all, nothing decided yet', () => {
    expect(PodViewSchema.safeParse(LOBBY_VIEW).success).toBe(true);
  });

  it('accepts a rounds-phase pod with results, standings, pairings and a bye', () => {
    const parsed = PodViewSchema.safeParse(ROUNDS_VIEW);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.pairings[0]?.players).toEqual(['fk:alice', 'fk:bob']);
  });

  it('refuses an unknown field and a phase outside the five', () => {
    expect(PodViewSchema.safeParse({ ...LOBBY_VIEW, extra: 1 }).success).toBe(false);
    expect(PodViewSchema.safeParse({ ...LOBBY_VIEW, phase: 'playing' }).success).toBe(false);
  });

  it('wave 73 §A: verdict is null while a check is running or before the first ever ran', () => {
    expect(PodViewSchema.safeParse({ ...LOBBY_VIEW, verdict: null }).success).toBe(true);
  });

  it('refuses a plan with fewer or more than 3 rounds, and a verdict shaped wrong', () => {
    expect(PodViewSchema.safeParse({ ...LOBBY_VIEW, plan: { rounds: PLAN.rounds.slice(0, 2) } }).success).toBe(false);
    expect(PodViewSchema.safeParse({ ...LOBBY_VIEW, plan: { rounds: [...PLAN.rounds, PLAN.rounds[0]] } }).success).toBe(false);
    expect(PodViewSchema.safeParse({ ...LOBBY_VIEW, verdict: { ok: false, unplayable: ['X'] } }).success).toBe(false);
  });
});

describe('RoomPodSchema', () => {
  it('accepts null for a constructed room, and a PodView for a draft room', () => {
    expect(RoomPodSchema.safeParse(null).success).toBe(true);
    expect(RoomPodSchema.safeParse(LOBBY_VIEW).success).toBe(true);
    expect(RoomPodSchema.safeParse(undefined).success).toBe(false);
  });
});

describe('isPodAi — one predicate for both AI sentinels', () => {
  it('matches a draft pod’s single shared bot (`ai`) and a tournament pod’s own per-seat entrant (`ai:<seat>`)', () => {
    expect(isPodAi('ai')).toBe(true);
    expect(isPodAi('ai:0')).toBe(true);
    expect(isPodAi('ai:7')).toBe(true);
  });

  it('refuses a member id, including one that merely starts with "ai"', () => {
    expect(isPodAi('fk:alice')).toBe(false);
    expect(isPodAi('aidan')).toBe(false);
    expect(isPodAi('ai:')).toBe(false);
    expect(isPodAi('ai:x')).toBe(false);
    expect(isPodAi('')).toBe(false);
  });
});

describe('splitPods — pods of at most 8, as even as possible, never two odd pods while even ones would do', () => {
  it.each([
    [0, []],
    [1, [1]],
    [8, [8]],
    [9, [5, 4]],
    [10, [6, 4]],
    [13, [7, 6]],
    [14, [8, 6]],
    [16, [8, 8]],
    [21, [8, 7, 6]],
    [22, [8, 8, 6]],
    [40, [8, 8, 8, 8, 8]],
    [64, [8, 8, 8, 8, 8, 8, 8, 8]],
  ])('%i entrants → %j', (n, sizes) => {
    expect(splitPods(n)).toEqual(sizes);
  });

  it('covers every count up to the room cap with pods of at most 8, at most one odd, summing to the field', () => {
    for (let n = 1; n <= POD_MAX_SEATS; n++) {
      const sizes = splitPods(n);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(n);
      expect(sizes).toHaveLength(Math.ceil(n / POD_SEATS));
      expect(sizes.every((s) => s >= 1 && s <= POD_SEATS)).toBe(true);
      expect(sizes.filter((s) => s % 2 === 1).length).toBe(n % 2);
    }
  });
});

describe('a room seats several pods', () => {
  it('accepts seats in whole pods of 8, up to the room cap', () => {
    for (const length of [8, 16, 24, POD_MAX_SEATS]) expect(PodSeatsSchema.safeParse(new Array(length).fill(null)).success).toBe(true);
    for (const length of [0, 7, 9, 15, POD_MAX_SEATS + 8]) expect(PodSeatsSchema.safeParse(new Array(length).fill(null)).success).toBe(false);
  });
});
