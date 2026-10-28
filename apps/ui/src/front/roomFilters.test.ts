// @vitest-environment jsdom
// jsdom, for `localStorage` alone — `loadRoomFilters`/`saveRoomFilters` round-trip through it, and the
// default `node` environment (`vitest.config.ts`) has none.
import { beforeEach, describe, expect, it } from 'vitest';
import type { PodView, RoomTable } from '@hadoku/shared';

import type { RoomView } from '../rooms/api.ts';
import { roomCardView } from './roomCard.ts';
import {
  DEFAULT_ROOM_FILTERS,
  hasActiveFilter,
  loadRoomFilters,
  matchesRoomFilters,
  orderByMatch,
  saveRoomFilters,
  type RoomFilters,
} from './roomFilters.ts';

const table = (over: Partial<RoomTable> = {}): RoomTable => ({
  id: 't-1',
  players: [],
  matchId: null,
  series: { length: 1, wins: [0, 0], games: [], phase: 'seating' },
  ...over,
});

const pod = (over: Partial<PodView> & { phase: PodView['phase'] }): PodView => ({
  seats: new Array(8).fill(null) as PodView['seats'],
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
  ...over,
});

const room = (over: Partial<RoomView> = {}): RoomView => ({
  id: 'r-1',
  name: 'Table',
  creator: '',
  leader: '',
  gameType: 'constructed-1v1',
  format: '2026-01-01',
  settings: { handSmoothing: true, tournament: false, tournamentDecks: 'locked' },
  mode: 'classic',
  modeOptions: {},
  clientMode: 'builtin',
  locked: false,
  members: [{ id: 'm1', name: 'alice', joinedAt: '', ready: false }],
  tables: [table()],
  matchId: null,
  draftStartedAt: null,
  pod: null,
  createdAt: '',
  testing: false,
  scheduledFor: null,
  you: { id: 'm1', leader: true, ready: false },
  ...over,
});

describe('matchesRoomFilters', () => {
  it('an unset filter never excludes a room', () => {
    expect(matchesRoomFilters(room(), roomCardView(room(), false), DEFAULT_ROOM_FILTERS)).toBe(true);
  });

  it('the type pair: draft matches only drafts, constructed only non-drafts', () => {
    const draft = room({ gameType: 'draft', pod: pod({ phase: 'lobby' }) });
    const constructed = room();
    const draftFilter: RoomFilters = { ...DEFAULT_ROOM_FILTERS, type: 'draft' };
    const constructedFilter: RoomFilters = { ...DEFAULT_ROOM_FILTERS, type: 'constructed' };
    expect(matchesRoomFilters(draft, roomCardView(draft, false), draftFilter)).toBe(true);
    expect(matchesRoomFilters(constructed, roomCardView(constructed, false), draftFilter)).toBe(false);
    expect(matchesRoomFilters(constructed, roomCardView(constructed, false), constructedFilter)).toBe(true);
    expect(matchesRoomFilters(draft, roomCardView(draft, false), constructedFilter)).toBe(false);
  });

  it('Not full excludes a room whose seats are filled to capacity', () => {
    const full = room({ members: [{ id: 'm1', name: 'a', joinedAt: '', ready: false }, { id: 'm2', name: 'b', joinedAt: '', ready: false }] });
    const open = room();
    const filters: RoomFilters = { ...DEFAULT_ROOM_FILTERS, notFull: true };
    expect(matchesRoomFilters(full, roomCardView(full, false), filters)).toBe(false);
    expect(matchesRoomFilters(open, roomCardView(open, false), filters)).toBe(true);
  });

  it('the kind pair: tournament matches only tournaments, duel only non-tournaments', () => {
    const tourney = room({ settings: { handSmoothing: true, tournament: true, tournamentDecks: 'locked' } });
    const duel = room();
    const tourneyFilter: RoomFilters = { ...DEFAULT_ROOM_FILTERS, kind: 'tournament' };
    const duelFilter: RoomFilters = { ...DEFAULT_ROOM_FILTERS, kind: 'duel' };
    expect(matchesRoomFilters(tourney, roomCardView(tourney, false), tourneyFilter)).toBe(true);
    expect(matchesRoomFilters(duel, roomCardView(duel, false), tourneyFilter)).toBe(false);
    expect(matchesRoomFilters(duel, roomCardView(duel, false), duelFilter)).toBe(true);
    expect(matchesRoomFilters(tourney, roomCardView(tourney, false), duelFilter)).toBe(false);
  });

  it('several filters on at once: a room must match every one of them', () => {
    const tourneyDraft = room({ gameType: 'draft', pod: pod({ phase: 'lobby' }) }); // every draft is a tournament
    const filters: RoomFilters = { type: 'draft', notFull: false, kind: 'tournament' };
    expect(matchesRoomFilters(tourneyDraft, roomCardView(tourneyDraft, false), filters)).toBe(true);
    const plainDraft = room({ gameType: 'draft', pod: pod({ phase: 'lobby' }) });
    expect(matchesRoomFilters(plainDraft, roomCardView(plainDraft, false), { ...filters, kind: 'duel' })).toBe(false);
  });
});

describe('hasActiveFilter', () => {
  it('is false for the defaults and true the moment anything is on', () => {
    expect(hasActiveFilter(DEFAULT_ROOM_FILTERS)).toBe(false);
    expect(hasActiveFilter({ ...DEFAULT_ROOM_FILTERS, type: 'draft' })).toBe(true);
    expect(hasActiveFilter({ ...DEFAULT_ROOM_FILTERS, notFull: true })).toBe(true);
    expect(hasActiveFilter({ ...DEFAULT_ROOM_FILTERS, kind: 'duel' })).toBe(true);
  });
});

describe('orderByMatch', () => {
  it('moves every match ahead of every non-match, keeping each side’s own order', () => {
    const rooms = [1, 2, 3, 4, 5];
    expect(orderByMatch(rooms, (n) => n % 2 === 0)).toEqual([2, 4, 1, 3, 5]);
  });

  it('is the identity when everything matches, or nothing does', () => {
    const rooms = [1, 2, 3];
    expect(orderByMatch(rooms, () => true)).toEqual([1, 2, 3]);
    expect(orderByMatch(rooms, () => false)).toEqual([1, 2, 3]);
  });
});

describe('loadRoomFilters / saveRoomFilters', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

  it('round-trips through localStorage', () => {
    expect(loadRoomFilters()).toEqual(DEFAULT_ROOM_FILTERS);
    const filters: RoomFilters = { type: 'draft', notFull: true, kind: 'tournament' };
    saveRoomFilters(filters);
    expect(loadRoomFilters()).toEqual(filters);
  });

  it('falls back to the defaults when storage holds garbage, and never throws', () => {
    globalThis.localStorage?.setItem('cardtable.rooms.filters', '{not json');
    expect(loadRoomFilters()).toEqual(DEFAULT_ROOM_FILTERS);
    globalThis.localStorage?.setItem('cardtable.rooms.filters', JSON.stringify({ type: 'nonsense' }));
    expect(loadRoomFilters()).toEqual(DEFAULT_ROOM_FILTERS);
  });

  it('never throws when storage is unavailable', () => {
    const real = globalThis.localStorage;
    try {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
          throw new Error('blocked');
        },
      });
      expect(() => saveRoomFilters(DEFAULT_ROOM_FILTERS)).not.toThrow();
      expect(loadRoomFilters()).toEqual(DEFAULT_ROOM_FILTERS);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: real });
    }
  });
});
