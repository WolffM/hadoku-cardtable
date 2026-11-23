import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUserStore, isStorableUserId, type UserDocShape } from './store.ts';

/** A document with a counter and a set of tags, enough to see a merge and a lost write. */
interface Doc {
	n: number;
	tags: Record<string, true>;
}
const shape: UserDocShape<Doc> = {
	empty: () => ({ n: 0, tags: {} }),
	parse: (raw) => {
		const d = raw as Partial<Doc>;
		if (typeof d.n !== 'number' || typeof d.tags !== 'object' || d.tags === null) throw new Error('not a doc');
		return d as Doc;
	},
	merge: (from, into) => ({ n: into.n, tags: { ...from.tags, ...into.tags } }),
};

const USER = 'c41f9e2a-7b3d-4a8e-9c56-2f0d1b8e6a03';
const OTHER = '5b0e3c1d-2a4f-4e6b-8c9d-0f1e2d3c4b5a';

function open(): { dir: string; logs: Record<string, unknown>[]; store: ReturnType<typeof createUserStore<Doc>> } {
	const dir = join(mkdtempSync(join(tmpdir(), 'users-')), 'users');
	const logs: Record<string, unknown>[] = [];
	return { dir, logs, store: createUserStore({ dir, shape, log: (e) => logs.push(e) }) };
}

describe('createUserStore', () => {
	it('answers an empty document for a person it has never written, without writing one', async () => {
		const { dir, store } = open();
		expect(await store.get(USER)).toEqual({ n: 0, tags: {} });
		expect(existsSync(dir)).toBe(false);
	});

	it("writes one file per person, under their userId, and leaves no temp file", async () => {
		const { dir, store } = open();
		await store.update(USER, (d) => {
			d.n = 3;
		});
		await store.update(OTHER, () => ({ n: 7, tags: { a: true } }));
		expect(readdirSync(dir).sort()).toEqual([`${OTHER}.json`, `${USER}.json`]);
		expect(JSON.parse(readFileSync(join(dir, `${USER}.json`), 'utf8'))).toEqual({ n: 3, tags: {} });
		expect(await store.get(OTHER)).toEqual({ n: 7, tags: { a: true } });
	});

	it('keeps every one of many updates that land at once', async () => {
		const { store } = open();
		await Promise.all(
			Array.from({ length: 40 }, (_, i) =>
				store.update(USER, (d) => {
					d.n += 1;
					d.tags[`t${i}`] = true;
				}),
			),
		);
		const doc = await store.get(USER);
		expect(doc.n).toBe(40);
		expect(Object.keys(doc.tags)).toHaveLength(40);
	});

	it('moves an unreadable file aside, logs it, and starts the person afresh', async () => {
		const { dir, logs, store } = open();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${USER}.json`), '{"n": 1, "tags"');
		expect(await store.get(USER)).toEqual({ n: 0, tags: {} });
		const aside = readdirSync(dir).filter((f) => f.startsWith(`${USER}.json.unreadable-`));
		expect(aside).toHaveLength(1);
		expect(readFileSync(join(dir, aside[0]!), 'utf8')).toBe('{"n": 1, "tags"');
		expect(logs).toEqual([expect.objectContaining({ evt: 'user-doc-unreadable', userId: USER })]);
	});

	it('never makes a file name from something that is not a userId', async () => {
		const { store } = open();
		for (const bad of ['../etc/passwd', 'a/b', '', '.hidden', 'x'.repeat(129)]) {
			expect(isStorableUserId(bad)).toBe(false);
			await expect(store.get(bad)).rejects.toThrow(/not a userId/);
			await expect(store.update(bad, () => undefined)).rejects.toThrow(/not a userId/);
			expect(await store.remove(bad)).toBe(0);
		}
	});

	it("removes a person's document, answering 1 once and 0 after", async () => {
		const { dir, store } = open();
		await store.update(USER, (d) => void (d.n = 1));
		expect(await store.remove(USER)).toBe(1);
		expect(existsSync(join(dir, `${USER}.json`))).toBe(false);
		expect(await store.remove(USER)).toBe(0);
	});

	it("folds one person's document into another's, the kept one winning, and deletes it", async () => {
		const { dir, store } = open();
		await store.update(USER, () => ({ n: 1, tags: { mine: true } }));
		await store.update(OTHER, () => ({ n: 2, tags: { theirs: true } }));
		expect(await store.move(USER, OTHER)).toBe(1);
		expect(await store.get(OTHER)).toEqual({ n: 2, tags: { mine: true, theirs: true } });
		expect(existsSync(join(dir, `${USER}.json`))).toBe(false);
		expect(await store.move(USER, OTHER)).toBe(0);
	});
});
