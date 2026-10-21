import { describe, expect, it } from 'vitest';

import { convertToBo3, newSeries, recordGame, seriesFormatOf, seriesWinner, statsModeOf } from './series.ts';

const PLAYED: [string | null, string | null] = ['fk:1111111111111111', 'fk:2222222222222222'];

describe('seriesFormatOf — what a room’s series play by', () => {
	it('every Constructed series but a Gauntlet starts as Bo1, and a rematch sideboards', () => {
		for (const mode of [undefined, null, 'classic', 'random'] as const) {
			expect(seriesFormatOf({ gameType: 'constructed-1v1', mode })).toEqual({ length: 1, sideboarding: true });
		}
	});

	it('a Gauntlet is Bo3 with no sideboarding', () => {
		expect(seriesFormatOf({ gameType: 'constructed-1v1', mode: 'gauntlet' })).toEqual({ length: 3, sideboarding: false });
	});

	it('a draft pod is Bo3 with sideboarding, whatever mode is stored', () => {
		expect(seriesFormatOf({ gameType: 'draft' })).toEqual({ length: 3, sideboarding: true });
		expect(seriesFormatOf({ gameType: 'draft', mode: 'gauntlet' })).toEqual({ length: 3, sideboarding: true });
	});
});

describe('statsModeOf', () => {
	it('names the Constructed mode, classic when none is stored, and draft for a pod', () => {
		expect(statsModeOf({ gameType: 'constructed-1v1' })).toBe('classic');
		expect(statsModeOf({ gameType: 'constructed-1v1', mode: null })).toBe('classic');
		expect(statsModeOf({ gameType: 'constructed-1v1', mode: 'random' })).toBe('random');
		expect(statsModeOf({ gameType: 'constructed-1v1', mode: 'gauntlet' })).toBe('gauntlet');
		expect(statsModeOf({ gameType: 'draft', mode: 'classic' })).toBe('draft');
	});
});

describe('a series record', () => {
	const CLASSIC_ROOM = { gameType: 'constructed-1v1', mode: 'classic' } as const;
	const GAUNTLET_ROOM = { gameType: 'constructed-1v1', mode: 'gauntlet' } as const;
	const POD_ROOM = { gameType: 'draft' } as const;
	const BO1 = seriesFormatOf(CLASSIC_ROOM);
	const GAUNTLET = seriesFormatOf(GAUNTLET_ROOM);
	const POD = seriesFormatOf(POD_ROOM);

	it('a Bo1 is done after its one game', () => {
		const done = recordGame(newSeries(CLASSIC_ROOM, PLAYED, 'playing'), BO1, { matchId: 'm-1', winner: 1 });
		expect(done).toEqual({ length: 1, wins: [0, 1], games: [{ matchId: 'm-1', winner: 1 }], phase: 'done', played: PLAYED, mode: 'classic', settled: false });
		expect(seriesWinner(done)).toBe(1);
	});

	it('Rematch converts a finished Bo1 in place: Bo3, the game kept as game 1, 1-0, sideboarding', () => {
		const done = recordGame(newSeries(CLASSIC_ROOM, PLAYED, 'playing'), BO1, { matchId: 'm-1', winner: 0 });
		const bo3 = convertToBo3(done);
		expect(bo3).toEqual({ length: 3, wins: [1, 0], games: [{ matchId: 'm-1', winner: 0 }], phase: 'sideboarding', played: PLAYED, mode: 'classic', settled: false });
		expect(seriesWinner(bo3!)).toBeNull();
		const two = recordGame({ ...bo3!, phase: 'playing' }, BO1, { matchId: 'm-2', winner: 0 });
		expect(two).toMatchObject({ length: 3, wins: [2, 0], phase: 'done' });
		expect(seriesWinner(two)).toBe(0);
	});

	it('converts only a finished, unrecorded Bo1', () => {
		const fresh = newSeries(CLASSIC_ROOM, PLAYED, 'playing');
		expect(convertToBo3(fresh)).toBeNull();
		const done = recordGame(fresh, BO1, { matchId: 'm-1', winner: 0 });
		expect(convertToBo3({ ...done, settled: true })).toBeNull();
		const pod = recordGame(recordGame(newSeries(POD_ROOM, PLAYED, 'playing'), POD, { matchId: 'm-1', winner: 0 }), POD, { matchId: 'm-2', winner: 0 });
		expect(pod.phase).toBe('done');
		expect(convertToBo3(pod)).toBeNull();
	});

	it('between two games of a Bo3: sideboarding when the format sideboards, between when it does not', () => {
		expect(recordGame(newSeries(POD_ROOM, PLAYED, 'playing'), POD, { matchId: 'm-1', winner: 0 }).phase).toBe('sideboarding');
		expect(recordGame(newSeries(GAUNTLET_ROOM, PLAYED, 'playing'), GAUNTLET, { matchId: 'm-1', winner: 0 }).phase).toBe('between');
	});

	it('a Bo3 that plays all three games without a majority is still done, and names no winner', () => {
		let s = newSeries(GAUNTLET_ROOM, PLAYED, 'playing');
		s = recordGame(s, GAUNTLET, { matchId: 'm-1', winner: 0 });
		s = recordGame(s, GAUNTLET, { matchId: 'm-2', winner: null });
		s = recordGame(s, GAUNTLET, { matchId: 'm-3', winner: 1 });
		expect(s).toMatchObject({ wins: [1, 1], phase: 'done' });
		expect(seriesWinner(s)).toBeNull();
	});
});
