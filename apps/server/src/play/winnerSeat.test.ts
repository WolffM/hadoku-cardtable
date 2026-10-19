import { describe, expect, it } from 'vitest';

import { winnerSeatOf } from '../http/routes.ts';
import { winnerSeatFromLosers } from './match.ts';

const human = (seat: number, playerId: number | null) => ({ seat, playerId });

describe("a game's winning seat, from Forge's own losers", () => {
  it('two people: the seat whose player lost is not the winner', () => {
    expect(winnerSeatFromLosers([human(0, 7), human(1, 3)], [3])).toBe(0);
    expect(winnerSeatFromLosers([human(0, 7), human(1, 3)], [7])).toBe(1);
  });

  // r-25e36308b621 (2026-10-19 06:14Z): the AI beat the operator and the game
  // was recorded with no winner — the series stayed 0-0 and no standing moved.
  it('against the AI: the person lost, so the AI seat won', () => {
    expect(winnerSeatFromLosers([human(0, 1), human(1, null)], [1])).toBe(1);
  });

  it('against the AI: somebody lost and it was not the person, so the person won', () => {
    expect(winnerSeatFromLosers([human(0, 1), human(1, null)], [2])).toBe(0);
  });

  it('cannot be told: no losers, both lost, or no seat known', () => {
    expect(winnerSeatFromLosers([human(0, 7), human(1, 3)], undefined)).toBeNull();
    expect(winnerSeatFromLosers([human(0, 7), human(1, 3)], [])).toBeNull();
    expect(winnerSeatFromLosers([human(0, 7), human(1, 3)], [7, 3])).toBeNull();
    expect(winnerSeatFromLosers([human(0, null), human(1, null)], [1])).toBeNull();
  });
});

describe('winnerSeatOf', () => {
  const seats = [{ displayName: 'Hadoku' }, {}];

  it('reads a concede first, then the losers, then the winner’s name', () => {
    expect(winnerSeatOf({ winner: null, winnerSeat: 1, concededBy: 1, seats })).toBe(0);
    expect(winnerSeatOf({ winner: 'Forge AI', winnerSeat: 1, concededBy: null, seats })).toBe(1);
    expect(winnerSeatOf({ winner: 'Hadoku', winnerSeat: null, concededBy: null, seats })).toBe(0);
  });

  it('is null for an AI win with no losers to go on — the gap the losers close', () => {
    expect(winnerSeatOf({ winner: 'Forge AI', winnerSeat: null, concededBy: null, seats })).toBeNull();
  });
});
