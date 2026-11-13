import { describe, expect, it } from 'vitest';

import type { MatchSpec } from '../../host.js';
import { toyAdapter, type ToyFrame } from './adapter.js';

const SPEC: MatchSpec = { seats: [{ ai: false, name: 'Alice', deck: null }, { ai: false, name: 'Bob', deck: null }] };

describe('toyAdapter.seats / .concede / .notice', () => {
	it('seats() reads spec.seats back, ai and name only — deck goes unread', () => {
		expect(toyAdapter.seats(SPEC)).toEqual([{ ai: false, name: 'Alice' }, { ai: false, name: 'Bob' }]);
	});

	it('concede() names the conceding seat; notice() carries the words through unchanged', () => {
		expect(toyAdapter.concede(0)).toEqual({ t: 'concede', seat: 0 });
		expect(toyAdapter.concede(1)).toEqual({ t: 'concede', seat: 1 });
		expect(toyAdapter.notice('the match ended')).toEqual({ kind: 'notify', text: 'the match ended' });
	});

	it('restoreSpec() writes the checkpoint into .scenario as JSON, for playToy to read back', () => {
		expect(toyAdapter.restoreSpec(SPEC, { score: [2, 1] })).toEqual({ ...SPEC, scenario: '{"score":[2,1]}' });
	});
});

describe('toyAdapter.classify', () => {
	it('ready / checkpoint pass straight through', () => {
		expect(toyAdapter.classify({ t: 'ready' })).toEqual({ t: 'ready' });
		expect(toyAdapter.classify({ t: 'checkpoint', score: [1, 2] })).toEqual({ t: 'checkpoint', cp: { score: [1, 2] } });
	});

	it("'scored' classifies as a seat line, carrying the whole line as raw", () => {
		const line = { t: 'scored' as const, seat: 1 as const, score: [0, 1] as [number, number] };
		expect(toyAdapter.classify(line)).toEqual({ t: 'seat', seat: 1, raw: line });
	});

	it("'over' names the winner and the loser as seats, never drawn", () => {
		expect(toyAdapter.classify({ t: 'over', winner: 0, conceded: false, score: [3, 1] })).toEqual({
			t: 'over',
			winners: [0],
			losers: [1],
			drawn: false,
		});
		expect(toyAdapter.classify({ t: 'over', winner: 1, conceded: true, score: [0, 0] })).toEqual({
			t: 'over',
			winners: [1],
			losers: [0],
			drawn: false,
		});
	});
});

describe('toyAdapter.session', () => {
	it("onLine('scored') tells both seats and the watchers the same frame; every other line is ignored", () => {
		const toSeat: { seat: number; frame: ToyFrame }[] = [];
		const toWatchers: ToyFrame[] = [];
		const session = toyAdapter.session({
			toSeat: (seat, frame) => toSeat.push({ seat, frame }),
			toWatchers: (frame) => toWatchers.push(frame),
			command: () => {},
		});
		session.onLine({ t: 'scored', seat: 0, score: [1, 0] });
		expect(toSeat).toEqual([
			{ seat: 0, frame: { kind: 'score', score: [1, 0] } },
			{ seat: 1, frame: { kind: 'score', score: [1, 0] } },
		]);
		expect(toWatchers).toEqual([{ kind: 'score', score: [1, 0] }]);

		toSeat.length = 0;
		toWatchers.length = 0;
		session.onLine({ t: 'ready' });
		session.onLine({ t: 'checkpoint', score: [1, 0] });
		expect(toSeat).toEqual([]);
		expect(toWatchers).toEqual([]);
	});

	it('command() forwards to the sink untouched', () => {
		const sent: unknown[] = [];
		const session = toyAdapter.session({ toSeat: () => {}, toWatchers: () => {}, command: (c) => sent.push(c) });
		session.command({ t: 'concede', seat: 0 });
		expect(sent).toEqual([{ t: 'concede', seat: 0 }]);
	});

	it('has no turn, no active seat, no open asks, and runs both clocks throughout — the no-structure half of the proof', () => {
		const session = toyAdapter.session({ toSeat: () => {}, toWatchers: () => {}, command: () => {} });
		expect(session.waitedOn(0)).toBe(true);
		expect(session.waitedOn(1)).toBe(true);
		expect(session.turn()).toBeNull();
		expect(session.activeSeat()).toBeNull();
		expect(session.openAsks(0)).toBe(0);
		expect(session.openAsks(1)).toBe(0);
	});

	it('replayed(), ended() and notice() exist and do nothing — proving the optional GameSession hooks fit a game with neither asks nor per-seat state to sweep nor words of its own', () => {
		const session = toyAdapter.session({ toSeat: () => {}, toWatchers: () => {}, command: () => {} });
		expect(() => session.replayed?.({ t: 'concede', seat: 0 })).not.toThrow();
		expect(() => session.ended?.(null)).not.toThrow();
		expect(() => session.ended?.('the host exited')).not.toThrow();
		expect(() => session.notice?.('server-stopping', 'the server is restarting')).not.toThrow();
	});
});
