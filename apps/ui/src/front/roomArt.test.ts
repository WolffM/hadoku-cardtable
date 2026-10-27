import { describe, expect, it } from 'vitest';
import type { PodView, RoomTable } from '@hadoku/shared';

import type { RoomView } from '../rooms/api.ts';
import { FORMAT_ART, roomArtId } from './roomArt.ts';

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

describe('roomArtId', () => {
  it('is a well-formed Scryfall id, never a URL, for a plain Standard room', () => {
    const id = roomArtId(room());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('every FORMAT_ART entry resolves to a real id through the committed art-ids table', () => {
    for (const name of Object.values(FORMAT_ART)) {
      expect(roomArtId(room({ format: name === FORMAT_ART.modern ? 'modern-2011-07-15' : '2026-01-01' })), name).toBeDefined();
    }
  });

  it('picks the Modern/Legacy picture by the room’s own era family, and Draft for every draft room', () => {
    const standard = roomArtId(room({ format: '2018-07-13' }));
    const modern = roomArtId(room({ format: 'modern-2011-07-15' }));
    const legacy = roomArtId(room({ format: 'legacy-2011-07-15' }));
    const draft = roomArtId(room({ gameType: 'draft', mode: null, modeOptions: null, pod: pod({ phase: 'lobby' }) }));
    // Four different pictures (unless two of the four happened to collide, which they do not: distinct names).
    expect(new Set([standard, modern, legacy, draft]).size).toBe(4);
  });

  it('prefers the room’s own constructed deck art over its format picture, by name through the art-ids table', () => {
    const withDeckArt = room({
      tableGames: { 't-1': { decks: [{ name: 'Bolt deck', colors: [], art: 'Lightning Bolt' }, null], live: null } },
    });
    const noDeckArt = room({ tableGames: { 't-1': { decks: [null, null], live: null } } });
    expect(roomArtId(withDeckArt)).toBe(roomArtId(room({ format: 'legacy-2011-07-15' }))); // both resolve "Lightning Bolt"
    // Without deck art, the room falls back to its format picture — a different id for a Standard room.
    expect(roomArtId(noDeckArt)).not.toBe(roomArtId(withDeckArt));
  });

  it('never throws on a deck art name the table does not know', () => {
    const unknown = room({ tableGames: { 't-1': { decks: [{ name: 'd', colors: [], art: 'Not A Real Card Xyzzy' }, null], live: null } } });
    expect(() => roomArtId(unknown)).not.toThrow();
    expect(roomArtId(unknown)).toBeDefined(); // falls back to the format picture
  });
});
