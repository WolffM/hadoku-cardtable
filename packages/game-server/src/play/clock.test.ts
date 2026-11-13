import { describe, expect, it } from 'vitest';

import { ChessClock } from './clock.ts';

const MIN = 60_000;

describe('ChessClock', () => {
	it('spends only the time a seat is waited on', () => {
		const clock = new ChessClock([20 * MIN, 20 * MIN]);
		expect(clock.left(5_000)).toEqual([20 * MIN, 20 * MIN]);
		clock.set([true, false], 10_000);
		expect(clock.left(40_000)).toEqual([20 * MIN - 30_000, 20 * MIN]);
		expect(clock.reading(40_000)).toEqual([
			{ ms: 20 * MIN - 30_000, running: true },
			{ ms: 20 * MIN, running: false },
		]);
	});

	it('pauses on a hand-over and resumes where it stopped', () => {
		const clock = new ChessClock([MIN, MIN]);
		clock.set([true, false], 0);
		expect(clock.set([false, true], 10_000)).toBe(true);
		// Seat 0 is not charged while seat 1 decides.
		expect(clock.left(25_000)).toEqual([50_000, 45_000]);
		clock.set([true, false], 25_000);
		expect(clock.left(30_000)).toEqual([45_000, 45_000]);
	});

	it('says nothing moved when the same seats are still waited on', () => {
		const clock = new ChessClock([MIN, MIN]);
		expect(clock.set([true, false], 0)).toBe(true);
		expect(clock.set([true, false], 1_000)).toBe(false);
		expect(clock.left(2_000)).toEqual([58_000, MIN]);
	});

	it('runs both seats at once when both decide (a mulligan)', () => {
		const clock = new ChessClock([MIN, MIN]);
		clock.set([true, true], 0);
		expect(clock.left(7_000)).toEqual([53_000, 53_000]);
	});

	it('keeps running for a seat that is waited on while disconnected: being away is not a pause', () => {
		// The clock has no idea of a connection; only `set` stops it.
		const clock = new ChessClock([MIN, MIN]);
		clock.set([false, true], 0);
		expect(clock.left(45_000)).toEqual([MIN, 15_000]);
	});

	it('flags the running seat at zero and never goes below it', () => {
		const clock = new ChessClock([20_000, MIN]);
		clock.set([true, false], 0);
		expect(clock.nextFlag(5_000)).toEqual({ seat: 0, inMs: 15_000 });
		expect(clock.flagged(19_999)).toBeNull();
		expect(clock.flagged(20_000)).toBe(0);
		expect(clock.left(90_000)).toEqual([0, MIN]);
		// A seat with nothing left does not start again.
		clock.stop(90_000);
		expect(clock.set([true, false], 91_000)).toBe(false);
	});

	it('has no flag to wait for while nobody runs', () => {
		const clock = new ChessClock([MIN, MIN]);
		expect(clock.nextFlag(0)).toBeNull();
		clock.set([true, true], 0);
		clock.stop(1_000);
		expect(clock.nextFlag(50_000)).toBeNull();
	});

	it('excludes sideboarding: the next game starts from what the last one left, however long the break', () => {
		const game1 = new ChessClock([20 * MIN, 20 * MIN]);
		game1.set([true, false], 0);
		game1.set([false, true], 3 * MIN);
		game1.stop(5 * MIN);
		const carried = game1.left(5 * MIN);
		expect(carried).toEqual([17 * MIN, 18 * MIN]);
		// Ten minutes of sideboarding later, game 2 starts with exactly what was carried.
		const game2 = new ChessClock(carried);
		expect(game2.left(15 * MIN)).toEqual([17 * MIN, 18 * MIN]);
	});
});
