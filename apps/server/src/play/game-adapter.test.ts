import { describe, expect, it } from 'vitest';

import type { ClassifiedLine, GameAdapter, GameSession } from './game-adapter.js';

/**
 * Proves `GameAdapter`/`GameSession` fit a game that is not Forge: a toy adapter for the lines
 * `play/fixtures/fake-bridge.mjs` actually emits (`host.test.ts`'s stand-in for `bridge/PlayBridge.java`,
 * which speaks no Magic at all — it only runs the host's `warm`/`start`/`stop` line protocol). This
 * is a compile-level check (the toy object is assignable to the real generic interface, type
 * parameters and all) plus one unit test that classifies the fixture's own line shapes — not a
 * runtime wiring of the fixture itself, which is `host.test.ts`'s job at L2.
 */

interface ToySpec {
	seats: { ai: boolean; name: string }[];
}

/** The lines `fake-bridge.mjs` writes to stdout, copied from its own `out(...)` calls. */
type ToyLine =
	| { t: 'alive' }
	| { t: 'warm'; bootMs: number }
	| { t: 'ready'; forgePort: number; bootMs: number; startMs: number; seats: unknown[] }
	| { t: 'rejected'; message: string; command: string }
	| { t: 'stopped' }
	| { t: 'cutoff'; where?: string };

type ToyCmd = { t: 'start'; config: unknown } | { t: 'stop' } | { t: 'act'; seat: number; method: string };

interface ToyFrame {
	kind: 'notify';
	text: string;
}

interface ToyCheckpoint {
	turn: number;
}

const toyAdapter: GameAdapter<ToySpec, ToyLine, ToyCmd, ToyFrame, ToyCheckpoint> = {
	seats: (spec) => spec.seats,
	classify: (line): ClassifiedLine<ToyCheckpoint> => (line.t === 'ready' ? { t: 'ready' } : { t: 'info' }),
	session: (out): GameSession<ToyLine, ToyCmd> => ({
		onLine(line) {
			out.toSeat(0, { kind: 'notify', text: JSON.stringify(line) });
		},
		command: (c) => out.command(c),
		waitedOn: () => false,
		tellRoster: () => {},
		turn: () => null,
		activeSeat: () => null,
		openAsks: () => 0,
		// Trivial here (this toy has no asks and nothing of its own to sweep) but still implemented,
		// to prove the hooks fit a non-Forge session.
		replayed: () => {},
		ended: () => {},
		notice: () => {},
	}),
	restoreSpec: (spec, _cp) => spec,
	concede: (seat) => ({ t: 'act', seat, method: 'concede' }),
	notice: (text) => ({ kind: 'notify', text }),
};

describe('a toy, non-Forge adapter fits GameAdapter/GameSession', () => {
	it('classifies every line fake-bridge.mjs actually emits', () => {
		expect(toyAdapter.classify({ t: 'alive' })).toEqual({ t: 'info' });
		expect(toyAdapter.classify({ t: 'warm', bootMs: 1 })).toEqual({ t: 'info' });
		expect(toyAdapter.classify({ t: 'ready', forgePort: 0, bootMs: 1, startMs: 1, seats: [] })).toEqual({ t: 'ready' });
		expect(toyAdapter.classify({ t: 'rejected', message: 'no match', command: 'stop' })).toEqual({ t: 'info' });
		expect(toyAdapter.classify({ t: 'stopped' })).toEqual({ t: 'info' });
		expect(toyAdapter.classify({ t: 'cutoff', where: 'AiController' })).toEqual({ t: 'info' });
	});

	it('seats(), session().onLine()/command(), concede() and notice() all compile and run against the toy shapes', () => {
		expect(toyAdapter.seats({ seats: [{ ai: false, name: 'Hadoku' }] })).toEqual([{ ai: false, name: 'Hadoku' }]);
		const toSeat: { seat: number; frame: ToyFrame }[] = [];
		const sent: ToyCmd[] = [];
		const session = toyAdapter.session({ toSeat: (seat, f) => toSeat.push({ seat, frame: f }), toWatchers: () => {}, command: (c) => sent.push(c) });
		session.onLine({ t: 'stopped' });
		expect(toSeat).toEqual([{ seat: 0, frame: { kind: 'notify', text: '{"t":"stopped"}' } }]);
		session.command(toyAdapter.concede(0));
		expect(sent).toEqual([{ t: 'act', seat: 0, method: 'concede' }]);
		expect(toyAdapter.concede(1)).toEqual({ t: 'act', seat: 1, method: 'concede' });
		expect(toyAdapter.notice('the match ended')).toEqual({ kind: 'notify', text: 'the match ended' });
	});
});
