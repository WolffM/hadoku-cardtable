/**
 * Match stats: what a room's match is captured as when it starts, and what is
 * reported when Forge says it is over. `index.ts` builds one and hands its two
 * halves to the table routes (`started`) and to play (`gameOver`).
 *
 * A match this never saw start — one started outside a room (the deck
 * builder's AI game, the dev tooling), or one taken back after a restart —
 * has no players' keys to report with, and is skipped with a log line.
 */

import type { Match } from '../play/match.js';
import { matchFacts } from './facts.js';
import type { KeyBook } from './keys.js';
import { buildMatchReport, type MatchStart, type SeatStart } from './report.js';
import type { StatsReporter } from './reporter.js';

export { createKeyBook, type KeyBook } from './keys.js';
export { createStatsReporter, type RecordFn, type StatsReporter } from './reporter.js';
export { summarizeDeck, type DeckSummary, type MatchStart } from './report.js';

/** A seat as the room knows it: a member (whose key the book holds), or Forge's AI. */
export type SeatStartInput = Omit<SeatStart, 'kind' | 'userKey'> & { memberId: string | null };

export type MatchStartInput = Omit<MatchStart, 'seats'> & { seats: SeatStartInput[] };

export interface MatchStats {
	started(matchId: string, start: MatchStartInput): void;
	gameOver(match: Match): void;
}

/** Matches started but not yet over. A match that fails never reaches `gameOver`, so this is bounded. */
const MAX_PENDING = 64;

export function createMatchStats(deps: { keys: KeyBook; reporter: StatsReporter; log(entry: Record<string, unknown>): void }): MatchStats {
	const pending = new Map<string, MatchStart>();
	return {
		started(matchId, start) {
			const seats = start.seats.map(({ memberId, ...rest }): SeatStart => {
				if (memberId === null) return { ...rest, kind: 'bot' };
				const userKey = deps.keys.keyOf(memberId);
				return userKey === null ? { ...rest, kind: 'guest' } : { ...rest, kind: 'user', userKey };
			});
			pending.set(matchId, { ...start, seats });
			if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value as string);
		},
		gameOver(match) {
			const start = pending.get(match.id);
			pending.delete(match.id);
			if (start === undefined) {
				deps.log({ evt: 'stats-skipped', matchId: match.id, reason: 'no start was captured for this match' });
				return;
			}
			try {
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
	};
}
