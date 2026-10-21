/**
 * Match stats: what is reported when Forge says a room's match is over.
 * `index.ts` builds one and hands `gameOver` to play.
 *
 * The start half of a report is read at the end, from where each of its facts
 * already lives — the room that started the match and the match's own spec
 * (`deps.startOf`, the table routes' `matchStart`), and each player's key from
 * the key book — never from a copy taken at the start. Both survive a restart
 * (the room on disk, the spec in the JVM's record), so a match taken back by a
 * later process is recorded like any other.
 *
 * A match no room started — the deck builder's AI game, the dev tooling — has
 * no players to report, and is skipped with a log line.
 */

import type { Match } from '../play/match.js';
import type { SeriesEnd } from '../room/lobby.js';
import { matchFacts } from './facts.js';
import type { KeyBook } from './keys.js';
import { buildMatchReport, buildSeriesReport, type MatchStart, type SeatStart, type SeriesSeatStart } from './report.js';
import type { StatsReporter } from './reporter.js';

export { createKeyBook, type KeyBook } from './keys.js';
export { createStatsReporter, type RecordFn, type StatsReporter } from './reporter.js';
export { summarizeDeck, type DeckSummary, type MatchStart } from './report.js';

/** A seat as the room knows it: Forge's AI, or the member holding it (whose key the book holds). */
export type SeatStartInput = Omit<SeatStart, 'kind' | 'userKey'> & { ai: boolean; memberId: string | null };

export type MatchStartInput = Omit<MatchStart, 'seats'> & { seats: SeatStartInput[] };

export interface MatchStats {
	gameOver(match: Match): void;
	/** A room's series ended (`Lobby`'s `SeriesEnd`): recorded as one report of its own. */
	seriesEnd(end: SeriesEnd): void;
}

export function createMatchStats(deps: {
	keys: KeyBook;
	reporter: StatsReporter;
	/** The match's start as the room that started it sees it, or null for a match no room started. */
	startOf(match: Match): MatchStartInput | null;
	log(entry: Record<string, unknown>): void;
	now?: () => number;
}): MatchStats {
	const now = deps.now ?? Date.now;
	/** Forge's AI, a member with a key the book holds (a user), or one without (a guest). */
	const kindOf = (ai: boolean, memberId: string | null): Pick<SeatStart, 'kind' | 'userKey'> => {
		if (ai) return { kind: 'bot' };
		const userKey = memberId === null ? null : deps.keys.keyOf(memberId);
		return userKey === null ? { kind: 'guest' } : { kind: 'user', userKey };
	};
	return {
		gameOver(match) {
			try {
				const input = deps.startOf(match);
				if (input === null) {
					deps.log({ evt: 'stats-skipped', matchId: match.id, reason: 'no room started this match' });
					return;
				}
				const seats = input.seats.map(({ ai, memberId, ...rest }): SeatStart => ({ ...rest, ...kindOf(ai, memberId) }));
				const start: MatchStart = { ...input, seats };
				const facts = matchFacts(match);
				const report = facts === null ? null : buildMatchReport(facts, start);
				if (report === null) {
					deps.log({ evt: 'stats-skipped', matchId: match.id, reason: 'the result could not be read' });
					return;
				}
				void deps.reporter.report(report);
			} catch (err) {
				deps.log({ evt: 'stats-skipped', matchId: match.id, reason: (err as Error).message });
			}
		},
		seriesEnd(end) {
			const seat = (s: SeriesEnd['seats'][number]): SeriesSeatStart =>
				s === null ? { ...kindOf(true, null), displayName: 'Forge AI' } : { ...kindOf(false, s.memberId), displayName: s.name };
			const report = buildSeriesReport({
				roomId: end.roomId,
				mode: end.mode,
				bestOf: end.bestOf,
				seats: [seat(end.seats[0]), seat(end.seats[1])],
				wins: end.wins,
				games: end.games.map((g) => g.matchId),
				winner: end.winner,
				endedAt: now(),
			});
			if (report === null) {
				deps.log({ evt: 'stats-skipped', roomId: end.roomId, reason: 'the series has no game to key it' });
				return;
			}
			void deps.reporter.report(report);
		},
	};
}
