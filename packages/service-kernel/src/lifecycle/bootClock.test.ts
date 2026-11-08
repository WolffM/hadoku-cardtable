import { describe, expect, it } from 'vitest';
import { bootClock } from './bootClock.ts';

describe('bootClock', () => {
	it('logs one boot-phase line per call, each with a phase, ms and at', () => {
		const logged: Record<string, unknown>[] = [];
		const phase = bootClock((e) => logged.push(e));
		phase('imports');
		phase('bundle');
		phase('listen');
		expect(logged.map((e) => e.evt)).toEqual(['boot-phase', 'boot-phase', 'boot-phase']);
		expect(logged.map((e) => e.phase)).toEqual(['imports', 'bundle', 'listen']);
		for (const e of logged) {
			expect(typeof e.ms).toBe('number');
			expect(typeof e.at).toBe('number');
			expect(e.ms as number).toBeGreaterThanOrEqual(0);
		}
	});

	it('two clocks time independently', () => {
		const a: Record<string, unknown>[] = [];
		const b: Record<string, unknown>[] = [];
		const phaseA = bootClock((e) => a.push(e));
		const phaseB = bootClock((e) => b.push(e));
		phaseA('one');
		phaseB('one');
		expect(a).toHaveLength(1);
		expect(b).toHaveLength(1);
	});
});
