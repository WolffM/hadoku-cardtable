/**
 * Magic's part of a room. A room is a `gameType` plus a `game` blob the game
 * itself validates (`room-view.ts`); this file is Magic's blob, for the two
 * game types Magic plays.
 *
 * Two shapes, because the wire and the disk carry different things:
 *
 * - `MagicRoomGameSchema` is the blob a `RoomView` carries as `game`. It holds
 *   only what the view already showed (the same values are also restated at the
 *   view's top level, for the readers that have not moved to `game.*` yet).
 * - `MAGIC_ROOM_STORED_KEYS` names the fields a saved room nests under `game`
 *   (app version 2, `apps/server/src/room/lobby.ts`'s app codec). Several of
 *   them never reach the wire: a Gauntlet's draw and a tournament's locked decks
 *   are hidden information, and the server validates their shapes itself.
 */

import { z } from 'zod';

import { RoomPodSchema } from './pod.ts';
import { GAME_TYPES, RoomModeSchema, type ConstructedMode, type GameType, type ModeOptions } from './room-modes.ts';
import { ClientModeSchema, DEFAULT_CLIENT_MODE } from './room-requests.ts';

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
export function withMode<T extends { mode?: unknown; modeOptions?: unknown }>({ mode, modeOptions, ...rest }: T): Omit<T, 'mode' | 'modeOptions'> & { mode: ConstructedMode | null; modeOptions: ModeOptions | null } {
  const parsed = RoomModeSchema.safeParse({ mode, modeOptions });
  return { ...rest, ...(parsed.success ? parsed.data : { mode: null, modeOptions: null }) };
}

/** A room view's `game` for a Magic room. */
export const MagicRoomGameSchema = z.object(magicRoomFields).transform(withMode);
export type MagicRoomGame = z.infer<typeof MagicRoomGameSchema>;
