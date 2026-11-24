/**
 * `pools/usage.ts` and the listings that join it (`GET /api/pools/cubes`, `GET /api/pools/sets`):
 * drafts from the draft record, matches from game-stats, over real express routes. game-stats is a
 * stand-in that pages the way prefs-api's `listMatches` does (newest first, `ended_at < before`,
 * `nextBefore` only on a full page, `match.<attr>` filters), one row per match.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, describe, expect, it } from 'vitest';

import type { CubeListing, CubeSummary, DraftCard, PoolUsage, SetSummary } from '@hadoku/shared';
import type { StatAttrs } from '@wolffm/prefs-client/games';
import { attachCubeRoutes, type CubeStore } from './cubes.ts';
import { attachSetRoutes, type SetsStore } from './sets.ts';
import { createPoolUsage, type DraftCounts, type MatchPages } from './usage.ts';

interface StoredMatch {
	matchId: string;
	endedAt: number;
	attrs: StatAttrs;
}

/** game-stats' `matches` read over `rows`, as prefs-api answers it. Counts its reads; `fail` makes the next ones throw. */
function statsStandIn(rows: StoredMatch[]): MatchPages & { reads: number; fail: Error | null; hang: boolean } {
	const stand = {
		reads: 0,
		fail: null as Error | null,
		hang: false,
		async matches(scope: Parameters<MatchPages['matches']>[0]) {
			stand.reads++;
			if (stand.hang) return new Promise<never>(() => undefined);
			if (stand.fail !== null) throw stand.fail;
			const limit = scope.limit ?? 20;
			const kept = [...rows]
				.filter((m) => Object.entries(scope.match ?? {}).every(([k, vs]) => vs.includes(String(m.attrs[k]))))
				.filter((m) => scope.before === undefined || m.endedAt < scope.before)
				.sort((a, b) => b.endedAt - a.endedAt || b.matchId.localeCompare(a.matchId))
				.slice(0, limit);
			return { matches: kept, nextBefore: kept.length === limit ? kept[kept.length - 1]!.endedAt : null };
		},
	};
	return stand;
}

const cubeMatch = (n: number, cube: string, endedAt: number): StoredMatch => ({ matchId: `m-${cube}-${n}`, endedAt, attrs: { source: 'cube', cube, pool: 'draft-1' } });
const setMatch = (n: number, set: string, endedAt: number): StoredMatch => ({ matchId: `m-${set}-${n}`, endedAt, attrs: { source: 'set', set } });

const drafts = (counts: Record<string, { drafts: number; lastAt: number }>): DraftCounts => ({ countBySource: () => new Map(Object.entries(counts)) });

const summary = (id: string, name: string): CubeSummary => ({
	id,
	name,
	size: 360,
	origin: 'shortlist',
	cubeCobraId: null,
	importedBy: null,
	importedAt: null,
	refreshedAt: null,
	verdict: null,
	artId: null,
});

/** The listing's own store, cut to what `GET /api/pools/cubes` reads. */
const cubeStore = (cubes: CubeSummary[]): CubeStore =>
	({ list: () => cubes, importerUser: () => null, claim: () => undefined, cards: () => [] as DraftCard[] }) as unknown as CubeStore;

const setSummary = (code: string): SetSummary => ({ code, name: code, date: '2020-01-01', type: 'expansion', cards: 250, verdict: null });
const setsStore = (sets: SetSummary[]): SetsStore => ({ list: async () => sets }) as unknown as SetsStore;

const servers: HttpServer[] = [];
afterAll(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
});

async function serve(attach: (api: express.Router) => void): Promise<string> {
	const app = express();
	const api = express.Router();
	attach(api);
	app.use('/api', api);
	const server = createServer(app);
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	servers.push(server);
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function listCubes(base: string): Promise<{ status: number; body: CubeListing[] }> {
	const res = await fetch(`${base}/api/pools/cubes`, { headers: { 'x-user-id': 'dev-alice', 'x-user-key': 'fk:alice' } });
	return { status: res.status, body: (await res.json()) as CubeListing[] };
}

const usageOf = (list: readonly { id?: string; code?: string; usage?: PoolUsage }[], key: string): PoolUsage | undefined => list.find((c) => (c.id ?? c.code) === key)?.usage;

describe('GET /api/pools/cubes joins usage', () => {
	it('answers a cube with its drafts from the draft record and its matches from game-stats', async () => {
		const stats = statsStandIn([1, 2, 3, 4, 5].map((n) => cubeMatch(n, 'cube-x', 10_000 + n)));
		const usage = createPoolUsage({ drafts: drafts({ 'cube:cube-x': { drafts: 3, lastAt: 9_000 } }), stats, log: () => undefined });
		const base = await serve((api) =>
			attachCubeRoutes(api, { store: cubeStore([summary('cube-x', 'Cube X'), summary('cube-y', 'Cube Y')]), people: { resolve: async () => new Map() }, check: async () => ({ ok: true, cards: 0 }), usage, log: () => undefined }),
		);
		const { status, body } = await listCubes(base);
		expect(status).toBe(200);
		expect(usageOf(body, 'cube-x')).toEqual({ drafts: 3, matches: 5, lastPlayedAt: 10_005 });
		// Every cube carries usage, played or not: the bar sorts on it.
		expect(usageOf(body, 'cube-y')).toEqual({ drafts: 0, matches: 0, lastPlayedAt: null });
	});

	it('counts matches across pages, newest first', async () => {
		const stats = statsStandIn(Array.from({ length: 120 }, (_, n) => cubeMatch(n, 'cube-x', 1_000 + n)));
		const usage = createPoolUsage({ drafts: drafts({}), stats, log: () => undefined });
		expect((await usage.usage()).get('cube:cube-x')).toEqual({ drafts: 0, matches: 120, lastPlayedAt: 1_119 });
		expect(stats.reads).toBe(3);
	});

	it('still lists every cube when game-stats is down, with drafts and no matches', async () => {
		const stats = statsStandIn([cubeMatch(1, 'cube-x', 10_000)]);
		stats.fail = new Error('HTTP 503');
		const logged: Record<string, unknown>[] = [];
		const usage = createPoolUsage({ drafts: drafts({ 'cube:cube-x': { drafts: 3, lastAt: 9_000 } }), stats, log: (e) => logged.push(e) });
		const base = await serve((api) =>
			attachCubeRoutes(api, { store: cubeStore([summary('cube-x', 'Cube X')]), people: { resolve: async () => new Map() }, check: async () => ({ ok: true, cards: 0 }), usage, log: () => undefined }),
		);
		const { status, body } = await listCubes(base);
		expect(status).toBe(200);
		expect(usageOf(body, 'cube-x')).toEqual({ drafts: 3, matches: 0, lastPlayedAt: 9_000 });
		expect(logged).toContainEqual({ evt: 'pool-usage-stats-failed', error: 'HTTP 503' });
	});

	it('answers without waiting on a game-stats that never answers', async () => {
		const stats = statsStandIn([]);
		stats.hang = true;
		const logged: Record<string, unknown>[] = [];
		const usage = createPoolUsage({ drafts: drafts({ 'cube:cube-x': { drafts: 1, lastAt: 5 } }), stats, log: (e) => logged.push(e), waitMs: 20 });
		expect((await usage.usage()).get('cube:cube-x')).toEqual({ drafts: 1, matches: 0, lastPlayedAt: 5 });
		expect(logged).toContainEqual({ evt: 'pool-usage-stats-failed', error: 'no answer in 20 ms' });
	});

	it('reads game-stats once per TTL, then only the matches since, and never counts one twice', async () => {
		const rows = [cubeMatch(1, 'cube-x', 100), cubeMatch(2, 'cube-x', 200)];
		const stats = statsStandIn(rows);
		let t = 0;
		const usage = createPoolUsage({ drafts: drafts({}), stats, log: () => undefined, now: () => t, ttlMs: 1_000 });
		expect((await usage.usage()).get('cube:cube-x')?.matches).toBe(2);
		rows.push(cubeMatch(3, 'cube-x', 300), cubeMatch(4, 'cube-x', 300));
		t = 500;
		expect((await usage.usage()).get('cube:cube-x')?.matches).toBe(2);
		expect(stats.reads).toBe(1);
		t = 1_500;
		expect((await usage.usage()).get('cube:cube-x')).toEqual({ drafts: 0, matches: 4, lastPlayedAt: 300 });
		// A match that ends in the same millisecond as the newest one counted is still counted, once.
		rows.push(cubeMatch(5, 'cube-x', 300));
		t = 3_000;
		expect((await usage.usage()).get('cube:cube-x')?.matches).toBe(5);
		t = 4_500;
		expect((await usage.usage()).get('cube:cube-x')?.matches).toBe(5);
	});

	it('keeps the last good count through an outage after it', async () => {
		const stats = statsStandIn([cubeMatch(1, 'cube-x', 100)]);
		let t = 0;
		const usage = createPoolUsage({ drafts: drafts({}), stats, log: () => undefined, now: () => t, ttlMs: 1_000 });
		expect((await usage.usage()).get('cube:cube-x')?.matches).toBe(1);
		stats.fail = new Error('HTTP 502');
		t = 2_000;
		expect((await usage.usage()).get('cube:cube-x')?.matches).toBe(1);
	});

	it('reads drafts afresh on every listing, so a draft that just ended counts', async () => {
		const counts = { 'cube:cube-x': { drafts: 1, lastAt: 10 } };
		const usage = createPoolUsage({ drafts: drafts(counts), stats: null, log: () => undefined });
		expect((await usage.usage()).get('cube:cube-x')?.drafts).toBe(1);
		counts['cube:cube-x'] = { drafts: 2, lastAt: 20 };
		expect((await usage.usage()).get('cube:cube-x')).toEqual({ drafts: 2, matches: 0, lastPlayedAt: 20 });
	});
});

describe('GET /api/pools/sets joins usage', () => {
	it('answers each set with its drafts and matches, constructed matches left out', async () => {
		const stats = statsStandIn([setMatch(1, 'ISD', 50), setMatch(2, 'ISD', 60), { matchId: 'm-c', endedAt: 70, attrs: { source: 'constructed', set: 'ISD' } }]);
		const usage = createPoolUsage({ drafts: drafts({ 'set:ISD': { drafts: 2, lastAt: 40 } }), stats, log: () => undefined });
		const base = await serve((api) => attachSetRoutes(api, { store: setsStore([setSummary('ISD'), setSummary('ALA')]), usage, log: () => undefined }));
		const body = (await (await fetch(`${base}/api/pools/sets`)).json()) as SetSummary[];
		expect(usageOf(body, 'ISD')).toEqual({ drafts: 2, matches: 2, lastPlayedAt: 60 });
		expect(usageOf(body, 'ALA')).toEqual({ drafts: 0, matches: 0, lastPlayedAt: null });
	});
});
