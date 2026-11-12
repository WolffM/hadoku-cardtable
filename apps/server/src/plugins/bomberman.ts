/**
 * Bomberman as a cardtable room type: registers `@hadoku/shared`'s `BOMBERMAN_GAME_TYPE_SPEC` (whose
 * own doc has every value's source), the spec `room/lobby.ts` needs to open, join, auto-seat and
 * persist a bomberman room, with no change to the lobby itself. The room UI registers the same
 * spec (`apps/ui/src/rooms/games/bomberman.tsx`).
 *
 * The spec says `runtime: 'relay'`: a bomberman room's match is a `RelayMatch`, opened with the
 * room (`plugins/relay.ts`), and the bundle plays over `ctx.channel`. None of bomberman's own code
 * runs here.
 */

import { BOMBERMAN_GAME_TYPE_SPEC, registerGameType } from '@hadoku/shared';
import type { CardtablePlugin } from './state.js';

export { BOMBERMAN_GAME_TYPE } from '@hadoku/shared';

export const bombermanPlugin: CardtablePlugin = {
	name: 'bomberman',
	phase: 'config',
	setup() {
		registerGameType(BOMBERMAN_GAME_TYPE_SPEC);
	},
};
