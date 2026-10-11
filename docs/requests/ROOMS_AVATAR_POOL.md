# Request to `hadoku-watchparty`: publish the character pool and a pool-only pick

**Filed 2026-10-11 by cardtable lane YY.** **Status: request, not yet sent.**

## What the operator saw

*"just had a game with 'rhomancer' and they had no avatar selected. in watchparty
there is logic to auto-select an avatar we should probably port that into the
generic functionality as well."*

## What cardtable did

Cardtable's room server now hands a member who has picked nothing the first
character no current member wears, on joining — watchparty's own join rule
(`apps/server/src/ws/join.ts`: `getAvailableSprites(room)[0]`). A pick replaces
it; a pick of a handed-out character moves its holder to the next free one.
`apps/server/src/room/lobby.ts` (`AVATAR_POOL`, `freeAvatar`, `newMember`).

Two parts of that are copies, because the shared versions cannot be reached:

1. **The pool.** `CHARACTER_ORDER` lives in `@watchparty/shared`
   (`packages/shared/src/protocol.ts`), which is private to the watchparty repo.
   Cardtable carries the eight ids as `AVATAR_POOL`. A ninth character added on
   your side is not handed out by cardtable until somebody copies it again.
2. **The pick.** `@wolffm/rooms-server`'s `availableAvatars(room, pool)` takes a
   whole `CoreRoomState` and reads only `room.usedAvatars`. Cardtable's rooms are
   not socket rooms (`packages/room-store` snapshots, members with an `avatarId`
   each), so there is no `CoreRoomState` to pass.

## The ask

1. Export the fleet's character pool from `@wolffm/rooms-protocol` (e.g.
   `AVATAR_POOL`, with `CHARACTER_ORDER` re-exported from it in
   `@watchparty/shared` so watchparty keeps its name).
2. Export a pool-only pick from `@wolffm/rooms-server` (or rooms-protocol, it is
   pure): `firstFreeAvatar(worn: Iterable<string | undefined>, pool): string | undefined`,
   and have `availableAvatars` / watchparty's join use it.

## Done when

Both are published; cardtable then deletes `AVATAR_POOL` and `freeAvatar` from
`apps/server/src/room/lobby.ts` and imports them.
