import { describe, expect, it } from 'vitest';

import type { RoomView } from '../rooms/api.ts';
import { replacedGameRoute } from './matchFollow.ts';

const room = (table: { matchId: string | null; phase: string; games: string[] }): RoomView =>
  ({
    id: 'r-000000000001',
    tables: [{ id: 't-1', matchId: table.matchId, players: [], series: { length: 3, wins: [1, 0], games: table.games.map((matchId) => ({ matchId, winner: 0 })), phase: table.phase } }],
  }) as unknown as RoomView;

describe('replacedGameRoute', () => {
  it('stays while the table still holds this game', () => {
    expect(replacedGameRoute(room({ matchId: 'm-2', phase: 'playing', games: ['m-1'] }), 'm-2', 't-1')).toBeNull();
  });

  it('a game let go of with no result, the series still playing: to the table page, which starts it again', () => {
    expect(replacedGameRoute(room({ matchId: null, phase: 'playing', games: ['m-1'] }), 'm-2', 't-1')).toEqual({ kind: 'room', roomId: 'r-000000000001', tableId: 't-1' });
  });

  it('once its replacement has started: straight to it', () => {
    expect(replacedGameRoute(room({ matchId: 'm-3', phase: 'playing', games: ['m-1'] }), 'm-2', 't-1')).toEqual({ kind: 'match', matchId: 'm-3' });
  });

  it('a game that ended, or a series over or set aside, stays on its result', () => {
    expect(replacedGameRoute(room({ matchId: null, phase: 'sideboarding', games: ['m-1', 'm-2'] }), 'm-2', 't-1')).toBeNull();
    expect(replacedGameRoute(room({ matchId: 'm-3', phase: 'playing', games: ['m-1', 'm-2'] }), 'm-2', 't-1')).toBeNull();
    expect(replacedGameRoute(room({ matchId: null, phase: 'done', games: ['m-1'] }), 'm-2', 't-1')).toBeNull();
    expect(replacedGameRoute(room({ matchId: null, phase: 'seating', games: [] }), 'm-2', 't-1')).toBeNull();
  });
});
