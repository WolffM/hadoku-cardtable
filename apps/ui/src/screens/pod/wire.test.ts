// @vitest-environment node
/*
 * `parsePodView`'s refusals and its one happy path, against fixtures in
 * `@hadoku/shared`'s real `PodView` shape (`wire.ts` re-exports it — see
 * that file's own header on the swap from this file's old hand-restated
 * mirror).
 */
import { describe, expect, it } from 'vitest';

import { parsePodView, POD_SEATS, type PodView } from './wire.ts';

const seats = (): PodView['seats'] => Array.from({ length: POD_SEATS }, () => null);

const fixture = (over: Partial<PodView> = {}): PodView => ({
  phase: 'lobby',
  seats: seats(),
  round: 0,
  rounds: 0,
  results: [],
  standings: [],
  pairings: [],
  bye: null,
  built: [],
  ...over,
});

describe('parsePodView', () => {
  it('parses a full lobby-phase pod', () => {
    const v = fixture({ seats: seats().map((_, i) => (i === 0 ? { memberId: 'u-alice', name: 'Alice' } : null)) });
    expect(parsePodView(v)).toEqual(v);
  });

  it('parses a rounds-phase pod with standings and a bye', () => {
    const v = fixture({
      phase: 'rounds',
      round: 2,
      rounds: 3,
      bye: 'u-carol',
      built: ['u-alice', 'u-bob', 'u-carol'],
      standings: [
        { id: 'u-alice', matchPoints: 3, opponentMatchWinPct: 0.5, gameWinPct: 1, opponentGameWinPct: 0.5, rank: 1 },
        { id: 'u-bob', matchPoints: 0, opponentMatchWinPct: 1, gameWinPct: 0, opponentGameWinPct: 1, rank: 2 },
      ],
    });
    expect(parsePodView(v)).toEqual(v);
  });

  it('refuses null, undefined and a non-object', () => {
    expect(parsePodView(null)).toBeNull();
    expect(parsePodView(undefined)).toBeNull();
    expect(parsePodView('draft')).toBeNull();
    expect(parsePodView(42)).toBeNull();
  });

  it('refuses an unrecognised phase', () => {
    expect(parsePodView(fixture({ phase: 'unknown-phase' as PodView['phase'] }))).toBeNull();
  });

  it('refuses seats of the wrong length — exactly 8 or nothing', () => {
    expect(parsePodView({ ...fixture(), seats: seats().slice(0, 7) })).toBeNull();
    expect(parsePodView({ ...fixture(), seats: [...seats(), null] })).toBeNull();
  });

  it('refuses a seat missing memberId or name', () => {
    const bad = seats();
    bad[0] = { memberId: 'u-alice' } as unknown as PodView['seats'][0];
    expect(parsePodView({ ...fixture(), seats: bad })).toBeNull();
  });

  it('refuses a standings row missing a field', () => {
    expect(
      parsePodView({
        ...fixture(),
        standings: [{ id: 'u-alice', matchPoints: 3, opponentMatchWinPct: 0.5, gameWinPct: 1 }],
      }),
    ).toBeNull();
  });

  it('refuses round/rounds that are not numbers', () => {
    expect(parsePodView({ ...fixture(), round: '1' })).toBeNull();
  });

  it('refuses a body this cannot validate rather than guessing — the manager’s fixture seam', () => {
    // Stands in for `pod.ts` still mid-flight on this branch, or an older
    // server that sends no pod at all: `RoomView.pod` is `unknown` either
    // way, and this always answers null rather than half-filling a shape.
    expect(parsePodView({})).toBeNull();
    expect(parsePodView({ phase: 'lobby' })).toBeNull();
  });
});
