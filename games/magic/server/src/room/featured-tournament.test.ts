import { describe, expect, it } from 'vitest';

import type { Tournament } from '@hadoku/shared';

import { FEATURE_MS, featuredTournament, qualifies } from './featured-tournament.ts';

/** One seat's length: every time below is in seats, so the tests hold whatever `FEATURE_MS` is. */
const SEAT = FEATURE_MS;

/** A finished pod of `size` players, `people` of them people, ending at `seats` seat-lengths. */
function pod(id: string, seats: number, size: number, people = 2, closed = false): Tournament {
	const ids = Array.from({ length: size }, (_, i) => (i < people ? `${id}-p${String(i)}` : `ai:${String(i)}`));
	return {
		id,
		name: id,
		startedAt: seats * SEAT - 3_600_000,
		endedAt: seats * SEAT,
		closed,
		rounds: 3,
		names: {},
		users: Object.fromEntries(ids.slice(0, people).map((p) => [p, `uid-${p}`])),
		standings: ids.map((p, i) => ({ id: p, matchPoints: 0, opponentMatchWinPct: 0, gameWinPct: 0, opponentGameWinPct: 0, medianGameMs: null, rank: i + 1, decidedBy: null })),
		results: [],
	};
}

const at = (list: Tournament[], seats: number): string | null => featuredTournament(list, seats * SEAT)?.id ?? null;

describe('qualifies', () => {
	it('takes a finished pod with a top three and two people', () => {
		expect(qualifies(pod('a', 0, 3, 2))).toBe(true);
	});
	it('refuses one closed early, a two-player pod, and a pod one person played against the AI', () => {
		expect(qualifies(pod('a', 0, 8, 2, true))).toBe(false);
		expect(qualifies(pod('a', 0, 2, 2))).toBe(false);
		expect(qualifies(pod('a', 0, 8, 1))).toBe(false);
	});
	it('refuses a pod of bots alone, the draft bot or the tournament AI', () => {
		expect(qualifies(pod('a', 0, 8, 0))).toBe(false);
		const draftBot = pod('b', 0, 3, 1);
		draftBot.standings[0] = { ...draftBot.standings[0]!, id: 'ai' };
		expect(qualifies(draftBot)).toBe(false);
	});
});

describe('featuredTournament', () => {
	it('is a day long', () => {
		expect(FEATURE_MS).toBe(24 * 60 * 60_000);
	});

	it('is nothing with nothing that qualifies', () => {
		expect(at([], 1)).toBeNull();
		expect(at([pod('solo', 0, 8, 1), pod('bots', 0, 8, 0), pod('duel', 0, 2)], 0.5)).toBeNull();
	});

	it('lands when it ends, holds for one seat from its end, then goes', () => {
		const list = [pod('a', 10, 4)];
		expect(at(list, 9)).toBeNull();
		expect(at(list, 10)).toBe('a');
		expect(featuredTournament(list, 10 * SEAT + FEATURE_MS - 1)?.id).toBe('a');
		expect(featuredTournament(list, 10 * SEAT + FEATURE_MS)).toBeNull();
	});

	it('an 8-player major keeps its full seat against smaller pods, then hands it to the newest of them', () => {
		const list = [pod('major', 0, 8), pod('small-1', 0.2, 4), pod('small-2', 0.5, 6), pod('equal', 0.6, 8)];
		for (const t of [0, 0.2, 0.5, 0.6, 0.99]) expect(at(list, t)).toBe('major');
		// Its seat is up at 1: the newest waiter (0.6) has the rest of its own.
		expect(at(list, 1)).toBe('equal');
		expect(at(list, 1.59)).toBe('equal');
		expect(at(list, 1.6)).toBeNull();
	});

	it('a waiter takes over only what is left of its own seat, never more', () => {
		const list = [pod('major', 0, 8), pod('small', 0.5, 4)];
		expect(at(list, 1)).toBe('small');
		expect(at(list, 1.5)).toBeNull();
	});

	it('a pod with more players takes the seat at once, and starts its own', () => {
		const list = [pod('small', 0, 4), pod('major', 0.5, 8)];
		expect(at(list, 0.4)).toBe('small');
		expect(at(list, 0.5)).toBe('major');
		expect(at(list, 1.49)).toBe('major');
		// The pod it displaced does not come back: its time is long up.
		expect(at(list, 1.5)).toBeNull();
	});

	it('a pod ending after the seat came free takes it however small it is', () => {
		const list = [pod('major', 0, 8), pod('later', 2, 3)];
		expect(at(list, 1.5)).toBeNull();
		expect(at(list, 2)).toBe('later');
	});

	it('hands on through several seats in one call, whatever order the list is in', () => {
		const list = [pod('c', 3, 3), pod('a', 0, 8), pod('b', 0.5, 4)];
		expect(at(list, 1)).toBe('b');
		expect(at(list, 3)).toBe('c');
		expect(at(list, 4)).toBeNull();
	});
});
