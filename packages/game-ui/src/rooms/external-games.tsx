/*
 * The client half of cardtable's external-game room types — configuration, not code, per the
 * operator's 2026-11-16 ruling ("no bomberman code in cardtable"). Registers a `GameTypeSpec`
 * (`BundleSlot` reads its `runtime: 'relay'` to hand the bundle `ctx.channel`) and the room UI's
 * `game` slot for each entry in `./external-games-config.ts`'s `EXTERNAL_GAMES` — the generic
 * replacement for the old named `rooms/games/bomberman.tsx`, which registered exactly one of
 * these by hand.
 *
 * Registered at module scope, once, the moment this module is imported, as Magic's two types are
 * from `screens/magic-room-ui.tsx`, and unconditionally: a room of one of these types already
 * exists the moment someone follows its invite link, whatever today's deployment flag says, and
 * the room screen still needs to know how to draw it. What gates whether a NEW one of these may be
 * CREATED is `games/magic/ui/src/rooms/RoomList.tsx`'s own Experimental-features check (the same
 * one Challenge already uses) together with the server's own flag
 * (`apps/server/src/plugins/external-games.ts`'s `CARDTABLE_EXPERIMENTAL_GAMES`, which has the
 * full rationale) — not this file, which only ever draws a room already made.
 *
 * Reads the SAME config the server reads (`./external-games-config.ts`): one array, not two
 * hand-synced literals. Delete an entry there to remove that external game from BOTH sides —
 * this file never decides what may be created, only how an already-made one is drawn.
 */

// The platform-classified file directly, never `@hadoku/shared`'s own barrel (which the layer
// fence resolves as Magic, since most of that package's files are) — the same technique
// `./BundleSlot.tsx` already uses for this exact module (`game-type-spec.ts` is one of the few
// individually platform-listed files in `scripts/layers/layers.json`).
import { registerGameType, type GameTypeSpec } from '../../../../packages/shared/src/game-type-spec.ts';

import { BundleSlot } from './BundleSlot.tsx';
import { registerGameRoomUi } from './game-setup.ts';
import { EXTERNAL_GAMES } from './external-games-config.ts';

export { EXTERNAL_GAMES, type ExternalGameConfig } from './external-games-config.ts';

for (const game of EXTERNAL_GAMES) {
  const spec: GameTypeSpec = {
    id: game.id,
    runtime: game.runtime,
    seatRejoinGraceMs: game.seatRejoinGraceMs,
    seats: game.seats,
    ready: false,
    series: { length: 1 },
    canStart: (seated) => (seated >= game.seats.min ? { ok: true } : { ok: false, reason: 'not-enough-players' }),
    gameCodec: { storedKeys: [], decode: () => ({}) },
  };
  registerGameType(spec);
  registerGameRoomUi(game.id, {
    game: (p) => <BundleSlot src={game.embedSrc} view={p.view} me={p.me} />,
  });
}
