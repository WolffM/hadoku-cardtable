import { SERVER_RESTARTING_EVENT } from '@hadoku/shared';
import { describe, expect, it } from 'vitest';
import { NOTICE_FRESH_MS, QUIET_RECONNECT_MS, watchRestart, type RestartClock } from './restart-notice.ts';

function harness() {
	const handlers = new Map<string, (() => void)[]>();
	let now = 0;
	let timers: { at: number; fn: () => void; id: number }[] = [];
	let nextId = 0;
	const clock: RestartClock = {
		now: () => now,
		setTimeout: (fn, ms) => {
			const id = ++nextId;
			timers.push({ at: now + ms, fn, id });
			return id;
		},
		clearTimeout: (id) => {
			timers = timers.filter((t) => t.id !== id);
		},
	};
	const seen: boolean[] = [];
	watchRestart({ on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]) }, (u) => seen.push(u), clock);
	return {
		seen,
		fire: (event: string) => (handlers.get(event) ?? []).forEach((h) => h()),
		advance: (ms: number) => {
			now += ms;
			for (const t of timers.filter((t) => t.at <= now)) {
				timers = timers.filter((x) => x !== t);
				t.fn();
			}
		},
	};
}

describe('watchRestart', () => {
	it('a drop after the notice is updating, until the quiet window ends', () => {
		const h = harness();
		h.fire(SERVER_RESTARTING_EVENT);
		h.fire('disconnect');
		expect(h.seen).toEqual([true]);
		h.advance(QUIET_RECONNECT_MS - 1);
		expect(h.seen).toEqual([true]);
		h.advance(1);
		expect(h.seen).toEqual([true, false]);
	});

	it('a reconnect inside the window ends it at once, and the old timer never fires', () => {
		const h = harness();
		h.fire(SERVER_RESTARTING_EVENT);
		h.fire('disconnect');
		h.advance(2_000);
		h.fire('connect');
		h.advance(QUIET_RECONNECT_MS);
		expect(h.seen).toEqual([true, false]);
	});

	it('a drop with no notice, or a notice too old to explain it, is not updating', () => {
		const h = harness();
		h.fire('disconnect');
		h.fire('connect');
		h.fire(SERVER_RESTARTING_EVENT);
		h.advance(NOTICE_FRESH_MS + 1);
		h.fire('disconnect');
		expect(h.seen).toEqual([]);
	});

	it('a notice explains one drop only', () => {
		const h = harness();
		h.fire(SERVER_RESTARTING_EVENT);
		h.fire('disconnect');
		h.fire('connect');
		h.fire('disconnect');
		expect(h.seen).toEqual([true, false]);
	});
});
