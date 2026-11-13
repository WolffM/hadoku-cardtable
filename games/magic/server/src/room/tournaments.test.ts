import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Tournament } from '@hadoku/shared';

import { openTournaments, withStandings, writeTournaments } from './tournaments.ts';

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
		expect((await store.list()).map((x) => [x.id, x.closed])).toEqual([
			['b', false],
			['a', false],
		]);
		await written(file, 2);
		const reopened = await openTournaments(file, () => {});
		expect((await reopened.list()).map((x) => x.id)).toEqual(['b', 'a']);
	});

	it('opens empty with no file, and drops a record it cannot read', async () => {
		const file = await fileIn();
		expect(await (await openTournaments(file, () => {})).list()).toEqual([]);
		const logged: Record<string, unknown>[] = [];
		const store = await openTournaments(file, () => {});
		store.record(t('a', 1));
		await written(file, 1);
		await writeFile(file, JSON.stringify([t('a', 1), { id: 'broken' }]));
		const reopened = await openTournaments(file, (e) => void logged.push(e));
		expect((await reopened.list()).map((x) => x.id)).toEqual(['a']);
		expect(logged).toContainEqual({ event: 'tournaments-dropped', dropped: 1 });
	});
});

const won = (round: number, a: string, b: string, gamesA = 2, gamesB = 0) => ({ round, playerA: a, playerB: b, gamesA, gamesB });

describe('an edit made to the file while the server runs', () => {
	it('is what the next list serves, with no reopen', async () => {
		const file = await fileIn();
		const store = await openTournaments(file, () => {});
		store.record(t('pod', 1));
		expect((await store.list())[0]?.name).toBe('pod');
		await writeTournaments(file, [t('pod', 1, { name: 'Renamed' })]);
		expect((await store.list())[0]?.name).toBe('Renamed');
	});

	it('survives the server recording the next tournament, rather than being written over', async () => {
		const file = await fileIn();
		const store = await openTournaments(file, () => {});
		store.record(t('pod', 1));
		await written(file, 1);
		await writeTournaments(file, [t('pod', 1, { name: 'Renamed' })]);
		store.record(t('next', 2));
		await written(file, 2);
		const saved = JSON.parse(await readFile(file, 'utf8')) as Tournament[];
		expect(saved.map((x) => [x.id, x.name])).toEqual([
			['pod', 'Renamed'],
			['next', 'next'],
		]);
	});
});

describe('re-ranking a record from its results', () => {
	// Three rounds leave a and b level on 6 points; a has the better tiebreakers.
	const swiss = [won(1, 'a', 'c'), won(1, 'b', 'd'), won(2, 'a', 'd'), won(2, 'c', 'b', 2, 1), won(3, 'd', 'a', 2, 1), won(3, 'b', 'c')];
	const played = withStandings(t('pod', 1, { rounds: 3, results: swiss }));

	it('ranks every entrant the results name', () => {
		expect(played.standings.slice(0, 2).map((s) => [s.id, s.matchPoints, s.rank])).toEqual([
			['a', 6, 1],
			['b', 6, 2],
		]);
		expect(played.standings.slice(2).map((s) => [s.matchPoints, s.rank])).toEqual([
			[3, 3],
			[3, 4],
		]);
		expect(played.standings.slice(2).map((s) => s.id).sort()).toEqual(['c', 'd']);
	});

	it('counts a playoff added after the pod ended: its winner goes first, and the rounds count it', () => {
		const playoff = withStandings({ ...played, results: [...played.results, won(4, 'b', 'a', 2, 1)] });
		expect(playoff.rounds).toBe(4);
		expect(playoff.standings.slice(0, 2).map((s) => [s.id, s.matchPoints, s.rank])).toEqual([
			['b', 9, 1],
			['a', 6, 2],
		]);
	});

	it('keeps an entrant who no longer appears in any result', () => {
		const dropped = withStandings({ ...played, results: played.results.filter((r) => r.playerA !== 'd' && r.playerB !== 'd') });
		expect(dropped.standings.map((s) => s.id).sort()).toEqual(['a', 'b', 'c', 'd']);
	});
});

describe('account erase in the tournaments', () => {
	it('names the placeholder, with no name, wherever a tournament named the person, and saves before answering', async () => {
		const file = await fileIn();
		const store = await openTournaments(file, () => {});
		store.record(
			t('pod', 1, {
				names: { 'fk:alice': 'Alice', 'fk:bob': 'Bob' },
				standings: [
					{ id: 'fk:alice', matchPoints: 3, opponentMatchWinPct: 0, gameWinPct: 1, opponentGameWinPct: 0, medianGameMs: null, rank: 1, decidedBy: null },
					{ id: 'fk:bob', matchPoints: 0, opponentMatchWinPct: 1, gameWinPct: 0, opponentGameWinPct: 1, medianGameMs: null, rank: 2, decidedBy: null },
				],
			}),
		);
		store.record(t('other', 2, { names: { 'fk:bob': 'Bob' } }));

		expect(await store.anonymise(new Set(['fk:alice', 'uid-alice']), 'erased:0a1b2c3d')).toBe(1);
		const saved = await readFile(file, 'utf8');
		expect(saved).not.toContain('fk:alice');
		expect(saved).not.toContain('Alice');
		const pod = (JSON.parse(saved) as Tournament[]).find((x) => x.id === 'pod')!;
		expect(pod.names).toEqual({ 'fk:bob': 'Bob', 'erased:0a1b2c3d': '' });
		expect(pod.standings.map((s) => s.id)).toEqual(['erased:0a1b2c3d', 'fk:bob']);
		expect(await store.anonymise(new Set(['fk:alice', 'uid-alice']), 'erased:ffffffff')).toBe(0);
	});
});
