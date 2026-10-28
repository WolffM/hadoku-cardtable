/*
 * The wildcard carousel's pure choices (`./wildcardItems.ts`).
 */
import { describe, expect, it } from 'vitest';
import type { CubeSummary, DraftCard, PodView, RoomTable } from '@hadoku/shared';

import type { RoomView } from '../rooms/api.ts';
import { mayRotate, openSeats, sampleArt, spotlightCube } from './wildcardItems.ts';

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
  you: { id: 'm1', leader: true, ready: false },
  ...over,
});

const notMine = (over: Partial<RoomView> = {}): RoomView =>
  room({ leader: 'm1', you: { id: 'viewer', leader: false, ready: false }, ...over });

describe('openSeats', () => {
  it('names the leader, the game type and how many seats are open', () => {
    expect(openSeats([notMine()])).toEqual({ roomId: 'r-1', title: "alice's Constructed needs 1", missing: 1 });
  });

  it('skips testing rooms, rooms the viewer is in, full rooms and rooms already playing', () => {
    const full = notMine({ id: 'r-2', members: [{ id: 'm1', name: 'alice', joinedAt: '', ready: false }, { id: 'm2', name: 'bob', joinedAt: '', ready: false }] });
    const playing = notMine({ id: 'r-3', tables: [table({ series: { length: 1, wins: [0, 0], games: [], phase: 'playing' } })] });
    expect(openSeats([notMine({ testing: true }), room(), full, playing])).toBeNull();
  });

  it('picks the room closest to starting', () => {
    const pod8 = notMine({ id: 'r-pod', gameType: 'draft', pod: pod({ phase: 'lobby' }) });
    const duel = notMine({ id: 'r-duel' });
    expect(openSeats([pod8, duel])?.roomId).toBe('r-duel');
    expect(openSeats([pod8])?.title).toBe("alice's Draft needs 7");
  });

  it('falls back to the room name when the leader has left', () => {
    expect(openSeats([notMine({ leader: 'gone' })])?.title).toBe("Table's Constructed needs 1");
  });
});

const cube = (over: Partial<CubeSummary>): CubeSummary => ({
  id: 'c', name: 'Cube', size: 360, origin: 'shortlist', cubeCobraId: null, importedBy: null, importedAt: null, refreshedAt: null, verdict: null, artId: null, ...over,
});

describe('spotlightCube', () => {
  it('never picks an empty cube or one Forge refused', () => {
    const refused = cube({ id: 'bad', verdict: { ok: false, unplayable: ['x'], missingText: [] } });
    const empty = cube({ id: 'empty', size: 0 });
    const good = cube({ id: 'good', verdict: { ok: true, cards: 360 } });
    expect(spotlightCube([refused, empty, good], () => 0.99)?.id).toBe('good');
    expect(spotlightCube([refused, empty])).toBeNull();
  });
});

describe('sampleArt', () => {
  const card = (id: string | undefined, n: number): DraftCard => ({ cardId: `k${String(n)}`, name: `Card ${String(n)}`, ...(id === undefined ? {} : { scryfallId: id }) }) as DraftCard;

  it('draws distinct art ids, skipping cards with none, never more than asked', () => {
    const cards = [card('a', 1), card('a', 2), card(undefined, 3), card('b', 4), card('c', 5), card('d', 6)];
    const drawn = sampleArt(cards, 3, () => 0);
    expect(drawn).toEqual(['a', 'b', 'c']);
    expect(sampleArt(cards.slice(0, 3), 3)).toEqual(['a']);
  });
});

describe('mayRotate', () => {
  const idle = { items: 3, hovered: false, focused: false, hidden: false };
  it('moves on only with several items and nobody hovering, focused or away', () => {
    expect(mayRotate(idle)).toBe(true);
    expect(mayRotate({ ...idle, items: 1 })).toBe(false);
    expect(mayRotate({ ...idle, hovered: true })).toBe(false);
    expect(mayRotate({ ...idle, focused: true })).toBe(false);
    expect(mayRotate({ ...idle, hidden: true })).toBe(false);
  });
});
