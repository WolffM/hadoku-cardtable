# Request to `hadoku-watchparty`: room passwords and room/table id minting in `@wolffm/rooms-server`

**Filed 2026-11-11 by cardtable (wave 100).** **Status: OPEN.**

## Why

The operator's ruling stands: all room logic is identical across the apps, and only CSS and UI differ. Cardtable's
room server has two pieces of room provisioning that `@wolffm/rooms-server` and `@wolffm/rooms-protocol` (both at
0.45.73) do not have, and neither does watchparty's own server: a password on a room, and minting ids for rooms
and their tables. Watchparty has no password rooms today, so nothing on your side carries either.

Cardtable moved both out of its lobby into one generic file on 2026-11-10:
`apps/server/src/room/provisioning.ts` (MIT `platform` layer, 58 lines, no Magic content, no lobby state). It is
ready to be the package's code as it stands.

## What cardtable has (`apps/server/src/room/provisioning.ts`)

```ts
export interface Secret {
  salt: string; // hex, 16 random bytes
  hash: string; // hex, 32 bytes of scrypt
}

/** scrypt at node's defaults (N=2^14, r=8, p=1) of the NFC-normalised password, with a per-room random salt. */
export function makeSecret(password: string): Secret;

/** Compares with `timingSafeEqual`; false on a length mismatch. */
export function passwordMatches(secret: Secret, password: string): boolean;

/** `r-` plus 12 hex characters (48 random bits). The caller re-rolls on a collision with a live room. */
export function mintRoomId(): string;

/** `t-` plus 8 hex characters, re-rolled until it is not in `existing`. */
export function mintTableId(existing: readonly string[]): string;
```

How cardtable uses them, for the shape of the API:

- The password is never stored in plaintext and never leaves the server. A room's view says only `locked: boolean`.
  The lobby keeps a `Secret` per locked room beside the room, and the saved-room codec
  (`apps/server/src/room/lobby-codec.ts`) writes it as `{ salt, hash }` and refuses a malformed one on load.
- `create` calls `makeSecret` once. `join` by a non-member calls `passwordMatches`, and the HTTP route rate-limits
  those attempts per caller. Hashing is synchronous because the lobby is a synchronous in-memory structure.
- `r-`/`t-` prefixes keep a room id apart from a draft id or a match id. They match the wire's `ROOM_ID_RE`
  (`packages/shared/src/room-feed.ts`).

## The ask

1. Export `Secret`, `makeSecret` and `passwordMatches` from `@wolffm/rooms-server` (Node only: they use
   `node:crypto`). Keep the parameters above: the stored format is on disk in cardtable's saved rooms, so a change
   to the salt length, key length or scrypt cost would lock every existing locked room.
2. Export `mintRoomId` and `mintTableId` from the same package. If watchparty's own ids use another alphabet,
   take a prefix argument (`mintId('r', 6)`) rather than change cardtable's format.
3. Optionally, a room password in watchparty's own create and join, built on the same two functions, so the rule
   is one rule.

## What cardtable deletes once it ships

- `apps/server/src/room/provisioning.ts`, the whole file (58 lines), and its row in
  `scripts/layers/layers.json`;
- the local `Secret` type import in `apps/server/src/room/lobby.ts` and `apps/server/src/room/lobby-codec.ts`,
  which then import it from `@wolffm/rooms-server`;
- the seven call sites in `room/lobby.ts` (`makeSecret`, `passwordMatches`, `mintRoomId` ×2 in `create`,
  `mintTableId` ×3) keep their names and change only their import.

## Done when

Both are published in a `@hadoku/rooms-server` release cardtable's `@wolffm/rooms-server` alias can pin, and
cardtable's `provisioning.ts` is gone.
