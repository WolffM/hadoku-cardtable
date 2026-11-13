/**
 * Magic's part of a room's view: what `room/lobby.ts`'s `viewOf` spreads over the platform's own
 * fields for a room Magic plays. The lobby asks each game type for its part (`Lobby.useGameView`)
 * and wires this one for Magic's own two types; a room of any other type carries none of it.
 */

import type { MagicRoomGame } from '@hadoku/shared';

import type { RoomRecord } from './lobby-codec.ts';
import { podViewOf, roomAi, usesPod, type AiPersona, type GameHooks } from './pods.ts';

/** Magic's `game`, which `@hadoku/shared`'s `MagicRoomGameSchema` reads; this server always sends `ai`. */
export type MagicViewGame = MagicRoomGame & { ai: AiPersona };

/** Every key Magic's part adds to a room's view. */
export interface MagicViewPart {
	game: MagicViewGame;
	/** A Challenge room (`RoomRecord.historical`): born whole, its field the event's. */
	historical?: true;
	/** A Challenge's entrant → its real player's library deck id (`RoomRecord.aiDeckAssignments`). */
	aiDeckAssignments?: Record<string, string>;
	/** A Challenge's open seat → the list its player plays (`RoomRecord.seatDecks`). */
	seatDecks?: Record<string, string>;
	/**
	 * `game.ai`, restated for a UI built before 2026-11-13, which reads only this. Drop it in the
	 * first release after the one that ships `roomAiOf` (the release after v0.68.0's successor):
	 * an open tab is never reloaded on a bundle change, so the copy stays until prod's UI reads `game.ai`.
	 */
	ai: AiPersona;
}

/** Magic's part of a room's view (`MagicViewPart`). */
export function magicViewPart(room: RoomRecord, checks: GameHooks): MagicViewPart {
	const ai = roomAi(room);
	return {
		game: {
			format: room.game.format,
			mode: room.game.mode,
			modeOptions: room.game.modeOptions === null ? null : { ...room.game.modeOptions },
			clientMode: room.game.clientMode,
			draftStartedAt: room.game.draftStartedAt === null ? null : new Date(room.game.draftStartedAt).toISOString(),
			pod: usesPod(room) ? podViewOf(room, checks) : null,
			...(room.game.scenario === undefined ? {} : { scenario: room.game.scenario }),
			ai,
		},
		...(room.game.historical === true ? { historical: true } : {}),
		// Public like the seats' own `deckId`s, and what the lock deals each AI entrant (`GameHooks.currentTournamentDeck`).
		...(room.game.aiDeckAssignments === undefined ? {} : { aiDeckAssignments: { ...room.game.aiDeckAssignments } }),
		// Which list each open seat plays: the room draws it in place of a deck picker.
		...(room.game.seatDecks === undefined ? {} : { seatDecks: { ...room.game.seatDecks } }),
		ai,
	};
}
