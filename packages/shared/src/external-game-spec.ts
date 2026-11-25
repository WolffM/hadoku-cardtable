/**
 * An external game as a room type: what the host decided about it (its id, that it runs on the
 * relay, its tier floor) together with what the game says about itself in its `manifest.json`
 * (`@hadoku/platform-wire/external-game-manifest`: its seat range and seat hold). The host's half
 * never comes from the manifest, so a game cannot widen who may play it.
 *
 * The site builds every hosted external game's spec through this (`apps/server/src/plugins/external-games.ts`),
 * and a test that needs a relay room type builds one the same way rather than re-typing the fields.
 */
import type { ExternalGameManifest } from '@hadoku/platform-wire/external-game-manifest';

import type { GameTypeSpec } from './game-type-spec.ts';

/** The host's own half of an external game. */
export interface HostedGame {
	id: string;
	runtime: 'relay';
	minTier?: 'friend';
}

export function externalGameSpec(game: HostedGame, manifest: ExternalGameManifest): GameTypeSpec {
	return {
		id: game.id,
		runtime: game.runtime,
		seatRejoinGraceMs: manifest.seatRejoinGraceMs,
		...(game.minTier === undefined ? {} : { minTier: game.minTier }),
		seats: manifest.seats,
		// No ready step, one game, empty seats stay empty: true of every external game the host
		// merely relays, not any one of them in particular.
		ready: false,
		series: { length: 1 },
		canStart: (seated) => (seated >= manifest.seats.min ? { ok: true } : { ok: false, reason: 'not-enough-players' }),
		// Nothing of an external game's own is kept under a saved room's `game` key.
		gameCodec: { storedKeys: [], decode: () => ({}) },
	};
}
