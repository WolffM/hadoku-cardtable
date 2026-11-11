/**
 * Magic's part of a room, and the composition that turns `room-view.ts`'s generic base into the
 * `RoomView`/`RoomBody` `/api/rooms` actually answers with. A room is a `gameType` plus a `game`
 * blob the game itself validates; this file is Magic's blob, for the two game types Magic plays —
 * and, because the platform base must not know that blob's shape, it is also where the base and
 * the blob are spread together.
 *
 * Two shapes, because the wire and the disk carry different things:
 *
 * - `MagicRoomGameSchema` is the blob a `RoomView` carries as `game`, and the only
 *   place a view carries Magic's fields; `magicGame` reads it.
 * - `MAGIC_ROOM_STORED_KEYS` names the fields a saved room nests under `game`
 *   (app version 2, `apps/server/src/room/lobby.ts`'s app codec). Several of
 *   them never reach the wire: a Gauntlet's draw and a tournament's locked decks
 *   are hidden information, and the server validates their shapes itself.
 */

import { z } from 'zod';
import { AVATAR_ID_MAX } from '@hadoku/platform-wire/look';

import { RoomPodSchema } from './pod.ts';
import { roomBaseFields, RoomYouSchema } from './room-view.ts';
import { GAME_TYPES, RoomModeSchema, type ConstructedMode, type GameType, type ModeOptions } from './room-modes.ts';
import { ClientModeSchema, DEFAULT_CLIENT_MODE, DEFAULT_ROOM_SETTINGS, RoomSettingsSchema, type RoomSettings } from './room-requests.ts';
import { RoomTablesSchema, TableGamesSchema } from './room-tables.ts';

/** Whether Magic plays this game type. A room of any other type carries no Magic field. */
export function isMagicGameType(gameType: string): gameType is GameType {
  return (GAME_TYPES as readonly string[]).includes(gameType);
}

/** Every field a saved Magic room keeps under `game`. */
export const MAGIC_ROOM_STORED_KEYS = [
  'format',
  'mode',
  'modeOptions',
  'clientMode',
  'plan',
  'planVerdict',
  'podSeats',
  'podAi',
  'podDrafts',
  'podSplit',
  'pod',
  'podPlaying',
  'draftStartedAt',
  'scenario',
  'gauntlet',
  'gauntlets',
  'lockedDecks',
] as const;

/** Magic's fields as a view carries them, each with the fallback a body that lacks it reads back. */
export const magicRoomFields = {
  /**
   * The table's pool, and the rules both seats' decks are checked against: a
   * frozen era's `TableFormat.id`, the leader's to change. The server always
   * sends one; `''` is a body that lost it.
   */
  format: z.string().catch(''),
  /** Read as a pair with `modeOptions`, below. */
  mode: z.unknown().optional(),
  modeOptions: z.unknown().optional(),
  /** Fixed at create, for the room's whole life. */
  clientMode: ClientModeSchema.catch(DEFAULT_CLIENT_MODE),
  /**
   * When the draft was dealt, or null for the lobby phase. A restart resumes a
   * draft its snapshot kept (`room/draftRooms.ts`), and puts a room whose draft
   * did not come back in its lobby with its ready flags intact.
   */
  draftStartedAt: z.string().nullable().catch(null),
  /** The pod, present when `gameType` is `draft`, or `constructed-1v1` with `settings.tournament` on. */
  pod: RoomPodSchema.catch(null),
  /**
   * A board-state testing room's own Forge puzzle board (`room/lobby.ts`'s
   * `RoomRecord.scenario`, set only by `room/testing-rooms.ts`). Absent for
   * every other room, and for a non-admin — `GET /api/rooms` omits a testing
   * room entirely for one, so this never reaches a client that could not
   * already see the room it belongs to.
   */
  scenario: z.string().optional(),
};

/**
 * A constructed room's mode and that mode's options, or both null: until the
 * leader chooses one, for a draft room, and for a pair this build does not know.
 */
function withMode<T extends { mode?: unknown; modeOptions?: unknown }>({ mode, modeOptions, ...rest }: T): Omit<T, 'mode' | 'modeOptions'> & { mode: ConstructedMode | null; modeOptions: ModeOptions | null } {
  const parsed = RoomModeSchema.safeParse({ mode, modeOptions });
  return { ...rest, ...(parsed.success ? parsed.data : { mode: null, modeOptions: null }) };
}

/** A room view's `game` for a Magic room. */
export const MagicRoomGameSchema = z.object(magicRoomFields).transform(withMode);
export type MagicRoomGame = z.infer<typeof MagicRoomGameSchema>;

/** What a body that lacks Magic's blob reads back: every field at its fallback. */
const NO_MAGIC_GAME: MagicRoomGame = Object.freeze(MagicRoomGameSchema.parse({}));

/** A room's `game` parsed as Magic's blob when Magic plays the room; any other game's blob stays as it came. */
function withGame<T extends { gameType: string; game?: unknown }>(room: T): T {
  return isMagicGameType(room.gameType) ? { ...room, game: MagicRoomGameSchema.catch(() => NO_MAGIC_GAME).parse(room.game ?? {}) } : room;
}

/**
 * Magic's part of a parsed room: its `game`, which `RoomViewSchema`/`RoomBodySchema` parsed with
 * `MagicRoomGameSchema` because Magic plays it. A room of another game reads every field at its
 * fallback, as a body that lacks them does.
 */
export function magicGame(room: { gameType: string; game?: unknown }): MagicRoomGame {
  return isMagicGameType(room.gameType) ? (room.game as MagicRoomGame) : NO_MAGIC_GAME;
}

/** Every setting a body carries as a boolean, and the server's default for the rest. */
const RoomSettingsViewSchema = z
  .object(RoomSettingsSchema.partial().shape)
  .transform((s): RoomSettings => ({ ...DEFAULT_ROOM_SETTINGS, ...s }))
  .catch(() => ({ ...DEFAULT_ROOM_SETTINGS }));

/**
 * The room's base (`room-view.ts`'s `roomBaseFields`) plus Magic's own fields, settings and
 * tables — this composition, not the base alone, is `RoomView`/`RoomBody` as `/api/rooms` answers
 * with it. A future game would compose the same base with its own fields instead.
 */
const roomFields = {
  ...roomBaseFields,
  settings: RoomSettingsViewSchema,
  /** The room's tables, always at least one. */
  tables: RoomTablesSchema.catch(() => []),
};

export const RoomViewSchema = z.object(roomFields).transform(withGame);
export type RoomView = z.infer<typeof RoomViewSchema>;

export const RoomBodySchema = z
  .object({
    ...roomFields,
    you: RoomYouSchema,
    /** Each table's game for the table card, by table id; none from a server that does not send it. */
    tableGames: TableGamesSchema.optional().catch(undefined),
    /** The room's AI, the character an AI seat plays as (`room/lobby.ts`'s `roomAi`). */
    ai: z.object({ name: z.string(), avatarId: z.string().max(AVATAR_ID_MAX) }).optional().catch(undefined),
  })
  .transform(withGame);
export type RoomBody = z.infer<typeof RoomBodySchema>;
