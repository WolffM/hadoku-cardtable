import { describe, expect, it } from 'vitest';

import { gameOutcome, winnerSeatFromLosers } from './match.ts';

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

describe('gameOutcome — the one classification of how a game ended', () => {
  const ended = { endedAt: 1, winner: null, winnerSeat: null, concededBy: null, spec: { seats: [{ name: 'Hadoku' }, { name: 'Forge AI' }] } };

  it('is null until Forge calls the game: a game the server ended has no outcome', () => {
    expect(gameOutcome({ ...ended, endedAt: null, winner: 'Hadoku' })).toBeNull();
  });

  it('reads a concede first, then the losers, then the winner’s name', () => {
    expect(gameOutcome({ ...ended, winnerSeat: 1, concededBy: 1 })).toEqual({ kind: 'won', winner: 0, conceded: true });
    expect(gameOutcome({ ...ended, winner: 'Hadoku', winnerSeat: 1 })).toEqual({ kind: 'won', winner: 1, conceded: false });
    expect(gameOutcome({ ...ended, winner: 'Hadoku' })).toEqual({ kind: 'won', winner: 0, conceded: false });
  });

  it('a concede Forge ends with no winner named is still the conceder’s loss', () => {
    expect(gameOutcome({ ...ended, concededBy: 0 })).toEqual({ kind: 'won', winner: 1, conceded: true });
  });

  it('no winner named and no concede is a draw; a winner no seat answers to cannot be placed', () => {
    expect(gameOutcome(ended)).toEqual({ kind: 'drawn' });
    expect(gameOutcome({ ...ended, winner: 'Knight' })).toEqual({ kind: 'unplaced' });
  });
});
