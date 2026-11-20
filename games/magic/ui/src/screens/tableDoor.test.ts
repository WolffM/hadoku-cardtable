import { describe, expect, it } from 'vitest';
import type { RoomTable, TableGame } from '@hadoku/shared';

import { doorGo, seatAt, tableDoor } from './tableDoor.ts';

const series = (phase: RoomTable['series']['phase'], played = 0): RoomTable['series'] => ({
  length: 3,
  wins: [played, 0],
  games: Array.from({ length: played }, (_, i) => ({ matchId: `m-old-${i}`, winner: 0 as const })),
  phase,
});
const game = (entered: [boolean, boolean]): TableGame => ({ decks: [null, null], live: null, entered });

describe('a table’s one way in', () => {
  it('is Enter game for a player who has not been at the game that is up, and Return to game once they have', () => {
    const table = { matchId: 'm-2', series: series('playing', 1) };
    expect(tableDoor(table, game([true, false]), 1)).toEqual({ kind: 'enter', matchId: 'm-2' });
    expect(tableDoor(table, game([true, false]), 0)).toEqual({ kind: 'return', matchId: 'm-2' });
    // A game the room has no summary of yet has not been entered.
    expect(tableDoor(table, undefined, 0)).toEqual({ kind: 'enter', matchId: 'm-2' });
  });

  it('is the sideboard between two games, and nothing before the first or after the last', () => {
    expect(tableDoor({ matchId: null, series: series('sideboarding', 1) }, game([true, true]), 0)).toEqual({ kind: 'sideboard' });
    expect(tableDoor({ matchId: null, series: series('seating') }, undefined, 0)).toBeNull();
    expect(tableDoor({ matchId: null, series: series('done', 2) }, game([true, true]), 0)).toBeNull();
  });

  it('is Watch for anyone else while a game is up, whatever the players have done', () => {
    expect(tableDoor({ matchId: 'm-2', series: series('playing') }, game([false, false]), null)).toEqual({ kind: 'watch', matchId: 'm-2' });
    expect(tableDoor({ matchId: null, series: series('sideboarding', 1) }, undefined, null)).toBeNull();
  });

  it('counts my seat by who sits at the table, in seat order: the seat its game and its series count by', () => {
    const players = [{ memberId: 'u-alice', name: 'Alice' }, { memberId: 'u-bob', name: 'Bob' }];
    expect(seatAt({ players }, 'u-alice')).toBe(0);
    expect(seatAt({ players }, 'u-bob')).toBe(1);
    expect(seatAt({ players }, 'u-carol'), 'anyone else').toBeNull();
    expect(seatAt({ players }, null), 'nobody').toBeNull();
    // A table against an AI seats its one person at 0, whichever side its pairing names them.
    expect(seatAt({ players: [{ memberId: 'u-bob', name: 'Bob' }] }, 'u-bob')).toBe(0);
  });

  it('draws as one action: the sideboard’s own screen, or the game', () => {
    expect(doorGo({ kind: 'sideboard' }, 'r-1', 't-1', 'go')).toEqual({ label: 'Sideboard', href: '#/room/r-1/table/t-1/sideboard', testId: 'go', door: 'sideboard' });
    expect(doorGo({ kind: 'return', matchId: 'm-2' }, 'r-1', 't-1', 'go')).toEqual({ label: 'Return to game', href: '#/match/m-2', testId: 'go', door: 'return' });
    expect(doorGo({ kind: 'watch', matchId: 'm-2' }, 'r-1', 't-1', 'go')).toMatchObject({ label: 'Watch', href: '#/match/m-2' });
    const enter = doorGo({ kind: 'enter', matchId: 'm-2' }, 'r-1', 't-1', 'go')!;
    expect(enter).toMatchObject({ label: 'Enter game', href: '#/match/m-2', door: 'enter' });
    expect(enter.onPress, 'a first entry opens the game the way every new game opens').toBeTypeOf('function');
    expect(doorGo(null, 'r-1', 't-1', 'go')).toBeNull();
  });
});
