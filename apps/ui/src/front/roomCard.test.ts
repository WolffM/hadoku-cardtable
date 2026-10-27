/*
 * The room card's derived symbols and state — every `gameType`, Constructed mode and phase the
 * brief lists (`docs/planning/wave77-2026-10-27.md` §A's "Done when": covered here without mounting
 * a component, since the derivation is pure (`./roomCard.ts`)).
 */
import { describe, expect, it } from 'vitest';
import type { PodView, RoomTable } from '@hadoku/shared';

import type { RoomView } from '../rooms/api.ts';
import { roomCardView, roomFamily } from './roomCard.ts';

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

describe('roomCardView — Constructed modes', () => {
  it('reads Classic as a chip with the room’s own era label, or Free pick for the free-pick format (ruling 5)', () => {
    expect(roomCardView(room({ mode: 'classic', modeOptions: {}, format: '2018-07-13' }), false).mode).toMatchObject({ icon: 'classic', text: 'Standard 2018' });
    expect(roomCardView(room({ mode: 'classic', modeOptions: {}, format: 'modern-2011-07-15' }), false).mode).toMatchObject({ icon: 'classic', text: 'Modern 2011' });
    expect(roomCardView(room({ mode: 'classic', modeOptions: {}, format: 'legacy-2011-07-15' }), false).mode).toMatchObject({ icon: 'classic', text: 'Legacy 2011' });
    expect(roomCardView(room({ mode: 'classic', modeOptions: {}, format: 'free' }), false).mode).toMatchObject({ icon: 'classic', text: 'Free pick' });
  });

  it('reads Gauntlet as its family, its era label, or Any era when neither is chosen', () => {
    expect(roomCardView(room({ mode: 'gauntlet', modeOptions: { family: 'modern' } }), false).mode).toMatchObject({ icon: 'gauntlet', text: 'Modern' });
    expect(roomCardView(room({ mode: 'gauntlet', modeOptions: { era: 'legacy-2020-01-01' } }), false).mode).toMatchObject({ icon: 'gauntlet', text: 'Legacy 2020' });
    expect(roomCardView(room({ mode: 'gauntlet', modeOptions: {} }), false).mode).toMatchObject({ icon: 'gauntlet', text: 'Any era' });
  });

  it('reads All Random as its pool, Full for the whole library', () => {
    expect(roomCardView(room({ mode: 'random', modeOptions: { pool: 'full' } }), false).mode).toMatchObject({ icon: 'random', text: 'Full' });
    expect(roomCardView(room({ mode: 'random', modeOptions: { pool: 'legacy' } }), false).mode).toMatchObject({ icon: 'random', text: 'Legacy' });
  });

  it('draws no mode icon for a draft, and its cube or plan name instead', () => {
    const drafted = room({ gameType: 'draft', mode: null, modeOptions: null, pod: pod({ phase: 'lobby', plan: { rounds: [{ kind: 'cube', cubeId: 'c1' }, { kind: 'cube', cubeId: 'c1' }, { kind: 'cube', cubeId: 'c1' }] }, roundNames: ['Vintage Cube', 'Vintage Cube', 'Vintage Cube'] }) });
    expect(roomCardView(drafted, false).mode).toMatchObject({ icon: null, text: 'Vintage Cube' });
    const noPlan = room({ gameType: 'draft', mode: null, modeOptions: null, pod: pod({ phase: 'lobby' }) });
    expect(roomCardView(noPlan, false).mode.icon).toBeNull();
  });
});

describe('roomCardView — tournament and seats', () => {
  it('is a tournament for every draft, and for a constructed room with settings.tournament on', () => {
    expect(roomCardView(room({ gameType: 'draft', pod: pod({ phase: 'lobby' }) }), false).tournament).toBe(true);
    expect(roomCardView(room({ settings: { handSmoothing: true, tournament: true, tournamentDecks: 'locked' }, pod: pod({ phase: 'lobby' }) }), false).tournament).toBe(true);
    expect(roomCardView(room(), false).tournament).toBe(false);
  });

  it('counts seats out of 8 for any pod, and out of 2 for a plain constructed room', () => {
    expect(roomCardView(room({ gameType: 'draft', pod: pod({ phase: 'lobby' }), members: [{ id: 'm1', name: 'a', joinedAt: '', ready: false }] }), false).seatsCapacity).toBe(8);
    expect(roomCardView(room(), false)).toMatchObject({ seatsCapacity: 2, seatsFilled: 1 });
  });
});

describe('roomCardView — state, every phase', () => {
  it('a plain constructed room: lobby, playing, sideboarding/between, done', () => {
    // Ruling 9 (2026-10-27): "Waiting for players", not "Waiting for a player".
    expect(roomCardView(room({ tables: [table({ series: { length: 1, wins: [0, 0], games: [], phase: 'seating' } })] }), false).state).toMatchObject({ key: 'lobby', label: 'Lobby', detail: 'Waiting for players' });

    const playing = room({
      tables: [table({ id: 't-1', series: { length: 3, wins: [1, 0], games: [{ matchId: 'm-1', winner: 0 }], phase: 'playing' } })],
      matchId: 'm-2',
      tableGames: { 't-1': { decks: [null, null], live: { turn: 7, active: 0, life: [18, 20], hand: [3, 4] } } },
      members: [{ id: 'm1', name: 'a', joinedAt: '', ready: false }, { id: 'm2', name: 'b', joinedAt: '', ready: false }],
    });
    expect(roomCardView(playing, false).state).toMatchObject({ key: 'playing', label: 'Playing', detail: 'Game 2 · turn 7' });

    const sideboarding = room({ tables: [table({ series: { length: 3, wins: [1, 0], games: [{ matchId: 'm-1', winner: 0 }], phase: 'sideboarding' } })] });
    expect(roomCardView(sideboarding, false).state).toMatchObject({ key: 'sideboarding', label: 'Sideboarding', detail: 'Game 2 next' });

    const done = room({ tables: [table({ series: { length: 1, wins: [1, 0], games: [{ matchId: 'm-1', winner: 0 }], phase: 'done' } })] });
    expect(roomCardView(done, false).state).toMatchObject({ key: 'done', label: 'Done', detail: null });
  });

  it('a pod: lobby, drafting, building, rounds (with its round detail), done', () => {
    expect(roomCardView(room({ gameType: 'draft', members: [{ id: 'm1', name: 'a', joinedAt: '', ready: false }, { id: 'm2', name: 'b', joinedAt: '', ready: false }], pod: pod({ phase: 'lobby' }) }), false).state).toMatchObject({ key: 'lobby', label: 'Lobby', detail: null });
    expect(roomCardView(room({ gameType: 'draft', pod: pod({ phase: 'drafting' }) }), false).state).toMatchObject({ key: 'drafting', label: 'Drafting', detail: null });
    expect(roomCardView(room({ gameType: 'draft', pod: pod({ phase: 'building' }) }), false).state).toMatchObject({ key: 'building', label: 'Building', detail: null });
    expect(roomCardView(room({ gameType: 'draft', pod: pod({ phase: 'rounds', round: 2, rounds: 3 }) }), false).state).toMatchObject({ key: 'rounds', label: 'Rounds', detail: 'Round 2 of 3' });
    expect(roomCardView(room({ gameType: 'draft', pod: pod({ phase: 'done' }) }), false).state).toMatchObject({ key: 'done', label: 'Done', detail: null });
  });
});

describe('roomCardView — the way in', () => {
  it('offers Sit down to a non-member with an open seat in the lobby', () => {
    expect(roomCardView(room(), false).primaryAction).toBe('Sit down');
  });

  it('offers Join to a member, whatever the state', () => {
    expect(roomCardView(room(), true).primaryAction).toBe('Join');
    const playing = room({ tables: [table({ series: { length: 1, wins: [0, 0], games: [], phase: 'playing' } })] });
    expect(roomCardView(playing, true).primaryAction).toBe('Join');
  });

  it('offers Watch to a non-member once the room is full or no longer in its lobby', () => {
    const full = room({ members: [{ id: 'm1', name: 'a', joinedAt: '', ready: false }, { id: 'm2', name: 'b', joinedAt: '', ready: false }] });
    expect(roomCardView(full, false).primaryAction).toBe('Watch');
    const playing = room({ tables: [table({ series: { length: 1, wins: [0, 0], games: [], phase: 'playing' } })] });
    expect(roomCardView(playing, false).primaryAction).toBe('Watch');
  });

  it('adds a second Watch only when a Forge match is actually running, and never doubles up when Watch is already primary', () => {
    const live = room({ matchId: 'm-1', members: [{ id: 'm1', name: 'a', joinedAt: '', ready: false }, { id: 'm2', name: 'b', joinedAt: '', ready: false }] });
    expect(roomCardView(live, true).extraWatch).toBe(true);
    expect(roomCardView(live, false).extraWatch).toBe(false); // primary is already Watch
    expect(roomCardView(room(), false).extraWatch).toBe(false); // nothing live
  });

  it('a full room’s primary action is Watch (ruling 7)', () => {
    const full = room({ members: [{ id: 'm1', name: 'a', joinedAt: '', ready: false }, { id: 'm2', name: 'b', joinedAt: '', ready: false }] });
    expect(roomCardView(full, false).primaryAction).toBe('Watch');
    const fullPod = room({
      gameType: 'draft',
      members: new Array(8).fill(null).map((_, i) => ({ id: `m${String(i)}`, name: `p${String(i)}`, joinedAt: '', ready: false })),
      pod: pod({ phase: 'lobby' }),
    });
    expect(roomCardView(fullPod, false).primaryAction).toBe('Watch');
  });

  it('every in-progress room — any state but Lobby and Done — gets Watch beside its primary action, even with no Forge match actually running yet (ruling 7)', () => {
    // A member (primary is Join) in a drafting pod: no Forge match running (it's still a draft), but the room
    // is "in progress", so Watch belongs beside Join.
    const drafting = room({ gameType: 'draft', mode: null, modeOptions: null, pod: pod({ phase: 'drafting' }) });
    expect(roomCardView(drafting, true)).toMatchObject({ primaryAction: 'Join', extraWatch: true });

    const building = room({ gameType: 'draft', mode: null, modeOptions: null, pod: pod({ phase: 'building' }) });
    expect(roomCardView(building, true)).toMatchObject({ primaryAction: 'Join', extraWatch: true });

    const rounds = room({ gameType: 'draft', mode: null, modeOptions: null, pod: pod({ phase: 'rounds', round: 1, rounds: 3 }) });
    expect(roomCardView(rounds, true)).toMatchObject({ primaryAction: 'Join', extraWatch: true });

    const sideboarding = room({ tables: [table({ series: { length: 3, wins: [1, 0], games: [{ matchId: 'm-1', winner: 0 }], phase: 'sideboarding' } })] });
    expect(roomCardView(sideboarding, true)).toMatchObject({ primaryAction: 'Join', extraWatch: true });

    // Lobby and Done never get the extra Watch.
    expect(roomCardView(room(), true).extraWatch).toBe(false);
    const done = room({ tables: [table({ series: { length: 1, wins: [1, 0], games: [{ matchId: 'm-1', winner: 0 }], phase: 'done' } })] });
    expect(roomCardView(done, true).extraWatch).toBe(false);
  });

  it('reads Bo1/Bo3 off the room’s first table', () => {
    const bo3 = room({ tables: [table({ series: { length: 3, wins: [0, 0], games: [], phase: 'seating' } })] });
    expect(roomCardView(bo3, false).series).toBe('Bo3');
    expect(roomCardView(room(), false).series).toBe('Bo1');
  });
});

/** Which background a card draws: its format family, from the same ids the mode chip reads. */
describe('roomFamily', () => {
  it('reads a Classic format id, a Gauntlet era, an All Random pool, and draft', () => {
    expect(roomFamily(room({ format: '2018-07-13' }))).toBe('standard');
    expect(roomFamily(room({ format: 'modern-2011-07-15' }))).toBe('modern');
    expect(roomFamily(room({ format: 'legacy-2011-07-15' }))).toBe('legacy');
    expect(roomFamily(room({ format: 'free' }))).toBe('other');
    expect(roomFamily(room({ mode: 'gauntlet', modeOptions: { era: 'legacy-2004-01-01' } }))).toBe('legacy');
    expect(roomFamily(room({ mode: 'gauntlet', modeOptions: { family: 'modern' } }))).toBe('modern');
    expect(roomFamily(room({ mode: 'gauntlet', modeOptions: {} }))).toBe('standard');
    expect(roomFamily(room({ mode: 'random', modeOptions: { pool: 'full' } }))).toBe('other');
    expect(roomFamily(room({ mode: 'random', modeOptions: { pool: 'modern' } }))).toBe('modern');
    expect(roomFamily(room({ gameType: 'draft' }))).toBe('draft');
  });
});
