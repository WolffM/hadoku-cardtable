/**
 * Bomberman as a cardtable room type: registers `@hadoku/shared`'s `BOMBERMAN_GAME_TYPE_SPEC` (whose
 * own doc has every value's source). The lobby hosts a registered type Magic does not play on the
 * platform's plain room type (`hostedRoomType`, sized by this spec): no game part of its own, its
 * players in the game seats. The room UI registers the same spec (`apps/ui/src/rooms/games/bomberman.tsx`).
 *
 * The spec says `runtime: 'relay'`: a bomberman room's match is a `RelayMatch`, opened with the
 * room (`plugins/relay.ts`), and the bundle plays over `ctx.channel`. None of bomberman's own code
 * runs here.
 */

import { BOMBERMAN_GAME_TYPE_SPEC, registerGameType } from '@hadoku/shared';
import type { CardtablePlugin } from '@hadoku/magic-server/plugins/state';

export { BOMBERMAN_GAME_TYPE } from '@hadoku/shared';

export const bombermanPlugin: CardtablePlugin = {
	name: 'bomberman',
	phase: 'config',
	setup() {
		registerGameType(BOMBERMAN_GAME_TYPE_SPEC);
	},
};
