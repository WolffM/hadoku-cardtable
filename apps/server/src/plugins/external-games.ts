/**
 * External games cardtable may host as a room type — entirely as CONFIGURATION, per the
 * operator's 2026-11-16 ruling: "no bomberman code in cardtable." None of an external game's own
 * code runs here or anywhere else in this repo: its match plays on cardtable's relay runtime
 * (`packages/game-server/src/play/runtimes/relay.ts`), and its UI is one `BundleSlot` loading the
 * game's own same-origin bundle (`packages/game-ui/src/rooms/external-games.tsx` registers that
 * half).
 *
 * The config itself — id, label, seat range, runtime, embed URL, seat-rejoin grace — is the ONE
 * `EXTERNAL_GAMES` array in `packages/game-ui/src/rooms/external-games-config.ts` (pure data, no
 * React, no import beyond its own types). Both this file (the site, which may import anything)
 * and the client (`packages/game-ui/src/rooms/external-games.tsx`, platform) read that same
 * array — no duplicate literal on either side any more.
 *
 * Gated on `CARDTABLE_EXPERIMENTAL_GAMES=1`, read here rather than `config.ts` because the whole
 * feature is itself optional configuration, not a platform setting every deployment reads: unset
 * (or anything else), nothing below registers, and cardtable plays no external game at all —
 * creating or joining one then refuses the same way any unregistered game type always has
 * (`isRegisteredGameType`). Deleting one entry from `EXTERNAL_GAMES` removes that one external
 * game from cardtable; deleting the whole array (or leaving the flag unset) removes every one,
 * bomberman included.
 */
import { registerGameType, type GameTypeSpec } from '@hadoku/shared';
import type { CardtablePlugin } from '@hadoku/magic-server/plugins/state';
import { EXTERNAL_GAMES, type ExternalGameConfig } from '@hadoku/game-ui/rooms/external-games-config.ts';

export { EXTERNAL_GAMES, type ExternalGameConfig } from '@hadoku/game-ui/rooms/external-games-config.ts';

function specOf(game: ExternalGameConfig): GameTypeSpec {
	return {
		id: game.id,
		runtime: game.runtime,
		seatRejoinGraceMs: game.seatRejoinGraceMs,
		seats: game.seats,
		// No ready step, one game, empty seats stay empty — true of every external game this
		// server merely relays, not any one of them in particular.
		ready: false,
		series: { length: 1 },
		canStart: (seated) => (seated >= game.seats.min ? { ok: true } : { ok: false, reason: 'not-enough-players' }),
		// Nothing of an external game's own is kept under a saved room's `game` key.
		gameCodec: { storedKeys: [], decode: () => ({}) },
	};
}

export const externalGamesPlugin: CardtablePlugin = {
	name: 'external-games',
	phase: 'config',
	setup() {
		if (process.env.CARDTABLE_EXPERIMENTAL_GAMES !== '1') return;
		for (const game of EXTERNAL_GAMES) registerGameType(specOf(game));
	},
};
