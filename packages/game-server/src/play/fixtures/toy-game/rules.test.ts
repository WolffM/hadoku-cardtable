import { describe, expect, it } from 'vitest';

import type { MatchSpec } from '../../host.js';
import { playToy, toyEngine, WIN_SCORE, type ToyLine } from './rules.js';

const SPEC: MatchSpec = { seats: [{ ai: false, name: 'Alice', deck: null }, { ai: false, name: 'Bob', deck: null }] };

describe('playToy', () => {
	it('says ready once, synchronously, before returning', () => {
		const lines: ToyLine[] = [];
		playToy(SPEC, (l) => lines.push(l));
		expect(lines).toEqual([{ t: 'ready' }]);
	});

	it('scores one point per `score` command and checkpoints after each, until a seat reaches WIN_SCORE', () => {
		const lines: ToyLine[] = [];
		const run = playToy(SPEC, (l) => lines.push(l));
		lines.length = 0;

		run.send({ t: 'score', seat: 0 });
		expect(lines).toEqual([{ t: 'scored', seat: 0, score: [1, 0] }, { t: 'checkpoint', score: [1, 0] }]);
		lines.length = 0;

		run.send({ t: 'score', seat: 1 });
		expect(lines).toEqual([{ t: 'scored', seat: 1, score: [1, 1] }, { t: 'checkpoint', score: [1, 1] }]);
		lines.length = 0;

		run.send({ t: 'score', seat: 0 });
		run.send({ t: 'score', seat: 0 });
		// The winning point: a 'checkpoint' past an over game would be a snapshot nobody can resume
		// into (the game is already decided), so there isn't one — 'over' is the last line.
		expect(lines).toEqual([
			{ t: 'scored', seat: 0, score: [2, 1] },
			{ t: 'checkpoint', score: [2, 1] },
			{ t: 'scored', seat: 0, score: [3, 1] },
			{ t: 'over', winner: 0, conceded: false, score: [3, 1] },
		]);
		expect(WIN_SCORE).toBe(3);
	});

	it('a concede ends the game at once, for the OTHER seat, whatever the score', () => {
		const lines: ToyLine[] = [];
		const run = playToy(SPEC, (l) => lines.push(l));
		run.send({ t: 'score', seat: 0 });
		lines.length = 0;
		run.send({ t: 'concede', seat: 0 });
		expect(lines).toEqual([{ t: 'over', winner: 1, conceded: true, score: [1, 0] }]);
	});

	it('nothing is said once the game is over, including a second concede or stop()', () => {
		const lines: ToyLine[] = [];
		const run = playToy(SPEC, (l) => lines.push(l));
		run.send({ t: 'score', seat: 0 });
		run.send({ t: 'score', seat: 0 });
		run.send({ t: 'score', seat: 0 });
		lines.length = 0;
		run.send({ t: 'score', seat: 1 });
		run.send({ t: 'concede', seat: 1 });
		run.stop();
		expect(lines).toEqual([]);
	});
});

describe('toyEngine (the InProcessEngine wrap)', () => {
	it('is playToy under runtimes/in-process.ts’s seam: matchId is ignored, spec and line pass straight through', () => {
		const lines: ToyLine[] = [];
		const run = toyEngine().start('m-1', SPEC, (l) => lines.push(l));
		expect(lines).toEqual([{ t: 'ready' }]);
		run.send({ t: 'score', seat: 1 });
		expect(lines).toEqual([{ t: 'ready' }, { t: 'scored', seat: 1, score: [0, 1] }, { t: 'checkpoint', score: [0, 1] }]);
	});
});
