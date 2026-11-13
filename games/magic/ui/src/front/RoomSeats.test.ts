// @vitest-environment jsdom
// A room's seats as the banner draws them: an open seat is a way in only while the room can take
// a player, and a pod's seats name who sits there.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PodView, RoomTable } from '@hadoku/shared';
import type { MagicRoomGame } from '@hadoku/shared';
import { OPEN_ROOM_LOCKS } from '@hadoku/shared';

import type { RoomView } from '../rooms/api.ts';
import { roomCardView } from './roomCard.ts';
import { RoomSeats } from './RoomSeats.tsx';

const table = (players: RoomTable['players'], phase: RoomTable['series']['phase'] = 'seating'): RoomTable => ({
  id: 't-1',
  players,
  matchId: null,
  series: { length: 1, wins: [0, 0], games: [], phase },
});

const room = ({ format = '2026-01-01', mode = 'classic', modeOptions = {}, clientMode = 'builtin', draftStartedAt = null, pod = null, ...over }: Partial<RoomView> & Partial<MagicRoomGame> = {}): RoomView => {
  const game = { format, mode, modeOptions, clientMode, draftStartedAt, pod };
  return {
    id: 'r-1',
    name: 'Table',
    creator: 'm1',
    leader: 'm1',
    gameType: 'constructed-1v1',
    settings: { handSmoothing: true, tournament: false, tournamentDecks: 'locked', clock: 'auto' as const, pickTimer: { on: false, speed: 1 }, draftBots: 'model' as const },
    locks: { ...OPEN_ROOM_LOCKS },
    locked: false,
    members: [{ id: 'm1', name: 'alice', joinedAt: '', ready: false }],
    seats: [],
    tables: [table([{ memberId: 'm1', name: 'alice' }])],
    matchId: null,
    createdAt: '',
    testing: false,
    scheduledFor: null,
    you: { id: 'viewer', leader: false, ready: false },
    game,
    ...over,
  };
};

const pod = (seats: PodView['seats']): PodView => ({
  phase: 'lobby',
  seats,
  round: 0,
  rounds: 0,
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
});

const draw = (r: RoomView) => {
  const onTake = vi.fn();
  render(createElement(RoomSeats, { room: r, view: roomCardView(r, false), onTake }));
  return onTake;
};

afterEach(cleanup);

describe('RoomSeats', () => {
  it('a 1v1 room with a seat open: the host vs "You?", and the "?" is the way in', () => {
    const onTake = draw(room());
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.getByText('You?')).toBeTruthy();
    fireEvent.click(screen.getByTestId('room-seat-open'));
    expect(onTake).toHaveBeenCalledOnce();
  });

  it('a room already playing draws its open seat, but offers no way in through it', () => {
    draw(room({ tables: [table([{ memberId: 'm1', name: 'alice' }], 'playing')] }));
    expect(screen.getByText('You?')).toBeTruthy();
    expect(screen.queryByTestId('room-seat-open')).toBeNull();
  });

  it('a pod draws all 8 of its seats, every open one a way in, and names who sits', () => {
    const seats = [{ memberId: 'm1', name: 'alice' }, null, { memberId: 'm2', name: 'bob' }, null, null, null, null, null];
    const r = room({ gameType: 'draft', members: [{ id: 'm1', name: 'alice', joinedAt: '', ready: false }, { id: 'm2', name: 'bob', joinedAt: '', ready: false }], pod: pod(seats) });
    draw(r);
    expect(screen.getAllByTestId('room-seat-taken')).toHaveLength(2);
    expect(screen.getAllByTestId('room-seat-open')).toHaveLength(6);
    expect(screen.getByText('bob')).toBeTruthy();
  });
});
