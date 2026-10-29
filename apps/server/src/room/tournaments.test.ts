import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Tournament } from '@hadoku/shared';

import { openTournaments } from './tournaments.ts';

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function fileIn(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-tournaments-'));
	dirs.push(dir);
	return join(dir, 'data', 'tournaments.json');
}

const t = (id: string, endedAt: number, over: Partial<Tournament> = {}): Tournament => ({
	id,
	name: id,
	startedAt: endedAt - 1000,
	endedAt,
	closed: false,
	rounds: 1,
	names: {},
	standings: [],
	results: [],
	...over,
});

/** Until the store's queued writes have landed: the file holds `count` records. An earlier write can land first. */
async function written(file: string, count: number): Promise<void> {
	await vi.waitFor(async () => expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(count));
}

describe('the tournaments store', () => {
	it('lists newest first, keeps the first record for an id, and reads back after a restart', async () => {
		const file = await fileIn();
		const store = await openTournaments(file, () => {});
		store.record(t('a', 1));
		store.record(t('b', 3));
		store.record(t('a', 5, { closed: true }));
		expect(store.list().map((x) => [x.id, x.closed])).toEqual([
			['b', false],
			['a', false],
		]);
		await written(file, 2);
		const reopened = await openTournaments(file, () => {});
		expect(reopened.list().map((x) => x.id)).toEqual(['b', 'a']);
	});

	it('opens empty with no file, and drops a record it cannot read', async () => {
		const file = await fileIn();
		expect((await openTournaments(file, () => {})).list()).toEqual([]);
		const logged: Record<string, unknown>[] = [];
		const store = await openTournaments(file, () => {});
		store.record(t('a', 1));
		await written(file, 1);
		await writeFile(file, JSON.stringify([t('a', 1), { id: 'broken' }]));
		const reopened = await openTournaments(file, (e) => void logged.push(e));
		expect(reopened.list().map((x) => x.id)).toEqual(['a']);
		expect(logged).toContainEqual({ event: 'tournaments-dropped', dropped: 1 });
	});
});
