/**
 * The motion ratchet: a game or an app moves through `@hadoku/ui-shell/motion` (`animate()`, `everyFrame`), so
 * its direct `.animate(` and `requestAnimationFrame(` calls may only fall. A rise fails here, naming the file; a
 * fall passes and names the one command that writes it down (`node scripts/motion/baseline.ts`).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BASELINE_PATH, CALLS, countCalls, risen, total, type Counts } from './baseline.ts';

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Counts;
const now = countCalls();

describe('motion ratchet', () => {
	for (const call of CALLS) {
		it(`no file has more ${call} than the baseline`, () => {
			const up = risen(now, baseline, call);
			if (up.length > 0) throw new Error(`${up.join('\n')}\nUse animate()/everyFrame from @hadoku/ui-shell/motion instead.`);
			if (total(now[call]) < total(baseline[call])) console.log(`motion ratchet: ${call} fell to ${total(now[call])} (baseline ${total(baseline[call])}); run \`node scripts/motion/baseline.ts\``);
		});
	}

	it('a .animate( added to a Magic file is a rise', () => {
		const file = 'games/magic/ui/src/play/live/numbers.ts';
		const added: Counts = { ...baseline, '.animate(': { ...baseline['.animate('], [file]: (baseline['.animate('][file] ?? 0) + 1 } };
		expect(risen(added, baseline, '.animate(')).toEqual([`${file}: 1 .animate( (baseline 0)`]);
	});
});
