/**
 * The per-person store's erase step, run the way the server runs it: registered on a real
 * `AccountErase` beside another store, over a real directory.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountErase } from '@hadoku/service-kernel/erase';
import { describe, expect, it } from 'vitest';
import { createUserStore } from '../users/store.ts';
import { fkOf } from './index.ts';
import { usersEraseStep } from './users.ts';

const USER = 'c41f9e2a-7b3d-4a8e-9c56-2f0d1b8e6a03';
const OTHER = '5b0e3c1d-2a4f-4e6b-8c9d-0f1e2d3c4b5a';

type Doc = { stars: string[] };

function served() {
	const dir = join(mkdtempSync(join(tmpdir(), 'erase-users-')), 'users');
	const store = createUserStore<Doc>({
		dir,
		shape: { empty: () => ({ stars: [] }), parse: (raw) => raw as Doc, merge: (from, into) => ({ stars: [...new Set([...into.stars, ...from.stars])] }) },
	});
	const erase = createAccountErase({ log: () => {}, edgeSealed: () => true, deriveParticipantId: fkOf });
	erase.register({ what: 'other', erase: () => 0, merge: () => 0 });
	erase.register(usersEraseStep(store));
	return { dir, store, erase };
}

describe('usersEraseStep', () => {
	it("deletes the erased person's document and nobody else's", async () => {
		const { dir, store, erase } = served();
		await store.update(USER, (d) => void d.stars.push('draft:pod-1'));
		await store.update(OTHER, (d) => void d.stars.push('draft:pod-2'));
		expect(await erase.erase(USER)).toEqual({ other: 0, users: 1 });
		expect(existsSync(join(dir, `${USER}.json`))).toBe(false);
		expect(await store.get(OTHER)).toEqual({ stars: ['draft:pod-2'] });
		// Nothing left to erase the second time.
		expect(await erase.erase(USER)).toEqual({ other: 0, users: 0 });
	});

	it("folds the merged-away account's document into the kept one", async () => {
		const { dir, store, erase } = served();
		await store.update(USER, (d) => void d.stars.push('draft:pod-1'));
		await store.update(OTHER, (d) => void d.stars.push('draft:pod-2'));
		expect(await erase.merge(USER, OTHER)).toEqual({ other: 0, users: 1 });
		expect(existsSync(join(dir, `${USER}.json`))).toBe(false);
		expect((await store.get(OTHER)).stars.sort()).toEqual(['draft:pod-1', 'draft:pod-2']);
	});
});
