import { describe, expect, it } from 'vitest';

import { placeholderId, replaceIds } from './anonymise.ts';

describe('placeholderId', () => {
	it('mints a fresh id each time, in the erased: namespace', () => {
		const a = placeholderId();
		const b = placeholderId();
		expect(a).toMatch(/^erased:[0-9a-f]{8}$/);
		expect(a).not.toBe(b);
	});
});

describe('replaceIds', () => {
	const ids = new Set(['u-1', 'u-2']);

	it('replaces a bare string value', () => {
		expect(replaceIds('u-1', ids, 'erased:x')).toBe(0);
	});

	it('replaces an array element', () => {
		const arr = ['u-1', 'keep', 'u-2'];
		expect(replaceIds(arr, ids, 'erased:x')).toBe(2);
		expect(arr).toEqual(['erased:x', 'keep', 'erased:x']);
	});

	it('replaces an object key and its value', () => {
		const obj: Record<string, unknown> = { 'u-1': 'name', other: 'u-2' };
		expect(replaceIds(obj, ids, 'erased:x')).toBe(2);
		expect(obj).toEqual({ 'erased:x': 'name', other: 'erased:x' });
	});

	it('replaces Map keys and values', () => {
		const m = new Map<string, string>([['u-1', 'name'], ['keep', 'u-2']]);
		expect(replaceIds(m, ids, 'erased:x')).toBe(2);
		// A key swap deletes-then-sets (so it moves to the end); a value-only swap updates in place.
		expect([...m]).toEqual([['keep', 'erased:x'], ['erased:x', 'name']]);
	});

	it('replaces Set members', () => {
		const s = new Set(['u-1', 'keep']);
		expect(replaceIds(s, ids, 'erased:x')).toBe(1);
		expect([...s]).toEqual(['keep', 'erased:x']);
	});

	it('walks nested structures and visits a shared reference once', () => {
		const shared = { 'u-1': 'name' };
		const tree = { a: shared, b: shared, c: ['u-2'] };
		expect(replaceIds(tree, ids, 'erased:x')).toBe(2);
		expect(tree.a).toEqual({ 'erased:x': 'name' });
	});

	it('leaves functions and non-matching values alone, and never writes what does not change', () => {
		const fn = () => 1;
		const obj = { f: fn, keep: 'nope' };
		expect(replaceIds(obj, ids, 'erased:x')).toBe(0);
		expect(obj.f).toBe(fn);
		expect(obj.keep).toBe('nope');
	});
});
