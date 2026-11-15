import { afterEach, describe, expect, it, vi } from 'vitest';

import { HeartbeatWatch } from './heartbeat-watch.ts';

const watches: HeartbeatWatch[] = [];
afterEach(() => {
	for (const w of watches.splice(0)) w.stop();
});

function watch(everyMs: number, clock: { t: number }): HeartbeatWatch {
	const w = new HeartbeatWatch(everyMs, () => clock.t);
	watches.push(w);
	return w;
}

describe('HeartbeatWatch', () => {
	it('is on time up to one missed beat, and late past it, by the gap on its own clock', () => {
		const clock = { t: 0 };
		const w = watch(2000, clock);
		expect(w.beat()).toBeNull();
		clock.t += 2000;
		expect(w.beat()).toBeNull();
		clock.t += 4000;
		expect(w.beat()).toBeNull();
		clock.t += 11_000;
		expect(w.beat()).toMatchObject({ gapMs: 11_000 });
		clock.t += 2000;
		expect(w.beat()).toBeNull();
	});

	it('reports the worst event-loop delay since the last beat, and starts over at each beat', async () => {
		const clock = { t: 0 };
		const w = watch(10, clock);
		w.beat();
		await vi.waitFor(() => expect(w.loopMaxMs()).toBeGreaterThan(0)); // sampling again since the beat
		const blockedUntil = Date.now() + 300;
		while (Date.now() < blockedUntil); // the loop is held for 300 ms
		await vi.waitFor(() => expect(w.loopMaxMs()).toBeGreaterThanOrEqual(250));
		clock.t += 1000;
		expect(w.beat()?.loopMaxMs).toBeGreaterThanOrEqual(250);
		expect(w.loopMaxMs()).toBeLessThan(250);
	});

	it('calls a heartbeat slow only when building it took longer than the interval', () => {
		const w = watch(2000, { t: 0 });
		expect(w.slow(2000)).toBe(false);
		expect(w.slow(2001)).toBe(true);
	});
});
