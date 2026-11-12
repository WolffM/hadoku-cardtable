import { describe, expect, it } from 'vitest';

import { inProcessHost, type InProcessEngine } from './in-process.js';

type ToyLine = { t: 'ready' } | { t: 'echo'; n: number };
type ToyCmd = { t: 'ping'; n: number } | { t: 'bye' };

/** The smallest engine that proves the wiring: echoes `ping`, says nothing for `bye`. */
function echoEngine(): InProcessEngine<{ seats: number }, ToyLine, ToyCmd> {
	return {
		start: (_matchId, _spec, line) => {
			line({ t: 'ready' });
			return {
				send(cmd) {
					if (cmd.t === 'ping') line({ t: 'echo', n: cmd.n });
				},
				stop() {},
			};
		},
	};
}

describe('inProcessHost', () => {
	it("calls the engine's own line before start() returns, and forwards every later line through events.line the same way", () => {
		const lines: ToyLine[] = [];
		const host = inProcessHost(echoEngine())('m1', { seats: 2 }, { line: (l) => lines.push(l), exit: () => {}, log: () => {} });
		expect(lines).toEqual([{ t: 'ready' }]);
		host.send({ t: 'ping', n: 3 });
		expect(lines).toEqual([{ t: 'ready' }, { t: 'echo', n: 3 }]);
	});

	it("passes matchId and spec through to the engine's start, untouched", () => {
		let seen: { matchId: string; spec: { seats: number } } | null = null;
		const factory = inProcessHost<{ seats: number }, ToyLine, ToyCmd>({
			start: (matchId, spec, line) => {
				seen = { matchId, spec };
				line({ t: 'ready' });
				return { send: () => {}, stop: () => {} };
			},
		});
		factory('m2', { seats: 4 }, { line: () => {}, exit: () => {}, log: () => {} });
		expect(seen).toEqual({ matchId: 'm2', spec: { seats: 4 } });
	});

	it('stop() reaches the engine exactly once, and every send/line after it is silently dropped', () => {
		const sentToEngine: ToyCmd[] = [];
		const stops: number[] = [];
		const lines: ToyLine[] = [];
		const captured: { line: ((l: ToyLine) => void) | null } = { line: null };
		const host = inProcessHost<{ seats: number }, ToyLine, ToyCmd>({
			start: (_matchId, _spec, line) => {
				captured.line = line;
				return {
					send: (cmd) => sentToEngine.push(cmd),
					stop: () => stops.push(1),
				};
			},
		})('m3', { seats: 2 }, { line: (l) => lines.push(l), exit: () => {}, log: () => {} });

		host.stop();
		host.stop();
		expect(stops).toEqual([1]);

		host.send({ t: 'bye' });
		expect(sentToEngine).toEqual([]);

		// An engine that is slow to notice `stop()` and calls `line` anyway: the host still drops it.
		captured.line?.({ t: 'echo', n: 9 });
		expect(lines).toEqual([]);
	});

	it('every MatchHost it hands back is assignable with no cast — the compile-level half of the proof', () => {
		const host = inProcessHost(echoEngine())('m4', { seats: 2 }, { line: () => {}, exit: () => {}, log: () => {} });
		const send: (cmd: ToyCmd) => void = host.send;
		const stop: () => void = host.stop;
		expect(typeof send).toBe('function');
		expect(typeof stop).toBe('function');
	});
});
