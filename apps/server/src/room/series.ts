/**
 * A table's series: how long it runs, and how one game moves it on. Pure — the
 * lobby (`lobby.ts`) stores the record and decides when a series has ended; this
 * file only states the rules.
 *
 * `docs/planning/constructed-modes-plan.md`, "Match length": every Constructed
 * series but a Gauntlet starts as Bo1, and a Rematch converts it in place — the
 * finished game stays as game 1 and the series goes to sideboarding at 1-0
 * (`convertToBo3`). A Gauntlet is Bo3 with no sideboarding: between its games
 * the table is `between`, never `sideboarding`. A draft pod is Bo3 with
 * sideboarding. Which of the three a room plays is `seriesFormatOf` alone, so
 * a room that sets its `mode` to `gauntlet` gets the Gauntlet's series with no
 * other call.
 */

import type { ConstructedMode, SeriesPhase } from '@hadoku/shared';

interface SeriesFormat {
	/** Games a NEW series is best of. */
	length: 1 | 3;
	/** Whether the step between two games of one series is sideboarding. */
	sideboarding: boolean;
}

/**
 * What `seriesFormatOf` reads: a room's game type and, for a Constructed
 * room, its mode and its `tournament` flag
 * (`docs/planning/tournament-mode-plan.md`'s Design: *"Bo3 for
 * classic/all-random means same deck. Bo3 for gauntlet is already built
 * in"* — a tournament table plays the pod's own format for Classic/All
 * Random, and the SAME format a Gauntlet always has otherwise). `tournament`
 * is a `constructed-1v1` question only: a `draft` room ignores it, since it
 * already plays the pod's format regardless.
 */
export interface SeriesRoom {
	/** `GameType` (`@hadoku/shared`); any other reads as Constructed. */
	gameType: string;
	mode?: ConstructedMode | null;
	tournament?: boolean;
}

const CONSTRUCTED: SeriesFormat = { length: 1, sideboarding: true };
const GAUNTLET: SeriesFormat = { length: 3, sideboarding: false };
const POD: SeriesFormat = { length: 3, sideboarding: true };

export function seriesFormatOf(room: SeriesRoom): SeriesFormat {
	if (room.gameType === 'draft') return POD;
	if (room.mode === 'gauntlet') return GAUNTLET;
	return room.tournament === true ? POD : CONSTRUCTED;
}

/** The mode a game or series is reported under: a pod's is `draft`; a Constructed room with no mode stored is Classic. */
export function statsModeOf(room: SeriesRoom): ConstructedMode | 'draft' {
	return room.gameType === 'draft' ? 'draft' : (room.mode ?? 'classic');
}

/**
 * One game of a series — `RoomTableGame` (`@hadoku/shared`), plus the server's own `ms`: how long it
 * lasted, from its match's start to its result (absent for a game recorded before games were timed).
 * A pod's standings rank by the median (`@hadoku/draft`'s fifth tiebreak); the wire carries none of it.
 */
export interface SeriesGame {
	matchId: string;
	winner: 0 | 1 | null;
	ms?: number;
}

/**
 * A table's series. `length`/`wins`/`games`/`phase` are the wire's
 * `RoomTableSeries`; the rest is the server's own. `played` is who sat where
 * when the series began — a member id, or `null` for Forge's AI — so a Rematch
 * can tell the same players from new ones, and the result can name them.
 * `mode` is the mode it was played in (`statsModeOf`), which the room may
 * change once it is over. `settled` is true once the series' result has been recorded; nothing
 * converts or records a settled series again.
 */
export interface SeriesRecord {
	length: 1 | 3;
	wins: [number, number];
	games: SeriesGame[];
	phase: SeriesPhase;
	played: [string | null, string | null];
	mode: ConstructedMode | 'draft';
	settled: boolean;
	/** When the game under way started (ms since epoch), timing it for `SeriesGame.ms`; null between games. */
	gameStartedAt?: number | null;
}

/** A room's next series, sized by its format, played by `played`. */
export function newSeries(room: SeriesRoom, played: readonly (string | null)[], phase: SeriesPhase): SeriesRecord {
	return {
		length: seriesFormatOf(room).length,
		wins: [0, 0],
		games: [],
		phase,
		played: [played[0] ?? null, played[1] ?? null],
		mode: statsModeOf(room),
		settled: false,
	};
}

/**
 * A game ended. It is appended and its winner's `wins` counts it; the series is
 * `done` once a seat holds a majority of `length` or every game has been played
 * (a game with no attributable winner must never strand a series), and between
 * games otherwise — `sideboarding` or `between`, by the format.
 */
export function recordGame<S extends SeriesRecord>(series: S, format: SeriesFormat, game: SeriesGame): S {
	const wins: [number, number] = [...series.wins];
	if (game.winner !== null) wins[game.winner] += 1;
	const games = [...series.games, { ...game }];
	const need = series.length === 3 ? 2 : 1;
	const over = wins[0] >= need || wins[1] >= need || games.length >= series.length;
	return { ...series, wins, games, phase: over ? 'done' : format.sideboarding ? 'sideboarding' : 'between' };
}

/** A Rematch of a finished, unrecorded Bo1: the same series as Bo3, its game kept as game 1, going to sideboarding. `null` for any other series. */
export function convertToBo3<S extends SeriesRecord>(series: S): S | null {
	if (series.phase !== 'done' || series.length !== 1 || series.settled) return null;
	return { ...series, length: 3, phase: 'sideboarding' };
}

/** The seat holding a majority of `length`, or `null` while there is none. */
export function seriesWinner(series: Pick<SeriesRecord, 'length' | 'wins'>): 0 | 1 | null {
	const need = series.length === 3 ? 2 : 1;
	if (series.wins[0] >= need) return 0;
	return series.wins[1] >= need ? 1 : null;
}
