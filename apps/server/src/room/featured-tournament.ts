/*
 * The tournament the front page's wildcard opens on (`GET /api/tournaments/featured`): a finished
 * tournament's top three, for a week. Worked out from the stored records alone (`./tournaments.ts`),
 * every time it is asked, so nobody curates it, a restart forgets nothing, and a correction to the file
 * (`cli/tournaments.ts`) is what shows.
 *
 * The seat (the operator, 2026-11-08): *"once a tournament closes it should land on a front-page card.
 * if multiple tournaments close while one is still being displayed, do not allow a new one to supercede
 * the current displayed tournament unless it included more people … if a major with 8+ is currently
 * displaying. it should always be allowed to display the full 7 days until it relinquishes it's seat to
 * another smaller tournament"*:
 *
 *   - A tournament that qualifies takes an empty seat when it ends, and holds it for `FEATURE_MS` from
 *     its end.
 *   - One that ends while the seat is held takes it only with more players than the holder; otherwise
 *     it waits.
 *   - When the holder's week is up, the newest one still waiting takes the seat for what is left of its
 *     own week. A result is never shown more than a week after it ended.
 */

import type { Tournament } from '@hadoku/shared';

/** How long a result holds the seat after its last round. */
export const FEATURE_MS = 7 * 24 * 60 * 60_000;

/** The fewest players for a top three. */
const MIN_PLAYERS = 3;
/** The fewest people: a pod one person played against the AI is practice, not a tournament. */
const MIN_PEOPLE = 2;

const players = (t: Tournament): number => t.standings.length;

/**
 * Played to its last round (not closed early by its owner), with a top three, by at least two people.
 * A testing room's pod is never recorded at all (`lobby.ts`'s `#archive`).
 */
export function qualifies(t: Tournament): boolean {
	return !t.closed && players(t) >= MIN_PLAYERS && Object.keys(t.users ?? {}).length >= MIN_PEOPLE;
}

const until = (t: Tournament): number => t.endedAt + FEATURE_MS;

/** The tournament holding the seat at `now`, or `null` when nobody holds it. */
export function featuredTournament(list: readonly Tournament[], now: number): Tournament | null {
	let seat: Tournament | null = null;
	let waiting: Tournament[] = [];
	/** Every week that is up by `at` hands the seat on, to the newest waiter whose own week is not. */
	const expire = (at: number): void => {
		while (seat !== null && until(seat) <= at) {
			const end = until(seat);
			seat = waiting.findLast((w) => until(w) > end) ?? null;
			waiting = [];
		}
	};
	const ended = list.filter((t) => qualifies(t) && t.endedAt <= now).sort((a, b) => a.endedAt - b.endedAt);
	for (const t of ended) {
		expire(t.endedAt);
		if (seat === null || players(t) > players(seat)) seat = t;
		else waiting.push(t);
	}
	expire(now);
	return seat;
}
