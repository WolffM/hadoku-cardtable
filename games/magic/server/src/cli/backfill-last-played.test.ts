import { describe, expect, it } from 'vitest';
import type { MatchView, SeatView } from '@wolffm/prefs-client/games';
import { stampsFromHistory } from './backfill-last-played.ts';

const seat = (name: string | null, deckId: string | undefined, kind: SeatView['kind'] = 'user'): SeatView => ({
	seat: 0,
	kind,
	name,
	isMe: false,
	placement: 1,
	outcome: 'win',
	ratingBefore: null,
	ratingAfter: null,
	attrs: deckId === undefined ? {} : { deckId },
	counters: {},
});
const match = (endedAt: number, seats: SeatView[]): MatchView => ({ matchId: `m-${endedAt}`, gameId: 'cardtable', mode: 'constructed', startedAt: null, endedAt, rated: false, attrs: {}, counters: {}, seats });

const NAMES: Record<string, string[]> = { Alice: ['u-alice'], Bob: ['u-bob'], Twin: ['u-t1', 'u-t2'] };
const userIdsOf = (name: string) => NAMES[name] ?? [];

describe('stampsFromHistory', () => {
	it("keeps each person's newest game with each deck, and never the AI's", () => {
		const { stamps, counts } = stampsFromHistory(
			[
				match(300, [seat('Alice', 'draft:pod-1'), seat('Forge AI', 'library-x', 'bot')]),
				match(100, [seat('Alice', 'draft:pod-1'), seat('Bob', 'built:b')]),
				match(200, [seat('Alice', 'draft:pod-2'), seat('Bob', 'built:b')]),
			],
			userIdsOf,
		);
		expect(stamps).toEqual(
			new Map([
				['u-alice', new Map([['draft:pod-1', 300], ['draft:pod-2', 200]])],
				['u-bob', new Map([['built:b', 200]])],
			]),
		);
		expect(counts).toEqual({ matches: 3, seats: 5, stamped: 5, unknownName: 0, ambiguousName: 0 });
	});

	it('leaves a seat with no deck id, a name nobody has, and a name two people share', () => {
		const { stamps, counts } = stampsFromHistory([match(1, [seat('Alice', undefined), seat('Stranger', 'draft:p'), seat('Twin', 'draft:p'), seat(null, 'draft:p')])], userIdsOf);
		expect(stamps.size).toBe(0);
		expect(counts).toEqual({ matches: 1, seats: 3, stamped: 0, unknownName: 2, ambiguousName: 1 });
	});
});
