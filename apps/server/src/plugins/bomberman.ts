/**
 * Bomberman as a cardtable room type: registers the `GameTypeSpec` `room/lobby.ts` needs to open,
 * join, auto-seat and persist a bomberman room, with no change to the lobby itself. Bomberman's
 * own match play never reaches this server — its bundle binds the cardtable room id as a
 * watchparty room key and plays entirely through watchparty's socket layer.
 *
 * - `seats: {min:2, max:10}` — `hadoku-bomberman/game/src/consts.rs:54` (`MAX_PLAYERS = 10`,
 *   restated as `MAX_GAME_PLAYERS` in `packages/protocol/src/wire.ts:150`) and
 *   `game/src/board.rs:136` (`maps_for_players`'s `n.clamp(2, MAX_PLAYERS)` — no 1-player map).
 * - `seats.max > 2` matters beyond honesty: `room/pods.ts`'s `usesPod` routes any such type through
 *   `podSeats`/`game.pod`, not Magic's 2-seat `tables[]` (which `packages/platform-wire/src/tables.ts:38`
 *   hard-caps at 2 players) — proven generically in `apps/server/src/room/game-type-spec.test.ts`.
 * - `ready: false`, `series: {length:1}`, no `bots`: no ready step, one game, empty seats stay empty.
 * - `gameCodec.storedKeys: []`: nothing of bomberman's own is kept under a saved room's `game` key.
 */

import { registerGameType } from '@hadoku/shared';
import type { CardtablePlugin } from './state.js';

export const BOMBERMAN_GAME_TYPE = 'bomberman';

export const bombermanPlugin: CardtablePlugin = {
	name: 'bomberman',
	phase: 'config',
	setup() {
		registerGameType({
			id: BOMBERMAN_GAME_TYPE,
			seats: { min: 2, max: 10 },
			ready: false,
			series: { length: 1 },
			canStart: (seated) => (seated >= 2 ? { ok: true } : { ok: false, reason: 'not-enough-players' }),
			gameCodec: { storedKeys: [], decode: () => ({}) },
		});
	},
};
