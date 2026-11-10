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
import { AVATAR_ID_MAX } from '@hadoku/platform-wire/look';

import { LookSchema } from './look.ts';
import { ROOM_ID_RE } from './room-feed.ts';

export { SEATS_OPEN_BEFORE_MS, seatsOpenAt } from '@hadoku/platform-wire/events';

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
  /** Their avatar picture and cosmetics (`look.ts`). Absent when they have neither. */
  look: LookSchema.optional().catch(undefined),
});
export type RoomMember = z.infer<typeof memberFields>;

/** A member with no character has no `avatarId` key at all, so a reader's fallback is one `=== undefined`. */
export const RoomMemberSchema = memberFields.transform(({ avatarId, look, ...member }): RoomMember => ({
  ...member,
  ...(avatarId === undefined ? {} : { avatarId }),
  ...(look === undefined ? {} : { look }),
}));

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

/** A member this build cannot read is left out of the list, not the room. */
const membersSchema = z
  .array(RoomMemberSchema.nullable().catch(null))
  .transform((members) => members.filter((m): m is RoomMember => m !== null));

/**
 * Why each of a room's controls cannot change now, or `null` where it can — the server's own answer
 * (`room/lobby.ts`'s `roomLocks`), the same one its setters refuse with. A screen offers a control
 * only where this says `null` (and the caller leads), so nothing it offers is refused.
 *
 * - `gameType`, `mode`: what the room plays (a constructed room's mode and its options);
 * - `event`: Tournament and its decks;
 * - `format`: the pool;
 * - `rules`: the match rules (hand smoothing, the clock, the pick timer).
 */
export const ROOM_LOCK_REASONS = ['draft-started', 'mode-locked', 'historical'] as const;
export const RoomLockSchema = z.enum(ROOM_LOCK_REASONS).nullable();
export const ROOM_CONTROLS = ['gameType', 'mode', 'event', 'format', 'rules'] as const;
export type RoomControl = (typeof ROOM_CONTROLS)[number];
export type RoomLocks = Record<RoomControl, z.infer<typeof RoomLockSchema>>;
export const OPEN_ROOM_LOCKS: Readonly<RoomLocks> = Object.freeze({ gameType: null, mode: null, event: null, format: null, rules: null });
const RoomLocksSchema = z
  .object({ gameType: RoomLockSchema.catch(null), mode: RoomLockSchema.catch(null), event: RoomLockSchema.catch(null), format: RoomLockSchema.catch(null), rules: RoomLockSchema.catch(null) })
  .catch(() => ({ ...OPEN_ROOM_LOCKS }));

/**
 * Every field a room has whatever game it plays. The game's own part — `format`, `mode`, a pod, a
 * table's seats and the rest — is NOT here: `magic-room.ts` spreads this base together with
 * Magic's fields to build `RoomViewSchema`/`RoomBodySchema`, so this stays the one object a future
 * game's own composition could reuse unchanged.
 */
export const roomBaseFields = {
  id: z.string().regex(ROOM_ID_RE),
  name: z.string(),
  creator: z.string().catch(''),
  leader: z.string().catch(''),
  /**
   * What the room plays: any id a `GameTypeSpec` registers
   * (`game-type-spec.ts`) — Magic's own two, always, or a game this build
   * does not know, kept as the string it is rather than refused.
   */
  gameType: z.string(),
  /**
   * The game's own part of the room, which the game validates: Magic's is
   * `MagicRoomGameSchema` (`magic-room.ts`). Its fields are also restated at the
   * top level below, for readers that have not moved to `game.*`. Absent from
   * a server that predates it.
   */
  game: z.unknown().optional(),
  /** What cannot change now, and why (`RoomLocks`). A server that sends none: everything open, and its refusals still answer. */
  locks: RoomLocksSchema,
  /** Whether a password is set: never the password, never any hash of it. */
  locked: z.boolean(),
  members: membersSchema,
  /** The first table's live match, restated for readers that only know one table. */
  matchId: z.string().nullable().catch(null),
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
  /** When the event this room was made for starts (`apps/server/src/room/events.ts`); null for a room no event made. */
  scheduledFor: z.string().nullable().catch(null),
  /** A Challenge's open seat → the list its real player played, which whoever sits there plays. Absent elsewhere. */
  seatDecks: z.record(z.string(), z.string()).optional().catch(undefined),
};
