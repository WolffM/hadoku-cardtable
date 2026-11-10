/**
 * Splitting the room view into a platform base and Magic's composition must not move a single byte of what a browser already
 * reads. These fixtures are shaped like `apps/server/src/http/rooms.test.ts`'s "answers a room the
 * browser reads as itself" room — a real draft room's view and body — and the expected output below
 * was captured by running them through `RoomViewSchema`/`RoomBodySchema` BEFORE the split (the
 * monolithic schema that lived whole in `room-view.ts`). If the split ever changes what either
 * schema outputs, this goes red; it stays `@hadoku/platform-wire`-typed yet Magic-composed, so it
 * also imports both halves to prove neither one quietly swallowed the other's fields.
 */

import { describe, expect, it } from 'vitest';

import { magicRoomFields, RoomBodySchema, RoomViewSchema } from './magic-room.ts';
import { roomBaseFields } from './room-view.ts';

const FIXTURE_VIEW = {
  id: 'r-abc123',
  name: 'Cube night',
  creator: 'alice-id',
  leader: 'alice-id',
  gameType: 'draft',
  format: 'cube-2026',
  clientMode: 'builtin',
  draftStartedAt: null,
  pod: null,
  settings: { handSmoothing: false, tournament: false, tournamentDecks: 'locked', clock: 'auto', pickTimer: { on: false, speed: 1 }, draftBots: 'model' },
  locks: { gameType: 'draft-started', mode: null, event: null, format: null, rules: null },
  locked: true,
  members: [
    { id: 'alice-id', name: 'alice', joinedAt: '2026-11-01T00:00:00.000Z', ready: true, avatarId: 'pepper', look: { picture: 'https://cdn.discordapp.com/x.png' } },
    { id: 'bob-id', name: 'bob', joinedAt: '2026-11-01T00:05:00.000Z', ready: false },
  ],
  tables: [
    { id: 't-0000abcd', players: [{ memberId: 'alice-id', name: 'alice' }, { memberId: 'bob-id', name: 'bob' }], matchId: null, series: { length: 3, wins: [1, 0], games: [{ matchId: 'm-1', winner: 0 }], phase: 'between' } },
  ],
  matchId: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  testing: false,
  scheduledFor: null,
} as const;

const FIXTURE_BODY = { ...FIXTURE_VIEW, you: { id: 'alice-id', leader: true, ready: true }, ai: { name: 'Lia', avatarId: 'npc-lia' } };

/** Captured from the pre-split, monolithic `RoomViewSchema.parse(FIXTURE_VIEW)` — byte for byte. */
const EXPECTED_VIEW = {
  id: 'r-abc123', name: 'Cube night', creator: 'alice-id', leader: 'alice-id', gameType: 'draft', format: 'cube-2026', clientMode: 'builtin',
  draftStartedAt: null, pod: null,
  settings: { handSmoothing: false, tournament: false, tournamentDecks: 'locked', clock: 'auto', pickTimer: { on: false, speed: 1 }, draftBots: 'model' },
  locks: { gameType: 'draft-started', mode: null, event: null, format: null, rules: null },
  locked: true,
  members: [
    { id: 'alice-id', name: 'alice', joinedAt: '2026-11-01T00:00:00.000Z', ready: true, avatarId: 'pepper', look: { picture: 'https://cdn.discordapp.com/x.png' } },
    { id: 'bob-id', name: 'bob', joinedAt: '2026-11-01T00:05:00.000Z', ready: false },
  ],
  tables: [
    { id: 't-0000abcd', players: [{ memberId: 'alice-id', name: 'alice' }, { memberId: 'bob-id', name: 'bob' }], matchId: null, series: { length: 3, wins: [1, 0], games: [{ matchId: 'm-1', winner: 0 }], phase: 'between' } },
  ],
  matchId: null, createdAt: '2026-11-01T00:00:00.000Z', testing: false, scheduledFor: null,
  mode: null, modeOptions: null,
};

/** Captured the same way from `RoomBodySchema.parse(FIXTURE_BODY)`. */
const EXPECTED_BODY = { ...EXPECTED_VIEW, you: { id: 'alice-id', leader: true, ready: true }, ai: { name: 'Lia', avatarId: 'npc-lia' } };

describe('RoomView/RoomBody: platform base + magic composition parse to the same room', () => {
  it('RoomViewSchema (now composed in magic-room.ts) matches the pre-split output', () => {
    expect(RoomViewSchema.parse(FIXTURE_VIEW)).toStrictEqual(EXPECTED_VIEW);
  });

  it('RoomBodySchema (now composed in magic-room.ts) matches the pre-split output', () => {
    expect(RoomBodySchema.parse(FIXTURE_BODY)).toStrictEqual(EXPECTED_BODY);
  });

  it("the platform base carries none of Magic's own room fields", () => {
    const magicKeys = Object.keys(magicRoomFields);
    for (const key of magicKeys) expect(Object.keys(roomBaseFields)).not.toContain(key);
    expect(magicKeys).toContain('format');
    expect(magicKeys).toContain('pod');
  });
});
