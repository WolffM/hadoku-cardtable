import type { ParticipantId } from '@wolffm/rooms-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MatchSpec } from '../../host.js';
import { inProcessHost } from '../../runtimes/in-process.js';
import { toyAdapter, type ToyFrame } from './adapter.js';
import { ToyMatch, type ToyMatchDeps } from './match.js';
import { toyEngine } from './rules.js';

/**
 * `HostedMatch` + `runtimes/in-process.ts` + `fixtures/toy-game/` playing a whole, non-Forge match
 * end to end: two seats join, play, a seat drops and rejoins inside the grace, a watcher joins and
 * cannot act, and the game ends with an outcome the shell records.
 */

const ALICE = 'fk:alice' as ParticipantId;
const BOB = 'fk:bob' as ParticipantId;
const CAROL = 'fk:carol' as ParticipantId;

const SPEC: MatchSpec = { seats: [{ ai: false, name: 'Alice', deck: null }, { ai: false, name: 'Bob', deck: null }] };

function harness(rejoinGraceMs?: number) {
	const logs: Record<string, unknown>[] = [];
	const emitted: { seat: number; frame: ToyFrame }[] = [];
	const watcherFrames: ToyFrame[] = [];
	const deps: ToyMatchDeps = {
		log: (e) => logs.push(e),
		host: inProcessHost(toyEngine()),
		emit: (seat, frame) => emitted.push({ seat, frame }),
		emitWatchers: (frame) => watcherFrames.push(frame),
		...(rejoinGraceMs === undefined ? {} : { rejoinGraceMs }),
	};
	const match = new ToyMatch('toy-whole-match-1', SPEC, deps);
	match.start();
	return { match, logs, emitted, watcherFrames };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('a toy, non-Forge game plays a whole match through HostedMatch + the in-process runtime', () => {
	it('two seats join, play, a seat drops and rejoins inside the grace, a watcher joins and cannot act, and the game ends with an outcome the shell records', () => {
		const { match, emitted, watcherFrames } = harness(5_000);

		// The toy engine's own synchronous `ready`, read through `onLine`/`classify`, is what takes
		// the match from `starting` to `running` — there is no per-seat "deal" to wait on, unlike Forge's.
		expect(match.status).toBe('running');

		expect(match.claim(ALICE)).toEqual({ ok: true, seat: 0, fresh: true });
		expect(match.claim(BOB)).toEqual({ ok: true, seat: 1, fresh: true });
		match.seatConnected(0);
		match.seatConnected(1);

		// A watcher joins: a third participant is refused a seat outright (both are taken), the same
		// generic `claim` every seated game shares — and with no seat, nothing she sends could ever
		// be addressed to this match's `act`.
		expect(match.claim(CAROL)).toEqual({ ok: false, error: 'match-full' });
		expect(match.seatOf(CAROL)).toBeNull();

		match.act({ t: 'score', seat: 0 });
		expect(emitted).toEqual([
			{ seat: 0, frame: { kind: 'score', score: [1, 0] } },
			{ seat: 1, frame: { kind: 'score', score: [1, 0] } },
		]);
		expect(watcherFrames).toEqual([{ kind: 'score', score: [1, 0] }]);

		// Bob drops, then rejoins inside the grace: the game is untouched either way.
		match.seatDisconnected(1);
		expect(match.seats[1]?.here).toBe(false);
		match.seatConnected(1);
		expect(match.seats[1]?.here).toBe(true);
		expect(match.status).toBe('running');

		emitted.length = 0;
		match.act({ t: 'score', seat: 0 });
		match.act({ t: 'score', seat: 0 });
		expect(match.status).toBe('over');
		expect(match.winners).toEqual([0]);
		expect(match.losers).toEqual([1]);
		expect(match.drawn).toBe(false);
		expect(match.endedAt).not.toBeNull();
		expect(emitted.at(-1)).toEqual({ seat: 1, frame: { kind: 'score', score: [3, 0] } });
	});

	it('a concede ends the game for the other seat, through the SAME generic ending as a natural win', () => {
		const { match } = harness();
		match.claim(ALICE);
		match.claim(BOB);
		match.act(toyAdapter.concede(0));
		expect(match.status).toBe('over');
		expect(match.winners).toEqual([1]);
		expect(match.losers).toEqual([0]);
	});

	it("nobody rejoins within the grace: the match stops itself (mutation target: MatchShell.armRejoinGrace)", () => {
		vi.useFakeTimers();
		const { match, logs } = harness(5_000);
		match.claim(ALICE);
		match.claim(BOB);
		match.seatConnected(0);
		match.seatConnected(1);
		match.seatDisconnected(0);
		match.seatDisconnected(1);

		expect(match.status).toBe('running');
		vi.advanceTimersByTime(5_001);
		expect(match.status).toBe('stopped');
		expect(logs.find((l) => l.evt === 'match-not-rejoined')).toMatchObject({ matchId: match.id, status: 'running' });
	});

	it('reconnecting inside the grace cancels the stop (the positive half of the same mechanism)', () => {
		vi.useFakeTimers();
		const { match } = harness(5_000);
		match.claim(ALICE);
		match.claim(BOB);
		match.seatConnected(0);
		match.seatConnected(1);
		match.seatDisconnected(0);
		match.seatDisconnected(1);

		vi.advanceTimersByTime(4_000);
		match.seatConnected(0);
		vi.advanceTimersByTime(5_001);
		expect(match.status).toBe('running');
	});
});
