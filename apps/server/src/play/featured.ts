/**
 * The front page's featured match: the live game where the most is happening
 * (`docs/planning/front-page-and-replay-plan.md`, R3). Every match is featurable
 * (the operator, 2026-10-26: "feature everything by default"); a testing room's
 * never is, since it is not offered to everyone.
 *
 * - **Eligible:** dealt and running (`Match.live()` is not null) and the table
 *   changed within {@link FEATURED_IDLE_MS}. A game waiting on a player who has
 *   walked away drops out on its own.
 * - **Score:** the seconds of the last two minutes in which the table changed
 *   (`Match.activity`) carry it; a game past turn 2, close life totals and two
 *   people rather than a person and an AI each add a little.
 * - **Kept:** the current pick stays until it ends or goes idle, however good a
 *   newcomer looks. A front page that cuts away mid-combat is worse than one
 *   showing a slightly duller game.
 *
 * Re-picked on every live change and on a timer, because going idle is the
 * absence of an event. A change of pick is announced through `changed`, which
 * `index.ts` turns into the room feed's list ping.
 */

import type { TableGameLive } from '@hadoku/shared';

import type { Match } from './match.js';

/** A match that waited this long without its table changing is not featured. */
export const FEATURED_IDLE_MS = 60_000;

/** How often the pick is re-checked between live changes, so an idle game is let go. */
export const FEATURED_REFRESH_MS = 15_000;

export interface FeaturedCandidate {
	matchId: string;
	roomId: string;
	/** Human seats. */
	humans: number;
	live: TableGameLive;
	activity: { lastAt: number | null; recent: number };
}

export interface FeaturedPick {
	matchId: string;
	roomId: string;
}

/** Null when the match is not eligible; otherwise higher is busier. */
export function featuredScore(c: FeaturedCandidate, now: number): number | null {
	if (c.activity.lastAt === null || now - c.activity.lastAt > FEATURED_IDLE_MS) return null;
	const [a, b] = c.live.life;
	const close = a === null || b === null ? 0 : Math.max(0, 10 - Math.abs(a - b));
	return c.activity.recent + (c.live.turn >= 3 ? 10 : 0) + close + (c.humans >= 2 ? 15 : 0);
}

export function pickFeatured(candidates: readonly FeaturedCandidate[], now: number, current: FeaturedPick | null): FeaturedPick | null {
	const kept = current === null ? undefined : candidates.find((c) => c.matchId === current.matchId);
	if (kept !== undefined && featuredScore(kept, now) !== null) return { matchId: kept.matchId, roomId: kept.roomId };
	let best: FeaturedCandidate | null = null;
	let bestScore = -1;
	for (const c of candidates) {
		const score = featuredScore(c, now);
		if (score !== null && score > bestScore) {
			best = c;
			bestScore = score;
		}
	}
	return best === null ? null : { matchId: best.matchId, roomId: best.roomId };
}

/** The candidates among the server's matches: live ones in a room that is not a testing room. */
export function featuredCandidates(matches: readonly Match[], roomOf: (matchId: string) => { id: string; testing?: boolean } | undefined, now: number): FeaturedCandidate[] {
	const out: FeaturedCandidate[] = [];
	for (const match of matches) {
		const live = match.live();
		const room = roomOf(match.id);
		if (live === null || room === undefined || room.testing === true) continue;
		out.push({ matchId: match.id, roomId: room.id, humans: match.seats.filter((s) => !s.ai).length, live, activity: match.activity(now) });
	}
	return out;
}

export interface Featured {
	current(): FeaturedPick | null;
	/** Re-pick now; announces a change. */
	refresh(): void;
	stop(): void;
}

export interface FeaturedDeps {
	candidates(now: number): FeaturedCandidate[];
	changed(previous: FeaturedPick | null, next: FeaturedPick | null): void;
	now?(): number;
	refreshMs?: number;
}

export function createFeatured(deps: FeaturedDeps): Featured {
	const now = deps.now ?? Date.now;
	let current: FeaturedPick | null = null;
	const refresh = (): void => {
		const at = now();
		const next = pickFeatured(deps.candidates(at), at, current);
		if (next?.matchId === current?.matchId && next?.roomId === current?.roomId) return;
		const previous = current;
		current = next;
		deps.changed(previous, next);
	};
	const timer = setInterval(refresh, deps.refreshMs ?? FEATURED_REFRESH_MS);
	timer.unref();
	return {
		current: () => current,
		refresh,
		stop: () => clearInterval(timer),
	};
}
