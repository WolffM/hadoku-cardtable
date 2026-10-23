/**
 * The room as `/api/rooms` answers with it: `RoomView` is the public shape
 * every body that carries a room uses, and `RoomBody` adds the caller's own row.
 * The server builds its views as these types and the browser parses them with
 * these schemas, so the two cannot drift.
 *
 * A body is a room only when it has an id `ROOM_ID_RE` accepts, a name, a game
 * type, a lock flag and a member list. Every other field a body lacks, or
 * carries in a shape this build does not read, falls back to its default: a
 * missing client mode is `builtin`, readiness and leadership are `false` unless
 * the server said `true` in a boolean, a missing pool is `''`, and a pod or
 * table list that does not parse is none. That direction is deliberate. A
 * builtin table for a room that turns out to be streamed is a wrong-looking
 * screen, while stream frames for a room nobody provisioned containers for are
 * a page of dead iframes; and a control nobody was given costs less than one
 * handed to the wrong person.
 */

import { z } from 'zod';

import { RoomPodSchema } from './pod.ts';
import { ROOM_ID_RE } from './room-feed.ts';
import { GameTypeSchema, RoomModeSchema, type ConstructedMode, type ModeOptions } from './room-modes.ts';
import { AVATAR_ID_MAX, ClientModeSchema, DEFAULT_CLIENT_MODE, DEFAULT_ROOM_SETTINGS, RoomSettingsSchema, type RoomSettings } from './room-requests.ts';
import { RoomTablesSchema, TableGamesSchema } from './room-tables.ts';

const memberFields = z.object({
  /** A ParticipantId from `identityFromHeaders`. */
  id: z.string(),
  /** `userIdOf(req)`, the same string `/api/whoami` returns as `userId`. */
  name: z.string(),
  joinedAt: z.string().catch(''),
  /**
   * The ROOM's readiness, which is what a draft starts on. Not a table seat's
   * Ready, which means "my deck is loaded and legal"; this one needs no deck.
   */
  ready: z.boolean().catch(false),
  /**
   * Watchparty's `sprite` id for the character this member wears: absent or a
   * non-blank string, never `null` and never `''`. Deliberately not checked
   * against watchparty's list, so a character they add still reaches the UI.
   */
  avatarId: z.string().trim().min(1).max(AVATAR_ID_MAX).optional().catch(undefined),
});
export type RoomMember = z.infer<typeof memberFields>;

/** A member with no character has no `avatarId` key at all, so a reader's fallback is one `=== undefined`. */
export const RoomMemberSchema = memberFields.transform(({ avatarId, ...member }): RoomMember => (avatarId === undefined ? member : { ...member, avatarId }));

/**
 * What the caller is in this room. `leader` is the only way a browser learns it
 * owns the table's settings, because the leader is a hashed participant id no
 * client can derive. `id` is the caller's member id as the room's tables and pod
 * name them, which can differ from whoami's (an admin session).
 */
export const RoomYouSchema = z
  .object({ id: z.string().catch(''), leader: z.boolean().catch(false), ready: z.boolean().catch(false) })
  .catch(() => ({ id: '', leader: false, ready: false }));
export type RoomYou = z.infer<typeof RoomYouSchema>;

/** Every setting a body carries as a boolean, and the server's default for the rest. */
const RoomSettingsViewSchema = z
  .object(RoomSettingsSchema.partial().shape)
  .transform((s): RoomSettings => ({ ...DEFAULT_ROOM_SETTINGS, ...s }))
  .catch(() => ({ ...DEFAULT_ROOM_SETTINGS }));

/** A member this build cannot read is left out of the list, not the room. */
const membersSchema = z
  .array(RoomMemberSchema.nullable().catch(null))
  .transform((members) => members.filter((m): m is RoomMember => m !== null));

const roomFields = {
  id: z.string().regex(ROOM_ID_RE),
  name: z.string(),
  creator: z.string().catch(''),
  leader: z.string().catch(''),
  gameType: GameTypeSchema,
  /**
   * The table's pool, and the rules both seats' decks are checked against: a
   * frozen era's `TableFormat.id`, the leader's to change. The server always
   * sends one; `''` is a body that lost it.
   */
  format: z.string().catch(''),
  settings: RoomSettingsViewSchema,
  /** Read as a pair with `modeOptions`, below. */
  mode: z.unknown().optional(),
  modeOptions: z.unknown().optional(),
  /** Fixed at create, for the room's whole life. */
  clientMode: ClientModeSchema.catch(DEFAULT_CLIENT_MODE),
  /** Whether a password is set: never the password, never any hash of it. */
  locked: z.boolean(),
  members: membersSchema,
  /** The room's tables, always at least one. */
  tables: RoomTablesSchema.catch(() => []),
  /** The first table's live match, restated for readers that only know one table. */
  matchId: z.string().nullable().catch(null),
  /**
   * When the draft was dealt, or null for the lobby phase. Never restored from
   * disk, because the draft lives in one process's memory: a restart puts the
   * room back in its lobby with its ready flags intact.
   */
  draftStartedAt: z.string().nullable().catch(null),
  /** The pod, present when `gameType` is `draft`, or `constructed-1v1` with `settings.tournament` on. */
  pod: RoomPodSchema.catch(null),
  createdAt: z.string().catch(''),
  /**
   * A seeded testing room (admin-only, never swept, never stale — `room/lobby.ts`'s
   * `RoomRecord.testing`). Absent on disk for a room written before the flag
   * existed, which reads back `false` — the only correct default, since every
   * such room is an ordinary one. `GET /api/rooms` omits these entirely for a
   * non-admin, so the front page's Testing section is just "any room this list
   * carries with `testing: true`", never a client-side tier check.
   */
  testing: z.boolean().catch(false),
};

/**
 * A constructed room's mode and that mode's options, or both null: until the
 * leader chooses one, for a draft room, and for a pair this build does not know.
 */
function withMode<T extends { mode?: unknown; modeOptions?: unknown }>({ mode, modeOptions, ...rest }: T): Omit<T, 'mode' | 'modeOptions'> & { mode: ConstructedMode | null; modeOptions: ModeOptions | null } {
  const parsed = RoomModeSchema.safeParse({ mode, modeOptions });
  return { ...rest, ...(parsed.success ? parsed.data : { mode: null, modeOptions: null }) };
}

export const RoomViewSchema = z.object(roomFields).transform(withMode);
export type RoomView = z.infer<typeof RoomViewSchema>;

export const RoomBodySchema = z
  .object({
    ...roomFields,
    you: RoomYouSchema,
    /** Each table's game for the table card, by table id; none from a server that does not send it. */
    tableGames: TableGamesSchema.optional().catch(undefined),
  })
  .transform(withMode);
export type RoomBody = z.infer<typeof RoomBodySchema>;
