import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ACTIONS_RETENTION_MS, PUBLIC_RETENTION_MS, sweepRecordings } from './retention.js';

let dir: string;

afterEach(() => {
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function write(name: string, bytes: number, ageMs: number): void {
	writeFileSync(join(dir, name), 'x'.repeat(bytes));
	const at = new Date(Date.now() - ageMs);
	utimesSync(join(dir, name), at, at);
}

describe('sweepRecordings', () => {
	it('leaves a fresh pair of files alone', () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recordings-'));
		write('m-1.actions.jsonl.gz', 100, 1000);
		write('m-1.public.jsonl.gz', 100, 1000);
		const result = sweepRecordings(dir);
		expect(result.expiredActions).toEqual([]);
		expect(result.expiredPublic).toEqual([]);
		expect(readdirSync(dir).sort()).toEqual(['m-1.actions.jsonl.gz', 'm-1.public.jsonl.gz']);
	});

	it('expires a public stream past 7 days but keeps its action log, which is good for 90', () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recordings-'));
		write('m-1.actions.jsonl.gz', 100, PUBLIC_RETENTION_MS + 1000);
		write('m-1.public.jsonl.gz', 100, PUBLIC_RETENTION_MS + 1000);
		const result = sweepRecordings(dir);
		expect(result.expiredPublic).toEqual(['m-1.public.jsonl.gz']);
		expect(result.expiredActions).toEqual([]);
		expect(readdirSync(dir)).toEqual(['m-1.actions.jsonl.gz']);
	});

	it('expires an action log past 90 days', () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recordings-'));
		write('m-1.actions.jsonl.gz', 100, ACTIONS_RETENTION_MS + 1000);
		const result = sweepRecordings(dir);
		expect(result.expiredActions).toEqual(['m-1.actions.jsonl.gz']);
		expect(readdirSync(dir)).toEqual([]);
	});

	it('ignores a file that is not one of ours', () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recordings-'));
		write('something-else.txt', 100, ACTIONS_RETENTION_MS + 1000);
		const result = sweepRecordings(dir);
		expect(result.errors).toEqual([]);
		expect(readdirSync(dir)).toEqual(['something-else.txt']);
	});

	it('drops the oldest PUBLIC streams first when the directory is over the cap, never an action log', () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recordings-'));
		write('m-old.public.jsonl.gz', 600, 3000);
		write('m-old.actions.jsonl.gz', 10, 3000);
		write('m-new.public.jsonl.gz', 600, 1000);
		write('m-new.actions.jsonl.gz', 10, 1000);
		const result = sweepRecordings(dir, Date.now(), () => undefined, 1000);
		expect(result.overCap).toEqual(['m-old.public.jsonl.gz']);
		const left = readdirSync(dir).sort();
		expect(left).toEqual(['m-new.actions.jsonl.gz', 'm-new.public.jsonl.gz', 'm-old.actions.jsonl.gz']);
	});

	it('is quiet and returns bytesAfter 0 for a directory that does not exist', () => {
		const result = sweepRecordings('/nonexistent/cardtable-recordings-missing');
		expect(result.bytesAfter).toBe(0);
		expect(result.errors.length).toBe(1);
	});
});
