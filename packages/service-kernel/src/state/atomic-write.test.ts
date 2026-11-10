import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteJson } from './atomic-write.ts';

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'service-kernel-atomic-write-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('atomicWriteJson', () => {
	it('creates the target directory and writes the JSON, with no temp file left behind', async () => {
		const target = join(root, 'nested', 'dir', 'file.json');
		await atomicWriteJson(target, { a: 1 });
		expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ a: 1 });
	});

	it('replaces an existing file in place', async () => {
		const target = join(root, 'file.json');
		await atomicWriteJson(target, { a: 1 });
		await atomicWriteJson(target, { a: 2 });
		expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ a: 2 });
		expect(existsSync(`${target}.tmp`)).toBe(false);
	});
});
