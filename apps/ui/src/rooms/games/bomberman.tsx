/*
 * Bomberman's own room UI — a composition root naming a game, not a game of its own: it imports
 * `BundleSlot` (platform, shared with watchparty's bundle host) and names bomberman's one fact
 * the platform cannot know, its bundle's own path. No `setup`: a bomberman room has no
 * pre-start configuration to show above the seats (no deck, no format), and `BundleSlot` draws
 * its own players from `view.members` once it mounts — there is nothing else to seat here.
 *
 * Registered at module scope, once, the moment this module is imported, as Magic's two types are
 * from `screens/magic-room-ui.tsx`. Importing this module is what makes bomberman a choosable room
 * type's UI exist; nothing else here has a side effect.
 */

import { BundleSlot } from '../BundleSlot.tsx';
import { registerGameRoomUi } from '../game-setup.ts';

/** Hadoku-bomberman's own embed, at the path watchparty loads it from too; it is never copied here. */
export const BOMBERMAN_EMBED_SRC = '/bomberman/embed/bomberman-embed.js';

registerGameRoomUi('bomberman', {
  game: (p) => <BundleSlot src={BOMBERMAN_EMBED_SRC} view={p.view} me={p.me} />,
});
