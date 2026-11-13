/**
 * Splitting the room view into a platform base and Magic's composition must not move a single byte of what a browser already
 * reads, and Magic's fields reach it only as `game`. These fixtures are shaped like `games/magic/server/src/http/rooms.test.ts`'s "answers a room the
 * browser reads as itself" room — a real draft room's view and body — and the expected output below
 * was captured by running them through `RoomViewSchema`/`RoomBodySchema` BEFORE the split (the
 * monolithic schema that lived whole in `room-view.ts`). If the split ever changes what either
 * schema outputs, this goes red; it stays `@hadoku/platform-wire`-typed yet Magic-composed, so it
 * also imports both halves to prove neither one quietly swallowed the other's fields.
 */

import { describe, expect, it } from 'vitest';

import { magicGame, magicRoomFields, RoomBodySchema, RoomViewSchema } from './magic-room.ts';
import { roomBaseFields } from './room-view.ts';

const FIXTURE_VIEW = {
  id: 'r-abc123',
  name: 'Cube night',
  creator: 'alice-id',
  leader: 'alice-id',
  gameType: 'draft',
  // Magic's blob: the only place the server sends its fields.
  game: { format: 'cube-2026', clientMode: 'builtin', draftStartedAt: null, pod: null },
  settings: { handSmoothing: false, tournament: false, tournamentDecks: 'locked', clock: 'auto', pickTimer: { on: false, speed: 1 }, draftBots: 'model' },
  locks: { gameType: 'draft-started', mode: null, event: null, format: null, rules: null },
  locked: true,
  members: [
    { id: 'alice-id', name: 'alice', joinedAt: '2026-11-01T00:00:00.000Z', ready: true, avatarId: 'pepper', look: { picture: 'https://cdn.discordapp.com/x.png' } },
    { id: 'bob-id', name: 'bob', joinedAt: '2026-11-01T00:05:00.000Z', ready: false },
  ],
  seats: ['alice-id', 'bob-id'],
  tables: [
    { id: 't-0000abcd', players: [{ memberId: 'alice-id', name: 'alice' }, { memberId: 'bob-id', name: 'bob' }], matchId: null, series: { length: 3, wins: [1, 0], games: [{ matchId: 'm-1', winner: 0 }], phase: 'between' } },
  ],
  matchId: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  testing: false,
  scheduledFor: null,
} as const;

const FIXTURE_BODY = { ...FIXTURE_VIEW, you: { id: 'alice-id', leader: true, ready: true }, ai: { name: 'Lia', avatarId: 'npc-lia' } };

/**
 * Captured from the pre-split, monolithic `RoomViewSchema.parse(FIXTURE_VIEW)` — byte for byte, but for Magic's fields, which
 * that schema read at the top level and this one reads only from `game` (its mode and options read as unchosen).
 */
const EXPECTED_VIEW = {
  id: 'r-abc123', name: 'Cube night', creator: 'alice-id', leader: 'alice-id', gameType: 'draft',
  game: { format: 'cube-2026', clientMode: 'builtin', draftStartedAt: null, pod: null, mode: null, modeOptions: null },
  settings: { handSmoothing: false, tournament: false, tournamentDecks: 'locked', clock: 'auto', pickTimer: { on: false, speed: 1 }, draftBots: 'model' },
  locks: { gameType: 'draft-started', mode: null, event: null, format: null, rules: null },
  locked: true,
  members: [
    { id: 'alice-id', name: 'alice', joinedAt: '2026-11-01T00:00:00.000Z', ready: true, avatarId: 'pepper', look: { picture: 'https://cdn.discordapp.com/x.png' } },
    { id: 'bob-id', name: 'bob', joinedAt: '2026-11-01T00:05:00.000Z', ready: false },
  ],
  seats: ['alice-id', 'bob-id'],
  tables: [
    { id: 't-0000abcd', players: [{ memberId: 'alice-id', name: 'alice' }, { memberId: 'bob-id', name: 'bob' }], matchId: null, series: { length: 3, wins: [1, 0], games: [{ matchId: 'm-1', winner: 0 }], phase: 'between' } },
  ],
  matchId: null, createdAt: '2026-11-01T00:00:00.000Z', testing: false, scheduledFor: null,
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

  it("parses Magic's blob as `game`, and reads none of its fields at the top level", () => {
    // A constructed room as `viewOf` sends it; the same fields at the top level are a body this schema does not read.
    const magic = { format: '2018-07-13', mode: 'gauntlet', modeOptions: { family: 'modern', year: 2020 }, clientMode: 'streamed', draftStartedAt: null, pod: null, scenario: 'board.pzl' };
    const body = { ...FIXTURE_BODY, gameType: 'constructed-1v1', ...magic, game: magic };
    for (const schema of [RoomViewSchema, RoomBodySchema]) {
      const parsed = schema.parse(body) as Record<string, unknown> & { gameType: string };
      const game = magicGame(parsed) as Record<string, unknown>;
      for (const key of Object.keys(magicRoomFields)) expect([game[key], parsed[key]], key).toStrictEqual([magic[key as keyof typeof magic], undefined]);
    }
    // And a draft room's, its pod and its draft's start with it.
    const draft = RoomViewSchema.parse({ ...FIXTURE_VIEW, game: { ...FIXTURE_VIEW.game, draftStartedAt: '2026-11-01T00:10:00.000Z' } });
    expect(magicGame(draft)).toStrictEqual({ format: 'cube-2026', clientMode: 'builtin', draftStartedAt: '2026-11-01T00:10:00.000Z', pod: null, mode: null, modeOptions: null });
  });

  it("reads a Magic room's missing or malformed blob as every field at its fallback, and another game's as it came", () => {
    const fallback = { format: '', clientMode: 'builtin', draftStartedAt: null, pod: null, mode: null, modeOptions: null };
    const { game: _none, ...older } = FIXTURE_VIEW;
    expect(magicGame(RoomViewSchema.parse(older))).toStrictEqual(fallback);
    expect(magicGame(RoomViewSchema.parse({ ...FIXTURE_VIEW, game: 'not a blob' }))).toStrictEqual(fallback);
    const other = RoomViewSchema.parse({ ...FIXTURE_VIEW, gameType: 'bomberman', game: { arena: 3 } });
    expect(other.game).toStrictEqual({ arena: 3 });
    expect(magicGame(other)).toStrictEqual(fallback);
  });

  it("the platform base carries none of Magic's own room fields", () => {
    const magicKeys = Object.keys(magicRoomFields);
    for (const key of magicKeys) expect(Object.keys(roomBaseFields)).not.toContain(key);
    expect(magicKeys).toContain('format');
    expect(magicKeys).toContain('pod');
  });
});
