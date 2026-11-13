/*
 * @hadoku/shared/platform — the wire contract's pieces that know no game.
 *
 * `index.ts` (the package's default entry, `.`) is Magic's: the draft envelope, the match
 * protocol, pods, cubes, gauntlets, tournaments and everything else a Magic room or match needs,
 * plus the platform pieces below re-exported again for Magic's own convenience (a magic file may
 * import platform; that edge is fine and unrelated to this file).
 *
 * THIS entry is what a platform file may import instead: a room's public membership/controls view
 * (`room-view.ts`, which carries no card, deck or Forge field — see its own header) and the
 * game-type registry a room's lobby seats any game through (`game-type-spec.ts`, whose own header
 * already calls itself "Platform (MIT)"). Importing only from here pulls in no Magic code.
 */

export {
  RoomMemberSchema,
  RoomYouSchema,
  OPEN_ROOM_LOCKS,
  ROOM_CONTROLS,
  ROOM_LOCK_REASONS,
  SEATS_OPEN_BEFORE_MS,
  seatsOpenAt,
  type RoomControl,
  type RoomLocks,
  type RoomMember,
  type RoomYou,
} from './room-view.ts';
export { AVATAR_ID_MAX } from '@hadoku/platform-wire/look';
export {
  registerGameType,
  gameTypeSpec,
  isRegisteredGameType,
  type GameTypeSpec,
  type SeatRange,
  type Verdict,
  type BotFill,
  type GameCodec,
} from './game-type-spec.ts';
