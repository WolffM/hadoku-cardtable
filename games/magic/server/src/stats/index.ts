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
 *
 * The same moment stamps "last played" (`played`): each seat a person held with
 * a deck id (`draft:<podId>`, `built:<uuid>`, a library deck's id) sets that
 * deck's `lastPlayedAt` in the person's own document in the per-person store
 * (`users/`), bot games included. It is our own record, written here, so the
 * Library sorts by it without asking anyone else (operator, 2026-11-23).
 */

import type { Match } from '../play/match.js';
import type { SeriesEnd } from '../room/pods.js';
import { matchFacts } from './facts.js';
import type { KeyBook } from './keys.js';
import { buildMatchReport, buildSeriesReport, type MatchStart, type SeatStart, type SeriesSeatStart } from './report.js';
import type { StatsReporter } from '@hadoku/game-server/stats/reporter';
import type { MagicUserStore } from '../users/index.js';

export { createKeyBook, type KeyBook } from './keys.js';
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
	/** Where "last played" is stamped, and who holds a room member's seat (their registry userId). Absent: nothing is stamped. */
	played?: {
		users: Pick<MagicUserStore, 'update'>;
		userOf(roomId: string, memberId: string): string | null;
	};
}): MatchStats {
	const now = deps.now ?? Date.now;
	/** Each person's seat with a deck id: that deck was played now. Never in the way of the report. */
	const stampPlayed = (match: Match, input: MatchStartInput): void => {
		const played = deps.played;
		if (played === undefined || input.roomId === undefined) return;
		const at = now();
		for (const seat of input.seats) {
			const deckId = seat.deck?.id;
			if (seat.ai || seat.memberId === null || deckId === undefined) continue;
			const userId = played.userOf(input.roomId, seat.memberId);
			if (userId === null) continue;
			played.users
				.update(userId, (doc) => {
					doc.decks[deckId] = { lastPlayedAt: Math.max(at, doc.decks[deckId]?.lastPlayedAt ?? 0) };
				})
				.catch((err: unknown) => deps.log({ evt: 'last-played-failed', matchId: match.id, deckId, reason: (err as Error).message }));
		}
	};
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
				stampPlayed(match, input);
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
