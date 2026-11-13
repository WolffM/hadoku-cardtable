/**
 * Bomberman as a cardtable room type: the one `GameTypeSpec` the server (`apps/server/src/plugins/bomberman.ts`)
 * and the room UI (`apps/ui/src/rooms/games/bomberman.tsx`) both register, so the two never disagree
 * about it. Data only: it imports a type and nothing else, so each side registers it into its own
 * registry. Nothing of bomberman's own code lives here; its bundle is hadoku-bomberman's.
 *
 * - `seats: {min:2, max:10}` — `hadoku-bomberman/game/src/consts.rs:54` (`MAX_PLAYERS = 10`,
 *   restated as `MAX_GAME_PLAYERS` in `packages/protocol/src/wire.ts:150`) and
 *   `game/src/board.rs:136` (`maps_for_players`'s `n.clamp(2, MAX_PLAYERS)` — no 1-player map).
 * - `seats.max > 2` matters beyond honesty: `room/pods.ts`'s `usesPod` routes any such type through
 *   `podSeats`/`game.pod`, not Magic's 2-seat `tables[]` (which `packages/platform-wire/src/tables.ts:38`
 *   hard-caps at 2 players) — proven generically in `games/magic/server/src/room/game-type-spec.test.ts`.
 * - `runtime: 'relay'`: the match runs on cardtable's relay. The bundle plays over `ctx.channel`
 *   (hadoku-bomberman `docs/NETCODE.md`, "Over a host's channel"), its leader hosts, and its
 *   `{ t: 'over', winners }` ends the match.
 * - `seatRejoinGraceMs: 120_000`: bomberman's own seat hold (`packages/game-server/src/config.ts`'s
 *   `seatHoldMs`, `BOMBERMAN_SEAT_HOLD_MS`, 120 000 ms by default), so a player who drops keeps
 *   their seat as long here as on bomberman's own server.
 * - `ready: false`, `series: {length:1}`, no `bots`: no ready step, one game, empty seats stay empty.
 * - `gameCodec.storedKeys: []`: nothing of bomberman's own is kept under a saved room's `game` key.
 */

import type { GameTypeSpec } from './game-type-spec.ts';

export const BOMBERMAN_GAME_TYPE = 'bomberman';

export const BOMBERMAN_GAME_TYPE_SPEC: GameTypeSpec = {
  id: BOMBERMAN_GAME_TYPE,
  runtime: 'relay',
  seatRejoinGraceMs: 120_000,
  seats: { min: 2, max: 10 },
  ready: false,
  series: { length: 1 },
  canStart: (seated) => (seated >= 2 ? { ok: true } : { ok: false, reason: 'not-enough-players' }),
  gameCodec: { storedKeys: [], decode: () => ({}) },
};
