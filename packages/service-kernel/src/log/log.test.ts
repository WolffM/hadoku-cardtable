import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonLogger } from './log.ts';

describe('jsonLogger', () => {
	let logged: string[] = [];
	beforeEach(() => {
		logged = [];
		vi.spyOn(console, 'log').mockImplementation((line: string) => void logged.push(line));
		vi.useFakeTimers().setSystemTime(new Date('2026-11-07T12:00:00.000Z'));
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('writes one JSON object per call: a timestamp, the given service, then the entry', () => {
		jsonLogger('some-svc')({ evt: 'thing-happened', n: 1 });
		expect(logged).toHaveLength(1);
		expect(JSON.parse(logged[0]!)).toEqual({ t: '2026-11-07T12:00:00.000Z', svc: 'some-svc', evt: 'thing-happened', n: 1 });
	});

	it('names a different service for a different logger, independently', () => {
		jsonLogger('a')({ x: 1 });
		jsonLogger('b')({ x: 2 });
		expect(JSON.parse(logged[0]!).svc).toBe('a');
		expect(JSON.parse(logged[1]!).svc).toBe('b');
	});
});
