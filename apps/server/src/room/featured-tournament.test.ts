import { describe, expect, it } from 'vitest';

import type { Tournament } from '@hadoku/shared';

import { FEATURE_MS, featuredTournament, qualifies } from './featured-tournament.ts';

const DAY = 24 * 60 * 60_000;

/** A finished pod of `size` players, `people` of them people, ending on `day`. */
function pod(id: string, day: number, size: number, people = 2, closed = false): Tournament {
	const ids = Array.from({ length: size }, (_, i) => (i < people ? `${id}-p${String(i)}` : `ai:${String(i)}`));
	return {
		id,
		name: id,
		startedAt: day * DAY - 3_600_000,
		endedAt: day * DAY,
		closed,
		rounds: 3,
		names: {},
		users: Object.fromEntries(ids.slice(0, people).map((p) => [p, `uid-${p}`])),
		standings: ids.map((p, i) => ({ id: p, matchPoints: 0, opponentMatchWinPct: 0, gameWinPct: 0, opponentGameWinPct: 0, medianGameMs: null, rank: i + 1, decidedBy: null })),
		results: [],
	};
}

const at = (list: Tournament[], day: number): string | null => featuredTournament(list, day * DAY)?.id ?? null;

describe('qualifies', () => {
	it('takes a finished pod with a top three and two people', () => {
		expect(qualifies(pod('a', 0, 3, 2))).toBe(true);
	});
	it('refuses one closed early, a two-player pod, and a pod one person played against the AI', () => {
		expect(qualifies(pod('a', 0, 8, 2, true))).toBe(false);
		expect(qualifies(pod('a', 0, 2, 2))).toBe(false);
		expect(qualifies(pod('a', 0, 8, 1))).toBe(false);
	});
});

describe('featuredTournament', () => {
	it('is nothing with nothing that qualifies', () => {
		expect(at([], 1)).toBeNull();
		expect(at([pod('solo', 0, 8, 1), pod('duel', 0, 2)], 1)).toBeNull();
	});

	it('lands when it ends, holds for seven days from its end, then goes', () => {
		const list = [pod('a', 10, 4)];
		expect(at(list, 9)).toBeNull();
		expect(at(list, 10)).toBe('a');
		expect(featuredTournament(list, 10 * DAY + FEATURE_MS - 1)?.id).toBe('a');
		expect(featuredTournament(list, 10 * DAY + FEATURE_MS)).toBeNull();
	});

	it('an 8-player major keeps its full week against smaller pods, then hands the seat to the newest of them', () => {
		const list = [pod('major', 0, 8), pod('small-1', 2, 4), pod('small-2', 5, 6), pod('equal', 6, 8)];
		for (const day of [0, 2, 5, 6, 6.99]) expect(at(list, day)).toBe('major');
		// Its week is up on day 7: the newest waiter (day 6) has the rest of its own week.
		expect(at(list, 7)).toBe('equal');
		expect(at(list, 12.99)).toBe('equal');
		expect(at(list, 13)).toBeNull();
	});

	it('a waiter takes over only what is left of its own week, never more', () => {
		const list = [pod('major', 0, 8), pod('small', 1, 4)];
		expect(at(list, 7)).toBe('small');
		expect(at(list, 8)).toBeNull();
	});

	it('a pod with more players takes the seat at once, and starts its own week', () => {
		const list = [pod('small', 0, 4), pod('major', 3, 8)];
		expect(at(list, 2)).toBe('small');
		expect(at(list, 3)).toBe('major');
		expect(at(list, 9.99)).toBe('major');
		// The pod it displaced does not come back: its week is long up.
		expect(at(list, 10)).toBeNull();
	});

	it('a pod ending after the seat came free takes it however small it is', () => {
		const list = [pod('major', 0, 8), pod('later', 9, 3)];
		expect(at(list, 8)).toBeNull();
		expect(at(list, 9)).toBe('later');
	});

	it('hands on through several weeks in one call, whatever order the list is in', () => {
		const list = [pod('c', 15, 3), pod('a', 0, 8), pod('b', 6, 4)];
		expect(at(list, 7)).toBe('b');
		expect(at(list, 15)).toBe('c');
		expect(at(list, 22)).toBeNull();
	});
});
