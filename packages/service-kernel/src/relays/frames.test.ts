import { describe, expect, it } from 'vitest';

import type { TelemetryContext } from '../telemetry/telemetry.ts';
import { framesTally, SLOW_P95_MS } from './frames.ts';

// Shapes copied from production's log (2026-11-22), ids shortened.
const matchSummary = {
	evt: 'client',
	matchId: 'm-1',
	seat: 0,
	participantId: 'fk:a',
	kind: 'perf',
	what: 'summary',
	why: 'over',
	frames: 9678,
	watchedMs: 81415,
	fps: 118.9,
	p50: 9,
	p95: 9,
	p99: 9,
	worstMs: 67,
	stretches: 0,
};
const matchStretch = { evt: 'client', matchId: 'm-2', seat: 1, kind: 'perf', what: 'stretch', ms: 167, frames: 4, worstMs: 58, freeze: false };
const frontSummary = { evt: 'client', page: 'front', userId: 'u-1', kind: 'perf', what: 'summary', frames: 292, watchedMs: 5267, p95: 40, worstMs: 217 };
const frontScroll = { evt: 'client', page: 'front', userId: 'u-2', kind: 'perf', what: 'scroll', frames: 7, ms: 437, over25: 5 };

function tally() {
	const posted: { event: string; context: TelemetryContext }[] = [];
	const t = framesTally({ report: (event, context) => posted.push({ event, context }), now: () => 0, windowMs: 3_600_000 });
	t.stop();
	return { t, posted };
}

describe('framesTally', () => {
	it('posts nothing for a window without perf lines', () => {
		const { t, posted } = tally();
		t.note({ evt: 'client', matchId: 'm-1', kind: 'sound', what: 'summary', frames: 10, watchedMs: 1000 });
		t.note({ evt: 'client-malformed', kind: 'perf', what: 'summary' });
		t.flush();
		expect(posted).toEqual([]);
	});

	it('sums each surface, counts slow time by p95 and names the worst sessions with their machine', () => {
		const { t, posted } = tally();
		t.note(matchSummary);
		t.note({ ...matchSummary, matchId: 'm-2', seat: 1, frames: 1800, watchedMs: 60_000, p95: SLOW_P95_MS + 3, worstMs: 120 });
		t.note(matchStretch);
		t.note({ ...matchStretch, ms: 400, worstMs: 260, freeze: true });
		t.note({ evt: 'client', matchId: 'm-2', seat: 1, kind: 'perf', what: 'env', hz: 60, dpr: 2, cores: 4, gpu: 'Intel UHD' });
		t.note(frontSummary);
		t.note(frontScroll);
		t.flush();

		expect(posted).toHaveLength(1);
		const { event, context } = posted[0];
		expect(event).toBe('frames');
		const surfaces = context.surfaces as Record<string, Record<string, unknown>>;
		expect(surfaces.match).toMatchObject({
			summaries: 2,
			frames: 11_478,
			watchedMs: 141_415,
			slowMs: 60_000,
			stretches: 2,
			freezes: 1,
			stretchMs: 567,
			fps: 81.2,
		});
		expect(surfaces.front).toMatchObject({ summaries: 1, slowMs: 5267, scrolls: 1, scrollFrames: 7, scrollJanky: 5 });
		expect(context.sessions).toBe(4);
		expect(context.worst).toEqual([
			{
				session: 'm-2:1',
				surface: 'match',
				stretches: 2,
				watchedMs: 60_000,
				fps: 30,
				p95: 33,
				worstMs: 260,
				env: { hz: 60, dpr: 2, cores: 4, gpu: 'Intel UHD' },
			},
		]);
	});

	it('starts a fresh window after each post', () => {
		const { t, posted } = tally();
		t.note(matchSummary);
		t.flush();
		t.flush();
		t.note(matchStretch);
		t.flush();
		expect(posted).toHaveLength(2);
		expect((posted[1].context.surfaces as Record<string, Record<string, unknown>>).match).toMatchObject({ summaries: 0, stretches: 1 });
	});
});
