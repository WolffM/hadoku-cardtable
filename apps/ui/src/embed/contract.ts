/*
 * The game-bundle contract watchparty mounts us through (D21), as watchparty
 * publishes it. Everything in the embed imports it from here.
 *
 * `roomKey` is watchparty's ROOM ID, the same for the leader and every viewer
 * — never the key a person joined by, which for the leader is a credential.
 * Cardtable treats it as opaque: the server hashes it into the table's id
 * (`watchpartyRoomId`, `apps/server/src/room/lobby.ts`), so its shape does not
 * have to fit cardtable's room-id rules.
 */

export type {
  GameBundleContext,
  GameBundleIdentity,
  GameBundleModule,
  MountedGameBundle,
} from "@wolffm/rooms-protocol";
