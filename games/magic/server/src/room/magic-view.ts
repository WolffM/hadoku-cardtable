/**
 * Magic's part of a room's view: what `room/lobby.ts`'s `viewOf` spreads over the platform's own
 * fields for a room Magic plays. The lobby asks each game type for its part (`Lobby.useGameView`)
 * and wires this one for Magic's own two types; a room of any other type carries none of it.
 */

import { isMagicGameType, type MagicRoomGame, type RoomView as PublicRoomView } from '@hadoku/shared';

import type { RoomRecord } from './lobby-codec.ts';
import { podViewOf, roomAi, usesPod, type AiPersona, type GameHooks } from './pods.ts';

/** The public view's fields only a room Magic plays has: a hosted room of another game has none of them. */
export type MagicRoomKeys = 'tables' | 'settings' | 'locks' | 'matchId';

/** Those fields, as a room Magic plays always has them. */
export type MagicRoomFields = Pick<PublicRoomView, MagicRoomKeys>;

/**
 * The room as Magic's, or undefined for no room or a room of a game Magic does not play: the one
 * door every Magic reader of an any-room view goes through. Magic's view part (`lobby.ts`'s
 * `magicRoomPart`) gives every room Magic plays these fields, and only those rooms.
 */
export function magicView<V extends { gameType: string }>(view: V | undefined): (V & MagicRoomFields) | undefined {
	return view !== undefined && isMagicGameType(view.gameType) ? (view as V & MagicRoomFields) : undefined;
}

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
