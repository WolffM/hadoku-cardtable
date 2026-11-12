import { describe, expect, it, vi } from 'vitest';

import { RelaySession } from './relay.ts';

function sink(): { toSeat: ReturnType<typeof vi.fn>; toWatchers: ReturnType<typeof vi.fn> } {
	return { toSeat: vi.fn(), toWatchers: vi.fn() };
}

describe('RelaySession', () => {
	it('relays a seat message to every OTHER seat and to watchers, never back to the sender', () => {
		const s = sink();
		const session = new RelaySession(3, s);
		session.fromSeat(1, { hello: 'world' });
		expect(s.toSeat).toHaveBeenCalledTimes(2);
		expect(s.toSeat).toHaveBeenCalledWith(0, { hello: 'world' });
		expect(s.toSeat).toHaveBeenCalledWith(2, { hello: 'world' });
		expect(s.toSeat).not.toHaveBeenCalledWith(1, expect.anything());
		expect(s.toWatchers).toHaveBeenCalledTimes(1);
		expect(s.toWatchers).toHaveBeenCalledWith({ hello: 'world' });
	});

	it('keeps one sender in order: three messages arrive at a watcher in the order they were sent', () => {
		const s = sink();
		const session = new RelaySession(2, s);
		session.fromSeat(0, 1);
		session.fromSeat(0, 2);
		session.fromSeat(0, 3);
		expect(s.toWatchers.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
	});

	it('delivers at most once: each send calls the sink exactly once per recipient, with no retry or queue', () => {
		const s = sink();
		const session = new RelaySession(2, s);
		session.fromSeat(0, 'm1');
		expect(s.toSeat).toHaveBeenCalledTimes(1);
		expect(s.toWatchers).toHaveBeenCalledTimes(1);
	});

	it("a watcher's send is a no-op: nothing is relayed, nothing throws", () => {
		const s = sink();
		const session = new RelaySession(2, s);
		expect(() => session.fromWatcher()).not.toThrow();
		expect(s.toSeat).not.toHaveBeenCalled();
		expect(s.toWatchers).not.toHaveBeenCalled();
	});

	it("ends the match when a seat relays the leader's own { t: 'over', winners }, and stops relaying after", () => {
		const s = sink();
		const onEnded = vi.fn();
		const session = new RelaySession(2, s, onEnded);
		session.fromSeat(0, { t: 'over', winners: [0] });
		expect(session.isEnded).toBe(true);
		expect(session.result).toEqual({ winners: [0] });
		expect(onEnded).toHaveBeenCalledTimes(1);
		expect(onEnded).toHaveBeenCalledWith({ winners: [0] });

		s.toSeat.mockClear();
		s.toWatchers.mockClear();
		session.fromSeat(1, 'late message');
		expect(s.toSeat).not.toHaveBeenCalled();
		expect(s.toWatchers).not.toHaveBeenCalled();
	});

	it('ends the match with a null outcome once every seat has left', () => {
		const s = sink();
		const onEnded = vi.fn();
		const session = new RelaySession(2, s, onEnded);
		session.seatLeft(0);
		expect(session.isEnded).toBe(false);
		expect(onEnded).not.toHaveBeenCalled();
		session.seatLeft(1);
		expect(session.isEnded).toBe(true);
		expect(session.result).toBeNull();
		expect(onEnded).toHaveBeenCalledTimes(1);
		expect(onEnded).toHaveBeenCalledWith(null);
	});

	it('a seat already recorded as left cannot speak for it again', () => {
		const s = sink();
		const session = new RelaySession(2, s);
		session.seatLeft(0);
		session.fromSeat(0, 'ghost');
		expect(s.toSeat).not.toHaveBeenCalled();
		expect(s.toWatchers).not.toHaveBeenCalled();
	});

	it("command({ t: 'concede', seat }) is the same as that seat leaving", () => {
		const s = sink();
		const onEnded = vi.fn();
		const session = new RelaySession(2, s, onEnded);
		session.command({ t: 'concede', seat: 0 });
		session.command({ t: 'concede', seat: 1 });
		expect(onEnded).toHaveBeenCalledWith(null);
	});

	it('ending is idempotent: a second cause after the match has ended changes nothing', () => {
		const s = sink();
		const onEnded = vi.fn();
		const session = new RelaySession(2, s, onEnded);
		session.fromSeat(0, { t: 'over', winners: [0] });
		session.seatLeft(1);
		expect(onEnded).toHaveBeenCalledTimes(1);
		expect(session.result).toEqual({ winners: [0] });
	});

	it("ended() (the shell's own sweep, called directly for now) ends the match as every seat left", () => {
		const s = sink();
		const onEnded = vi.fn();
		const session = new RelaySession(2, s, onEnded);
		session.ended('server-stopping');
		expect(session.isEnded).toBe(true);
		expect(onEnded).toHaveBeenCalledWith(null);
	});

	it('the rest of GameSession is inert for a relay match: no turn, no active seat, no open asks, no wait', () => {
		const session = new RelaySession(2, sink());
		expect(session.turn()).toBeNull();
		expect(session.activeSeat()).toBeNull();
		expect(session.openAsks(0)).toBe(0);
		expect(session.waitedOn(0)).toBe(false);
		expect(() => session.tellRoster()).not.toThrow();
		expect(() => session.onLine(undefined as never)).not.toThrow();
	});

});
