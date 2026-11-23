import { describe, expect, it } from 'vitest';

import { degradations, frameLines, frameRate, frameStats, worstSessions, type FrameStats } from './watch-frames.ts';

const SINCE = '2026-11-22T00:00:00.000Z';
/** One 5-minute `frames` event, as the kernel's tally posts it. */
const frames = (timestamp: string, match: Record<string, number>, worst: unknown[] = [], site = 'prod') => ({
	timestamp,
	site,
	context: { surfaces: { match: { summaries: 1, frames: 0, slowMs: 0, freezes: 0, scrolls: 0, scrollFrames: 0, scrollJanky: 0, ...match } }, worst },
});
const stats = (over: Partial<FrameStats>): FrameStats => ({
	watchedMin: 60,
	summaries: 10,
	fps: 60,
	stretches: 0,
	freezes: 0,
	stretchesPerHour: 0,
	freezesPerHour: 0,
	slowShare: 0,
	scrolls: 0,
	scrollJank: null,
	...over,
});

describe('frameStats', () => {
	it('sums the windows and rates them per watched hour', () => {
		const s = frameStats([
			frames('2026-11-22T01:00:00Z', { watchedMs: 1_800_000, frames: 108_000, stretches: 3, slowMs: 180_000 }),
			frames('2026-11-22T01:05:00Z', { watchedMs: 1_800_000, frames: 108_000, stretches: 3, freezes: 1 }),
		]).match;
		expect(s).toEqual({ watchedMin: 60, summaries: 2, fps: 60, stretches: 6, freezes: 1, stretchesPerHour: 6, freezesPerHour: 1, slowShare: 0.05, scrolls: 0, scrollJank: null });
	});
});

describe('degradations', () => {
	it('flags a day worse than its week by the factor and the floor', () => {
		expect(degradations('match', stats({ stretchesPerHour: 20 }), stats({ stretchesPerHour: 5 }))).toEqual(['match: bad stretches 20/h against the week\'s 5/h']);
		expect(degradations('match', stats({ slowShare: 0.3 }), stats({ slowShare: 0.05 }))).toEqual(["match: time in dropped motion 30% against the week's 5%"]);
	});

	it('leaves alone a small change, a doubling under the floor, and too little watched time', () => {
		expect(degradations('match', stats({ stretchesPerHour: 7 }), stats({ stretchesPerHour: 5 }))).toEqual([]);
		expect(degradations('match', stats({ stretchesPerHour: 4 }), stats({ stretchesPerHour: 1 }))).toEqual([]);
		expect(degradations('match', stats({ watchedMin: 5, stretchesPerHour: 200 }), stats({}))).toEqual([]);
	});

	it('flags a bad day with no week to compare', () => {
		expect(degradations('front', stats({ stretchesPerHour: 90 }), undefined)).toEqual(['front: 90 bad stretches/h']);
		expect(degradations('front', stats({ stretchesPerHour: 90 }), stats({ watchedMin: 2 }))).toEqual(['front: 90 bad stretches/h']);
	});
});

describe('frameRate', () => {
	const week = Array.from({ length: 7 }, (_, d) => frames(`2026-11-${String(15 + d).padStart(2, '0')}T12:00:00Z`, { watchedMs: 3_600_000, frames: 216_000, stretches: 2 }));
	const day = [
		frames('2026-11-22T12:00:00Z', { watchedMs: 3_600_000, frames: 180_000, stretches: 30 }, [
			{ session: 'm-1:0', surface: 'match', stretches: 25, watchedMs: 600_000, fps: 40, p95: 34, worstMs: 300, env: { hz: 60, gpu: 'Intel UHD' } },
		]),
	];

	it('splits the history at the window and names the degraded surface and the worst session', () => {
		const f = frameRate([...week, ...day], SINCE, null);
		expect(f.sites.prod.degraded).toEqual(["match: bad stretches 30/h against the week's 2/h"]);
		expect(f.sites.prod.week.match.watchedMin).toBe(420);
		const lines = frameLines(f.sites.prod);
		expect(lines[0]).toBe("  DEGRADED match: bad stretches 30/h against the week's 2/h");
		expect(lines.at(-1)).toBe('  worst 11-22 12:00 m-1:0 25 stretch(es) in 10 min, p95 34 ms, worst 300 ms, 40 fps · hz 60, gpu Intel UHD');
	});

	it('merges a session named by several windows before ranking it', () => {
		const w = (session: string, stretches: number, watchedMs: number, worstMs: number) => ({ session, surface: 'match', stretches, watchedMs, fps: 60, p95: 20, worstMs });
		const got = worstSessions([
			frames('2026-11-22T12:00:00Z', { watchedMs: 1 }, [w('m-1:0', 3, 120_000, 90), w('m-2:0', 2, 120_000, 80)]),
			frames('2026-11-22T12:05:00Z', { watchedMs: 1 }, [w('m-1:0', 3, 120_000, 150)]),
		]);
		expect(got.map((x) => [x.session, x.stretches, x.watchedMs, x.worstMs, x.fps, x.at])).toEqual([
			['m-1:0', 6, 240_000, 150, 60, '2026-11-22T12:05:00Z'],
			['m-2:0', 2, 120_000, 80, 60, '2026-11-22T12:00:00Z'],
		]);
	});

	it('compares nothing when the baseline could not be read', () => {
		const f = frameRate(day, SINCE, '/service-events: HTTP 500');
		expect(f.error).toBe('/service-events: HTTP 500');
		expect(f.sites.prod.degraded).toEqual([]);
	});
});
