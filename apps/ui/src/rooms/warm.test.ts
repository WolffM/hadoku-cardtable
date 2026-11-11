/**
 * `warmRoom`'s own catalogue question: only a Constructed room ever shows a deck picker, so only
 * it is worth fetching formats and decks for while the list is still on screen. A draft room
 * already skipped that fetch; a registered non-Magic room (bomberman, say) used to be fetched it
 * too, because the old check was "not a draft" rather than "is Constructed" — this file pins the
 * fix directly, without mounting `ConstructedScreen.tsx` (that screen's own `warm.ts` coverage,
 * `apps/ui/src/screens/constructed.test.ts`, is Constructed's own and not this lane's to touch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_ROOM_LOCKS } from '@hadoku/shared';

import type { TablesClient, RoomTable, TableFormat, TableDeck } from '../screens/tables.ts';
import type { RoomView } from './api.ts';
import { takeWarmRoom, warmRoom } from './warm.ts';

const view = (gameType: string): RoomView => ({
  id: 'r-1',
  name: 'Table',
  creator: '',
  leader: '',
  gameType,
  settings: { handSmoothing: true, tournament: false, tournamentDecks: 'locked', clock: 'auto', pickTimer: { on: false, speed: 1 }, draftBots: 'model' },
  locks: { ...OPEN_ROOM_LOCKS },
  locked: false,
  members: [{ id: 'm1', name: 'alice', joinedAt: '', ready: false }],
  tables: [{ id: 't-1', players: [], matchId: null, series: { length: 1, wins: [0, 0], games: [], phase: 'seating' } }],
  matchId: null,
  createdAt: '',
  testing: false,
  scheduledFor: null,
  you: { id: 'm1', leader: true, ready: false },
  game: { format: '', mode: null, modeOptions: null, clientMode: 'builtin', draftStartedAt: null, pod: null },
});

const ROOM_TABLE: RoomTable = { room: { id: 'r-1', name: 'Table', gameType: 'constructed-1v1', matchId: null, seats: 2 }, you: { player: true, leader: true }, players: [] };
const FORMATS: TableFormat[] = [{ id: 'f-1', name: 'Newest', family: 'standard' } as TableFormat];
const DECKS: TableDeck[] = [];

function stubClient(): TablesClient & { formats: ReturnType<typeof vi.fn>; decks: ReturnType<typeof vi.fn>; table: ReturnType<typeof vi.fn> } {
  return {
    formats: vi.fn(async () => FORMATS),
    decks: vi.fn(async () => DECKS),
    table: vi.fn(async () => ({ ok: true, table: ROOM_TABLE })),
  } as unknown as TablesClient & { formats: ReturnType<typeof vi.fn>; decks: ReturnType<typeof vi.fn>; table: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  // `takeWarmRoom` is one-shot, module-level state: clear whatever an earlier test in this file left pending.
  takeWarmRoom('r-1');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('warmRoom — the deck catalogue is Constructed-only', () => {
  it('fetches formats and decks for a constructed-1v1 room', async () => {
    const client = stubClient();
    await warmRoom(view('constructed-1v1'), client);
    expect(client.formats).toHaveBeenCalledTimes(1);
    expect(client.decks).toHaveBeenCalledTimes(1);
    expect(takeWarmRoom('r-1')?.catalogue).toEqual({ formats: FORMATS, decks: DECKS });
  });

  it('never fetches it for a draft room, which holds no deck', async () => {
    const client = stubClient();
    await warmRoom(view('draft'), client);
    expect(client.formats).not.toHaveBeenCalled();
    expect(client.decks).not.toHaveBeenCalled();
    expect(takeWarmRoom('r-1')?.catalogue).toBeUndefined();
  });

  it('never fetches it for a registered non-Magic room either (bomberman, say) — the regression this file pins', async () => {
    const client = stubClient();
    await warmRoom(view('bomberman'), client);
    expect(client.formats).not.toHaveBeenCalled();
    expect(client.decks).not.toHaveBeenCalled();
    const warm = takeWarmRoom('r-1');
    expect(warm?.catalogue).toBeUndefined();
    // The table itself is still read — a bomberman room still warms its seats.
    expect(client.table).toHaveBeenCalledTimes(1);
    expect(warm?.table).toEqual(ROOM_TABLE);
  });
});
