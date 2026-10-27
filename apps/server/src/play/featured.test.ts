import { describe, expect, it } from 'vitest';

import { FEATURED_IDLE_MS, createFeatured, featuredCandidates, featuredScore, pickFeatured, type FeaturedCandidate, type FeaturedPick } from './featured.js';
import type { Match } from './match.js';

const NOW = 10_000_000;

function candidate(matchId: string, over: Partial<FeaturedCandidate> = {}): FeaturedCandidate {
	return {
		matchId,
		roomId: `room-${matchId}`,
		humans: 2,
		live: { turn: 5, active: 0, life: [20, 20], hand: [5, 5] },
		activity: { lastAt: NOW - 1_000, recent: 30 },
		...over,
	};
}

describe('featuredScore', () => {
	it('is null for a game that has not changed within the idle limit, or never has', () => {
		expect(featuredScore(candidate('a', { activity: { lastAt: NOW - FEATURED_IDLE_MS - 1, recent: 40 } }), NOW)).toBeNull();
		expect(featuredScore(candidate('a', { activity: { lastAt: null, recent: 0 } }), NOW)).toBeNull();
		expect(featuredScore(candidate('a', { activity: { lastAt: NOW - FEATURED_IDLE_MS, recent: 1 } }), NOW)).not.toBeNull();
	});

	it('is carried by activity; two people, a later turn and a close race each add', () => {
		const base = featuredScore(candidate('a'), NOW)!;
		expect(featuredScore(candidate('a', { activity: { lastAt: NOW, recent: 31 } }), NOW)).toBe(base + 1);
		expect(featuredScore(candidate('a', { humans: 1 }), NOW)).toBeLessThan(base);
		expect(featuredScore(candidate('a', { live: { turn: 1, active: 0, life: [20, 20], hand: [7, 7] } }), NOW)).toBeLessThan(base);
		expect(featuredScore(candidate('a', { live: { turn: 5, active: 0, life: [20, 4], hand: [5, 5] } }), NOW)).toBeLessThan(base);
	});
});

describe('pickFeatured', () => {
	it('picks the busiest eligible match, and nothing when none is eligible', () => {
		const quiet = candidate('quiet', { activity: { lastAt: NOW, recent: 3 } });
		const busy = candidate('busy', { activity: { lastAt: NOW, recent: 50 } });
		const idle = candidate('idle', { activity: { lastAt: NOW - FEATURED_IDLE_MS - 1, recent: 90 } });
		expect(pickFeatured([quiet, busy, idle], NOW, null)).toEqual({ matchId: 'busy', roomId: 'room-busy' });
		expect(pickFeatured([idle], NOW, null)).toBeNull();
		expect(pickFeatured([], NOW, null)).toBeNull();
	});

	it('keeps the current pick while it is eligible, however busy a newcomer is', () => {
		const current: FeaturedPick = { matchId: 'quiet', roomId: 'room-quiet' };
		const quiet = candidate('quiet', { activity: { lastAt: NOW, recent: 2 } });
		const busy = candidate('busy', { activity: { lastAt: NOW, recent: 100 } });
		expect(pickFeatured([quiet, busy], NOW, current)).toEqual(current);
	});

	it('lets the current pick go once it is idle or gone', () => {
		const current: FeaturedPick = { matchId: 'quiet', roomId: 'room-quiet' };
		const busy = candidate('busy');
		const idle = candidate('quiet', { activity: { lastAt: NOW - FEATURED_IDLE_MS - 1, recent: 10 } });
		expect(pickFeatured([idle, busy], NOW, current)).toEqual({ matchId: 'busy', roomId: 'room-busy' });
		expect(pickFeatured([busy], NOW, current)).toEqual({ matchId: 'busy', roomId: 'room-busy' });
	});
});

describe('featuredCandidates', () => {
	const match = (id: string, live: boolean, ai = false): Match =>
		({
			id,
			seats: [{ ai: false }, { ai }],
			live: () => (live ? { turn: 2, active: 0, life: [20, 18], hand: [6, 6] } : null),
			activity: () => ({ lastAt: NOW, recent: 4 }),
		}) as unknown as Match;

	it('takes live matches in an ordinary room, never a testing room, an undealt match or one with no room', () => {
		const rooms: Record<string, { id: string; testing?: boolean }> = {
			live: { id: 'r1' },
			vsai: { id: 'r2' },
			test: { id: 'r3', testing: true },
			undealt: { id: 'r4' },
		};
		const found = featuredCandidates([match('live', true), match('vsai', true, true), match('test', true), match('undealt', false), match('orphan', true)], (id) => rooms[id], NOW);
		expect(found.map((c) => [c.matchId, c.roomId, c.humans])).toEqual([
			['live', 'r1', 2],
			['vsai', 'r2', 1],
		]);
	});
});

describe('createFeatured', () => {
	it('announces a change of pick once, with what it replaced', () => {
		let now = NOW;
		let candidates: FeaturedCandidate[] = [];
		const changes: [FeaturedPick | null, FeaturedPick | null][] = [];
		const featured = createFeatured({ candidates: () => candidates, changed: (a, b) => changes.push([a, b]), now: () => now });
		try {
			featured.refresh();
			expect(changes).toEqual([]);
			candidates = [candidate('a', { activity: { lastAt: now, recent: 5 } })];
			featured.refresh();
			featured.refresh();
			expect(featured.current()).toEqual({ matchId: 'a', roomId: 'room-a' });
			expect(changes).toEqual([[null, { matchId: 'a', roomId: 'room-a' }]]);
			// Nothing happens at that table for longer than the idle limit: it is let go.
			now += FEATURED_IDLE_MS + 1;
			featured.refresh();
			expect(featured.current()).toBeNull();
			expect(changes.at(-1)).toEqual([{ matchId: 'a', roomId: 'room-a' }, null]);
		} finally {
			featured.stop();
		}
	});
});
