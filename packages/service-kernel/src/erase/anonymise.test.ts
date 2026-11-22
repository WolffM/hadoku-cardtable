import { describe, expect, it } from 'vitest';

import { moveIds, namesAny, placeholderId, renameIds, replaceIds } from './anonymise.ts';

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

describe('renameIds', () => {
	const renames = new Map([
		['u-1', 'u-2'],
		['fk:u-1', 'fk:u-2'],
	]);

	it('renames each id to its own counterpart, as a value, an element, a key, a Map entry and a Set member', () => {
		const value = {
			by: 'u-1',
			seats: ['fk:u-1', 'fk:bob'],
			names: { 'fk:u-1': 'Alice' } as Record<string, string>,
			map: new Map([['fk:u-1', 'u-1']]),
			set: new Set(['u-1']),
		};
		expect(renameIds(value, renames)).toBe(6);
		expect(value).toEqual({ by: 'u-2', seats: ['fk:u-2', 'fk:bob'], names: { 'fk:u-2': 'Alice' }, map: new Map([['fk:u-2', 'u-2']]), set: new Set(['u-2']) });
		expect(renameIds(value, renames)).toBe(0);
	});

	it('keeps the entry already there when a renamed key meets it: the kept account is never overwritten', () => {
		const decks: Record<string, string> = { 'fk:u-1': 'theirs', 'fk:u-2': 'kept' };
		const map = new Map([
			['fk:u-1', 'theirs'],
			['fk:u-2', 'kept'],
		]);
		const set = new Set(['u-1', 'u-2']);
		expect(renameIds({ decks, map, set }, renames)).toBe(3);
		expect(decks).toEqual({ 'fk:u-2': 'kept' });
		expect([...map]).toEqual([['fk:u-2', 'kept']]);
		expect([...set]).toEqual(['u-2']);
	});
});

describe('namesAny', () => {
	it('finds an id as a value, a key, a Map key or value and a Set member, and writes nothing', () => {
		const ids = new Set(['u-2']);
		expect(namesAny({ a: [{ b: 'u-2' }] }, ids)).toBe(true);
		expect(namesAny({ 'u-2': 1 }, ids)).toBe(true);
		expect(namesAny(new Map([['k', 'u-2']]), ids)).toBe(true);
		expect(namesAny(new Map([['u-2', 'v']]), ids)).toBe(true);
		expect(namesAny(new Set(['u-2']), ids)).toBe(true);
		expect(namesAny({ a: 'u-1', b: ['x'] }, ids)).toBe(false);
		expect(namesAny('u-2', ids)).toBe(false);
	});
});

describe('moveIds', () => {
	const move = {
		into: { ids: new Set(['u-2', 'fk:u-2']) },
		renames: new Map([
			['u-1', 'u-2'],
			['fk:u-1', 'fk:u-2'],
		]),
	};

	it("moves a record that names only the merged-away account to the kept one", () => {
		const room = { leader: 'fk:u-1', members: [{ id: 'fk:u-1', userId: 'u-1' }, { id: 'fk:bob', userId: 'bob' }] };
		expect(moveIds(room, move)).toBe(3);
		expect(room).toEqual({ leader: 'fk:u-2', members: [{ id: 'fk:u-2', userId: 'u-2' }, { id: 'fk:bob', userId: 'bob' }] });
	});

	it('leaves a record that already names the kept account: the conflict is the kept account\'s', () => {
		const match = { seats: ['fk:u-1', 'fk:u-2'] };
		expect(moveIds(match, move)).toBe(0);
		expect(match).toEqual({ seats: ['fk:u-1', 'fk:u-2'] });
	});
});
