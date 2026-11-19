import { describe, expect, it } from 'vitest';

import { AI_CONCEDES_ON_ITS_TURN, concedeForTestingRoom } from './ai-concedes.js';

function table(aiTurn: number | null, roomConcedes: boolean) {
	const asked: string[] = [];
	const deferred: (() => void)[] = [];
	let conceded = 0;
	const match = {
		id: 'm-1',
		aiTurn: () => aiTurn,
		concedeAi: () => {
			conceded += 1;
			return true;
		},
	};
	const lobby = {
		aiConcedesIn: (matchId: string) => {
			asked.push(matchId);
			return roomConcedes;
		},
	};
	concedeForTestingRoom(match, lobby, (run) => deferred.push(run));
	return { asked, deferred, conceded: () => conceded };
}

describe('a testing room’s AI gives each game up at the start of its second turn', () => {
	it('concedes once the AI is on its second turn, after the frame that told it', () => {
		const t = table(AI_CONCEDES_ON_ITS_TURN, true);
		expect(t.asked).toEqual(['m-1']);
		expect(t.conceded(), 'not inside the frame').toBe(0);
		expect(t.deferred).toHaveLength(1);
		t.deferred[0]!();
		expect(t.conceded()).toBe(1);
	});

	it('still does on a later turn of its own: a match restored past the turn ends the same way', () => {
		expect(table(AI_CONCEDES_ON_ITS_TURN + 3, true).deferred).toHaveLength(1);
	});

	it('plays its first turn out, and does nothing on the other seat’s turn', () => {
		expect(table(1, true).deferred).toHaveLength(0);
		expect(table(null, true).deferred).toHaveLength(0);
	});

	it('never in a room that was not seeded with it', () => {
		const t = table(AI_CONCEDES_ON_ITS_TURN, false);
		expect(t.asked).toEqual(['m-1']);
		expect(t.deferred).toHaveLength(0);
	});
});
