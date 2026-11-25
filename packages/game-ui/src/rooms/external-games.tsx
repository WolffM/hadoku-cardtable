/*
 * The client half of cardtable's external-game room types — configuration, not code, per the
 * operator's 2026-11-16 ruling ("no bomberman code in cardtable"). Registers the room UI's `game`
 * slot for each entry in `./external-games-config.ts`'s `EXTERNAL_GAMES`: a `BundleSlot` loading
 * the game's own bundle over the relay.
 *
 * Registered at module scope, once, the moment this module is imported, as Magic's two types are
 * from `screens/magic-room-ui.tsx`, and unconditionally: a room of one of these types already
 * exists the moment someone follows its invite link, whatever today's deployment flag says, and
 * the room screen still needs to know how to draw it. What may be CREATED is the server's answer
 * to `GET /api/external-games` (`apps/server/src/plugins/external-games.ts`: registered, and
 * playable at the caller's tier), behind `games/magic/ui/src/rooms/RoomList.tsx`'s own
 * Experimental-features check — not this file, which only ever draws a room already made.
 *
 * No `GameTypeSpec` is registered here: a game's seats and hold are the server's to read from the
 * game's own manifest, and nothing on this side reads them.
 */

import { BundleSlot } from './BundleSlot.tsx';
import { registerGameRoomUi } from './game-setup.ts';
import { EXTERNAL_GAMES } from './external-games-config.ts';

export { EXTERNAL_GAMES, type ExternalGameConfig } from './external-games-config.ts';

for (const game of EXTERNAL_GAMES) {
  registerGameRoomUi(game.id, {
    game: (p) => <BundleSlot src={game.embedSrc} view={p.view} me={p.me} relay={game.runtime === 'relay'} />,
  });
}
