import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { capacitySampler } from './capacity.ts';
import { PRESSURE_STALE_MS, readHostPressure, type HostPressure } from './host-pressure.ts';
import type { TelemetryContext } from '../telemetry/telemetry.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T = Date.parse('2026-11-28T14:35:30.000Z');
/** fleet-manager's `host-pressure.json`, as it wrote it on hokon at 14:35:26Z. */
const written = (over: Record<string, unknown> = {}) => ({
	at: '2026-11-28T14:35:26.629Z',
	level: 'ok',
	since: null,
	reasons: [],
	unreadable: [],
	lines: { prodIoSome: 30, prodMemSome: 10, hostIoFull: 50, hostMemSome: 20 },
	sample: { host: { io: { some10: 0.49, full10: 0.35 }, mem: { some10: 0, full10: 0 } }, prod: { cgroup: '/system.slice/pm2-hadoku.service', io: { some10: 0, full10: 0 }, mem: { some10: 0, full10: 0 } } },
	...over,
});
function file(body: unknown): string {
	const d = mkdtempSync(join(tmpdir(), 'pressure-'));
	dirs.push(d);
	const f = join(d, 'host-pressure.json');
	writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
	return f;
}

describe('readHostPressure', () => {
	it("reads fleet-manager's level, reasons and the PSI it sampled", () => {
		const warn = written({ level: 'warn', since: '2026-11-28T14:35:20.000Z', reasons: ['host io full 61 ≥ 50'] });
		expect(readHostPressure(file(warn), T)).toEqual({
			level: 'warn',
			why: null,
			since: '2026-11-28T14:35:20.000Z',
			reasons: ['host io full 61 ≥ 50'],
			psi: { hostIoFull: 0.35, hostMemSome: 0, prodIoSome: 0, prodMemSome: 0 },
		});
		expect(readHostPressure(file(written()), T).level).toBe('ok');
	});

	it('never reads a missing, stale, torn or partly unreadable file as calm: it is unknown', () => {
		expect(readHostPressure('/nonexistent/host-pressure.json', T)).toMatchObject({ level: 'unknown', why: 'no file' });
		expect(readHostPressure(file(written()), Date.parse('2026-11-28T14:35:26.629Z') + PRESSURE_STALE_MS + 1)).toMatchObject({ level: 'unknown', why: 'stale: written 60 s ago' });
		expect(readHostPressure(file('{"at": "2026-11-28T14:3'), T)).toMatchObject({ level: 'unknown', why: 'unreadable' });
		expect(readHostPressure(file(written({ unreadable: ['/proc/pressure/io'] })), T)).toMatchObject({ level: 'unknown', why: 'fleet-manager could not read /proc/pressure/io' });
		expect(readHostPressure(file(written({ level: 'calm' })), T)).toMatchObject({ level: 'unknown', why: 'level calm' });
	});
});

describe('capacitySampler host pressure', () => {
	it("carries the window's worst level and reasons in the capacity event, and reports each change once, quietly", () => {
		const events: [string, TelemetryContext, string | undefined][] = [];
		let t = 0;
		const reads: HostPressure[] = [
			{ level: 'ok', why: null, since: null, reasons: [], psi: null },
			{ level: 'warn', why: null, since: 'x', reasons: ['prod mem some 14 ≥ 10'], psi: null },
			{ level: 'warn', why: null, since: 'x', reasons: ['prod mem some 14 ≥ 10'], psi: null },
			{ level: 'unknown', why: 'no file', since: null, reasons: [], psi: null },
		];
		let i = 0;
		const sampler = capacitySampler({
			gauges: {},
			report: (e, c, l) => events.push([e, c, l]),
			now: () => t,
			memory: () => ({ rss: 0, heapUsed: 0 }),
			pressure: () => reads[Math.min(i++, reads.length - 1)]!,
		});
		for (let n = 0; n < 4; n++) sampler.sample();
		t = 300_000;
		sampler.flush();
		sampler.stop();
		const changes = events.filter(([e]) => e === 'host-pressure');
		expect(changes.map(([, c, l]) => [c.level, c.from, l])).toEqual([
			['warn', 'ok', 'info'],
			['unknown', 'warn', 'info'],
		]);
		expect(changes[0]![1].reasons).toEqual(['prod mem some 14 ≥ 10']);
		const capacity = events.find(([e]) => e === 'capacity')![1];
		expect(capacity.hostPressure).toEqual({ worst: 'warn', ok: 1, warn: 2, unknown: 1, reasons: ['prod mem some 14 ≥ 10'], now: 'unknown', why: 'no file' });
	});
});
