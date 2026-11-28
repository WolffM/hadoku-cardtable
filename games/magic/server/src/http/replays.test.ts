/**
 * `/api/replays` end to end through a real express app, same harness shape as `trim.test.ts`:
 * fixture `.gz` files written straight to a temp directory, exactly as the recorder would leave them.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import express from 'express';
import { identityFromHeaders } from '@hadoku/game-server/room/identity';
import { UNNAMED } from '@hadoku/game-server/room/constants';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DELTA_TYPE, deltaKeyType } from '@hadoku/forge-wire';
import { REPLAY_BODY_VERSION } from '@hadoku/shared';
import type { ArtIds } from '../play/art-ids.ts';
import { fixtureFrames } from '../play/fixtures/transcript.ts';
import { createProjector, EVERY_PLAYER, type StateFrame } from '../play/visibility.ts';

const EDGE_SECRET = 'test-edge-auth-secret';

let replaysMod: typeof import('./replays.ts');
let edgeMod: typeof import('@hadoku/game-server/edge-auth');
// Loaded with the route, after the module reset: each writer must tell the same change listeners the route's index heard.
let personOf: typeof import('@hadoku/game-server/erase/index').personOf;
let recordingsStep: typeof import('@hadoku/game-server/erase/recordings').recordingsStep;
let sweepRecordings: typeof import('@hadoku/game-server/play/recording/retention').sweepRecordings;
let createMatchRecordingWriter: typeof import('@hadoku/game-server/play/recording/writer').createMatchRecordingWriter;
let keepEarlierEpoch: typeof import('@hadoku/game-server/play/recording/writer').keepEarlierEpoch;
let writePublicStream: typeof import('../play/recording/rebuild.ts').writePublicStream;

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	replaysMod = await import('./replays.ts');
	edgeMod = await import('@hadoku/game-server/edge-auth');
	({ personOf } = await import('@hadoku/game-server/erase/index'));
	({ recordingsStep } = await import('@hadoku/game-server/erase/recordings'));
	({ sweepRecordings } = await import('@hadoku/game-server/play/recording/retention'));
	({ createMatchRecordingWriter, keepEarlierEpoch } = await import('@hadoku/game-server/play/recording/writer'));
	({ writePublicStream } = await import('../play/recording/rebuild.ts'));
});

const dirs: string[] = [];
const servers: HttpServer[] = [];
let logged: Record<string, unknown>[] = [];
let testingRooms = new Set<string>();

afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
	logged = [];
	testingRooms = new Set();
});
afterAll(async () => {
	await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function openApp(dir: string, extra: Partial<Parameters<typeof replaysMod.attachReplays>[1]> = {}): Promise<string> {
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json({ limit: '1mb' }));
	replaysMod.attachReplays(api, { dir, isTesting: (roomId) => roomId !== null && testingRooms.has(roomId), log: (entry) => logged.push(entry), ...extra });
	app.use('/api', api);
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function recordingsDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-replays-test-'));
	dirs.push(dir);
	return dir;
}

function writeGz(path: string, lines: unknown[]): void {
	writeFileSync(path, gzipSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')));
}

function writePublic(dir: string, matchId: string, opts: { roomId?: string | null; winner?: 0 | 1 | null; startedAt?: string; envs?: unknown[]; v?: number; seats?: unknown[]; ai?: [boolean, boolean]; art?: unknown[] } = {}): void {
	writeGz(join(dir, `${matchId}.public.jsonl.gz`), [
		{ t: 'header', v: opts.v ?? 2, matchId, roomId: opts.roomId ?? null, players: ['A', 'B'], ai: opts.ai ?? [false, false], decks: [null, null], ...(opts.art === undefined ? {} : { art: opts.art }), startedAt: opts.startedAt ?? '2026-01-01T00:00:00.000Z' },
		...(opts.envs ?? [{ t: 'env', at: 0, env: { matchId, cursor: { epoch: 'e', seq: 1 }, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [0] } } } }]),
		{ t: 'end', endedAt: '2026-01-01T00:10:00.000Z', winner: opts.winner ?? null, ...(opts.seats === undefined ? {} : { seats: opts.seats }) },
	]);
}

function writeActionsOnly(dir: string, matchId: string, opts: { roomId?: string | null; startedAt?: string; seats?: unknown } = {}): void {
	writeGz(join(dir, `${matchId}.actions.jsonl.gz`), [
		{
			t: 'header',
			v: 1,
			matchId,
			roomId: opts.roomId ?? null,
			pin: 'abc',
			bridge: 'def',
			server: '0.0.0',
			startedAt: opts.startedAt ?? '2026-01-01T00:00:00.000Z',
			spec: { seed: 1, seats: opts.seats === undefined ? [{ name: 'A', ai: false }, { name: 'B', ai: false }] : opts.seats },
		},
		{ t: 'cmd', seat: 0, board: 'b', prompt: 'p', cmd: { t: 'act', seat: 0, frame: { method: 'selectButtonOk' } } },
		{ t: 'end', endedAt: '2026-01-01T00:05:00.000Z', reason: 'clean' },
	]);
}

async function call(base: string, path: string, tier = 'friend', body?: unknown, user = 'u-1'): Promise<{ status: number; json: Record<string, unknown>; cache: string | null }> {
	const headers: Record<string, string> = { 'x-edge-auth': EDGE_SECRET, 'x-hadoku-tier': tier, 'x-user-id': user, 'x-user-name': 'u-1', 'x-user-key': 'k' };
	const res = await fetch(`${base}${path}`, body === undefined ? { headers } : { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const text = await res.text();
	return { status: res.status, json: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>, cache: res.headers.get('cache-control') };
}

describe('GET /api/replays', () => {
	it('is empty for an empty directory', async () => {
		const base = await openApp(await recordingsDir());
		expect(await call(base, '/api/replays')).toEqual({ status: 200, json: { replays: [] }, cache: 'private, max-age=15' });
	});

	it('lists a finished match whose public stream is on disk, source "stream"', async () => {
		const dir = await recordingsDir();
		writePublic(dir, 'm-1', { roomId: 'r-1', winner: 1 });
		const base = await openApp(dir);
		const { status, json } = await call(base, '/api/replays');
		expect(status).toBe(200);
		expect(json.replays).toEqual([{ matchId: 'm-1', roomId: 'r-1', players: ['A', 'B'], decks: [null, null], startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:10:00.000Z', winner: 1, source: 'stream', pace: { envs: 1, durationMs: 0, waitMs: 0 } }]);
	});

	it('lists a restored match’s earlier epoch by its own id, which its header still names the match by', async () => {
		const dir = await recordingsDir();
		writePublic(dir, 'm-1', { startedAt: '2026-01-01T00:00:00.000Z' });
		writeGz(join(dir, 'm-1-e1.public.jsonl.gz'), [
			{ t: 'header', v: 2, matchId: 'm-1', roomId: null, players: ['A', 'B'], ai: [false, false], decks: [null, null], startedAt: '2026-01-01T00:00:00.000Z' },
			{ t: 'env', at: 0, env: { matchId: 'm-1', cursor: { epoch: 'e', seq: 1 }, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [0] } } } },
			{ t: 'end', endedAt: '2026-01-01T00:04:00.000Z', winner: null },
		]);
		const base = await openApp(dir);
		const ids = ((await call(base, '/api/replays')).json.replays as { matchId: string }[]).map((r) => r.matchId).sort();
		expect(ids).toEqual(['m-1', 'm-1-e1']);
		expect((await call(base, '/api/replays/m-1-e1')).status).toBe(200);
	});

	it("measures each stream's pace: its frames, their span, and the gaps over five seconds", async () => {
		const dir = await recordingsDir();
		const env = (at: number): unknown => ({ t: 'env', at, env: { matchId: 'm-1', cursor: { epoch: 'e', seq: at }, frame: { kind: 'notify' } } });
		const presence = { t: 'presence', at: 3_000, seat: 0, playerId: 1, presence: {} };
		writePublic(dir, 'm-1', { envs: [env(1_000), env(2_000), presence, env(9_000), env(10_000), env(40_000)] });
		const base = await openApp(dir);
		const { json } = await call(base, '/api/replays');
		expect((json.replays as { pace: unknown }[])[0]!.pace).toEqual({ envs: 5, durationMs: 39_000, waitMs: 37_000 });
	});

	it('answers "rebuild" when only the action log remains and canRebuild says yes, and does not offer one it says no to', async () => {
		const dir = await recordingsDir();
		writeActionsOnly(dir, 'm-yes');
		writeActionsOnly(dir, 'm-no');
		const base = await openApp(dir, { canRebuild: (header) => header.matchId === 'm-yes' });
		const { json } = await call(base, '/api/replays');
		const byId = Object.fromEntries((json.replays as { matchId: string; source: string }[]).map((r) => [r.matchId, r.source]));
		expect(byId).toEqual({ 'm-yes': 'rebuild' });
	});

	it('does not offer a v:1 stream (it drew no hand): a replay that cannot show both hands is no replay', async () => {
		const dir = await recordingsDir();
		writePublic(dir, 'm-v1', { v: 1 });
		writePublic(dir, 'm-v2');
		const base = await openApp(dir);
		const { json } = await call(base, '/api/replays');
		expect((json.replays as { matchId: string }[]).map((r) => r.matchId)).toEqual(['m-v2']);
		expect((await call(base, '/api/replays/m-v1')).status).toBe(404);
	});

	it('sorts newest first and honours limit', async () => {
		const dir = await recordingsDir();
		writePublic(dir, 'm-old', { startedAt: '2026-01-01T00:00:00.000Z' });
		writePublic(dir, 'm-new', { startedAt: '2026-01-02T00:00:00.000Z' });
		writePublic(dir, 'm-mid', { startedAt: '2026-01-01T12:00:00.000Z' });
		const base = await openApp(dir);
		const all = await call(base, '/api/replays');
		expect((all.json.replays as { matchId: string }[]).map((r) => r.matchId)).toEqual(['m-new', 'm-mid', 'm-old']);
		const limited = await call(base, '/api/replays?limit=1');
		expect((limited.json.replays as { matchId: string }[]).map((r) => r.matchId)).toEqual(['m-new']);
	});

	// The operator, 2026-11-07: "never show player vs bot, nor bot vs bot games in the front page".
	it('humans=only lists games between two people: never one with an AI seat, nor one whose seats it cannot tell', async () => {
		const dir = await recordingsDir();
		writePublic(dir, 'm-people');
		writePublic(dir, 'm-vsai', { ai: [false, true] });
		writePublic(dir, 'm-bots', { ai: [true, true] });
		writeActionsOnly(dir, 'm-rebuild-people', { startedAt: '2026-01-01T00:00:01.000Z' });
		writeActionsOnly(dir, 'm-rebuild-vsai', { seats: [{ name: 'A', ai: false }, { name: 'AI', ai: true }] });
		writeActionsOnly(dir, 'm-rebuild-unknown', { seats: null });
		const base = await openApp(dir, { canRebuild: () => true });
		const ids = async (path: string): Promise<string[]> => ((await call(base, path)).json.replays as { matchId: string }[]).map((r) => r.matchId).sort();
		expect(await ids('/api/replays?humans=only')).toEqual(['m-people', 'm-rebuild-people']);
		expect(await ids('/api/replays')).toHaveLength(6);
	});

	it('hides a testing room from a friend and shows it to an admin', async () => {
		testingRooms.add('r-testing');
		const dir = await recordingsDir();
		writePublic(dir, 'm-t', { roomId: 'r-testing' });
		const base = await openApp(dir);
		expect((await call(base, '/api/replays')).json.replays).toEqual([]);
		const asAdmin = await call(base, '/api/replays', 'admin');
		expect((asAdmin.json.replays as { matchId: string }[]).map((r) => r.matchId)).toEqual(['m-t']);
	});
});

describe('the list follows every writer of the recordings directory', () => {
	// The list is an index built once at boot; each thing that writes, moves or removes a recording
	// says so, and only that recording is read again. Nothing else ever reaches the list.
	const ids = async (base: string, tier = 'friend'): Promise<[string, string[], 0 | 1 | null][]> =>
		((await call(base, '/api/replays', tier)).json.replays as { matchId: string; players: string[]; winner: 0 | 1 | null }[]).map((r) => [r.matchId, r.players, r.winner]);
	const finished = (dir: string, matchId: string, winner: 0 | 1 | null, opts: { aside?: boolean; userId?: string } = {}): Promise<void> =>
		createMatchRecordingWriter({
			dir,
			matchId,
			actionsHeader: { matchId, roomId: null, pin: 'abc', bridge: 'def', server: '0', startedAt: '2026-01-01T00:00:00.000Z', spec: { seats: [{ name: 'Player 1', ai: false }, { name: 'Player 2', ai: false }] } },
			publicHeader: { matchId, roomId: null, players: ['Ari', 'Bo'], ai: [false, false], decks: [null, null], art: [], startedAt: '2026-01-01T00:00:00.000Z' },
		}).finish({ endedAt: '2026-01-01T00:10:00.000Z', reason: 'game-over' }, { endedAt: '2026-01-01T00:10:00.000Z', winner, ...(opts.userId === undefined ? {} : { seats: [{ seat: 0, claimed: true, playerId: 0, userId: opts.userId }] }) }, opts.aside === true ? { aside: true } : {});

	it("lists a match the recorder finishes after boot, and an earlier epoch it moves aside under its own id", async () => {
		const dir = await recordingsDir();
		const base = await openApp(dir);
		expect(await ids(base)).toEqual([]);
		await finished(dir, 'm-1', 1);
		await expect.poll(() => ids(base)).toEqual([['m-1', ['Ari', 'Bo'], 1]]);
		// A restore's new epoch finishing onto the same id moves the first aside.
		await finished(dir, 'm-1', 0);
		await expect.poll(async () => (await ids(base)).sort()).toEqual([
			['m-1', ['Ari', 'Bo'], 0],
			['m-1-e1', ['Ari', 'Bo'], 1],
		]);
		// One still live when it is restored is finished aside, straight to the next free epoch.
		await finished(dir, 'm-1', null, { aside: true });
		await expect.poll(async () => (await ids(base)).map(([id]) => id).sort()).toEqual(['m-1', 'm-1-e1', 'm-1-e2']);
		// A restore of a match whose last epoch already finished moves its files aside before the next is written.
		keepEarlierEpoch(dir, 'm-1', () => undefined);
		await expect.poll(async () => (await ids(base)).map(([id]) => id).sort()).toEqual(['m-1-e1', 'm-1-e2', 'm-1-e3']);
	});

	it('forgets what retention sweeps, and lists a rebuild from what the action log alone still offers', async () => {
		const dir = await recordingsDir();
		await finished(dir, 'm-1', 1);
		const base = await openApp(dir, { canRebuild: () => true });
		expect(await ids(base)).toEqual([['m-1', ['Ari', 'Bo'], 1]]);
		// Eight days on, the public stream has aged out and the action log is all that is left.
		sweepRecordings(dir, Date.now() + 8 * 24 * 60 * 60 * 1000);
		await expect.poll(() => ids(base)).toEqual([['m-1', ['Player 1', 'Player 2'], null]]);
		sweepRecordings(dir, Date.now() + 91 * 24 * 60 * 60 * 1000);
		await expect.poll(() => ids(base)).toEqual([]);
	});

	it("lists the stream a rebuild writes back in place of the rebuild it was", async () => {
		const dir = await recordingsDir();
		writeActionsOnly(dir, 'm-2');
		const base = await openApp(dir, { canRebuild: () => true });
		expect(((await call(base, '/api/replays')).json.replays as { source: string }[]).map((r) => r.source)).toEqual(['rebuild']);
		writePublicStream(dir, 'm-2', [
			{ t: 'header', v: 2, matchId: 'm-2', roomId: null, players: ['A', 'B'], ai: [false, false], decks: [null, null], art: [], startedAt: '2026-01-01T00:00:00.000Z' },
			{ t: 'end', endedAt: '2026-01-01T00:05:00.000Z', winner: 1 },
		]);
		await expect.poll(async () => ((await call(base, '/api/replays')).json.replays as { source: string; winner: number | null }[]).map((r) => [r.source, r.winner])).toEqual([['stream', 1]]);
	});

	it("plays an erased account's seat as unnamed from the erase on", async () => {
		const dir = await recordingsDir();
		await finished(dir, 'm-3', 1, { userId: 'uid-ari' });
		const base = await openApp(dir);
		expect(await ids(base)).toEqual([['m-3', ['Ari', 'Bo'], 1]]);
		expect(await recordingsStep(dir).erase(personOf('uid-ari'))).toBe(1);
		await expect.poll(() => ids(base)).toEqual([['m-3', [UNNAMED, 'Bo'], 1]]);
	});

	it('logs a recording it cannot read and lists the rest', async () => {
		const dir = await recordingsDir();
		writeFileSync(join(dir, 'm-bad.public.jsonl.gz'), 'not gzip');
		writePublic(dir, 'm-ok');
		const base = await openApp(dir);
		expect((await ids(base)).map(([id]) => id)).toEqual(['m-ok']);
		expect(logged.filter((l) => l.evt === 'replay-list-read-failed').map((l) => l.matchId)).toEqual(['m-bad']);
	});
});

describe("a game's replay is withheld from its own players while their series goes on", () => {
	it('drops it from their list and 404s it to them, rebuildable or streamed, and serves it to anyone else', async () => {
		const dir = await recordingsDir();
		writePublic(dir, 'm-mine');
		writeActionsOnly(dir, 'm-mine-old');
		writePublic(dir, 'm-theirs');
		// Two accounts: the player, and a member who did not play it. A lobby member's id is
		// `callerOf(req).id`, derived from the same header `call` sends.
		const [player, other] = ['account-player-0001', 'account-other-00002'];
		const playerId = identityFromHeaders({ 'x-user-id': player }, 'unused');
		const stillPlaying = (matchId: string, caller: string): boolean => caller === playerId && matchId.startsWith('m-mine');
		const rebuilt = { header: { t: 'header', v: 2, matchId: 'm-mine-old', roomId: null, players: ['A', 'B'], ai: [false, false], decks: [], startedAt: '2026-01-01T00:00:00.000Z' }, envs: [], end: { t: 'end', endedAt: '2026-01-01T00:05:00.000Z', winner: null } };
		const base = await openApp(dir, { stillPlaying, canRebuild: () => true, rebuild: async () => rebuilt as never });
		const listed = async (user: string) => ((await call(base, '/api/replays', 'friend', undefined, user)).json.replays as { matchId: string }[]).map((r) => r.matchId).sort();
		expect(await listed(player)).toEqual(['m-theirs']);
		expect(await listed(other)).toEqual(['m-mine', 'm-mine-old', 'm-theirs']);
		for (const game of ['m-mine', 'm-mine-old']) {
			expect((await call(base, `/api/replays/${game}`, 'friend', undefined, player)).status, `${game} to its player`).toBe(404);
			expect((await call(base, `/api/replays/${game}`, 'admin', undefined, player)).status, `${game}: an admin who played it is a player too`).toBe(404);
			expect((await call(base, `/api/replays/${game}`, 'friend', undefined, other)).status, `${game} to anyone else`).toBe(200);
		}
		expect((await call(base, '/api/replays/m-theirs', 'friend', undefined, player)).status).toBe(200);
	});
});

describe('GET /api/replays/:matchId', () => {
	it('serves the header, every env in order, the active seat\'s pointer, every relayed table message, and the end for a stream on disk', async () => {
		const dir = await recordingsDir();
		const pointer = { matchId: 'm-1', type: 'presence', pointer: { zone: 'hand', x: 0.2, y: 0.6 }, anchor: null, held: true, from: null, arranging: null, placing: null, handMove: null };
		writePublic(dir, 'm-1', {
			envs: [
				{ t: 'env', at: 0, env: { matchId: 'm-1', cursor: { epoch: 'e', seq: 1 }, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [0] } } } },
				{ t: 'presence', at: 20, seat: 1, playerId: 1, presence: pointer },
				{ t: 'relay', at: 30, event: 'forge:placement', echo: { card: 7 } },
				{ t: 'env', at: 50, env: { matchId: 'm-1', cursor: { epoch: 'e', seq: 2 }, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [1] } } } },
			],
		});
		const base = await openApp(dir);
		const { status, json, cache } = await call(base, `/api/replays/m-1?v=${REPLAY_BODY_VERSION}`);
		expect(status).toBe(200);
		expect(cache, 'a finished replay never changes: the browser keeps it, and no shared cache may').toBe('private, max-age=31536000, immutable');
		expect((json.envs as unknown[]).length).toBe(2);
		expect(json.presence).toEqual([{ at: 20, seat: 1, playerId: 1, presence: pointer }]);
		expect(json.relays).toEqual([{ at: 30, event: 'forge:placement', echo: { card: 7 } }]);
		expect((json.header as { matchId: string }).matchId).toBe('m-1');
		expect((json.end as { winner: number | null }).winner).toBeNull();
	});

	it('keeps a body for good only under the current body version: an unversioned or older ask revalidates', async () => {
		const dir = await recordingsDir();
		writePublic(dir, 'm-1', { envs: [{ t: 'env', at: 0, env: { matchId: 'm-1', cursor: { epoch: 'e', seq: 1 }, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [0] } } } }] });
		const base = await openApp(dir);
		const current = await call(base, `/api/replays/m-1?v=${REPLAY_BODY_VERSION}`);
		for (const url of ['/api/replays/m-1', `/api/replays/m-1?v=${REPLAY_BODY_VERSION - 1}`]) {
			const stale = await call(base, url);
			expect(stale.status).toBe(200);
			expect(stale.cache, `${url}: a body a browser holds as immutable is never asked about again`).toBe('private, no-cache');
			expect(stale.json, `${url} serves the same body`).toEqual(current.json);
		}
	});

	it('404s for a match with neither file', async () => {
		const base = await openApp(await recordingsDir());
		const missing = await call(base, '/api/replays/m-missing');
		expect(missing.status).toBe(404);
		expect(missing.cache, 'a 404 is never kept').toBeNull();
	});

	it('404s a testing room for a friend even if it finds the files', async () => {
		testingRooms.add('r-t');
		const dir = await recordingsDir();
		writePublic(dir, 'm-t', { roomId: 'r-t' });
		const base = await openApp(dir);
		expect((await call(base, '/api/replays/m-t')).status).toBe(404);
		expect((await call(base, '/api/replays/m-t', 'admin')).status).toBe(200);
	});

	it('404s an id that is not a safe path segment, never touching the filesystem with it', async () => {
		const base = await openApp(await recordingsDir());
		expect((await call(base, `/api/replays/${encodeURIComponent('../../etc/passwd')}`)).status).toBe(404);
	});

	it('404s a rebuildable match when canRebuild/rebuild are not wired, and serves the rebuild result when they are', async () => {
		const dir = await recordingsDir();
		writeActionsOnly(dir, 'm-reb');
		const notWired = await openApp(dir);
		expect((await call(notWired, '/api/replays/m-reb')).status).toBe(404);

		const rebuilt = {
			header: { t: 'header' as const, v: 2, matchId: 'm-reb', roomId: null, players: ['A', 'B'] as [string, string], ai: [false, false] as [boolean, boolean], decks: [null, null], startedAt: '2026-01-01T00:00:00.000Z' },
			envs: [],
			end: { t: 'end' as const, endedAt: '2026-01-01T00:05:00.000Z', winner: 0 as const },
		};
		const wired = await openApp(dir, { canRebuild: () => true, rebuild: async () => rebuilt });
		const { status, json } = await call(wired, '/api/replays/m-reb');
		expect(status).toBe(200);
		expect(json).toEqual(rebuilt);
	});
});

describe("a replay recorded before faces carried their art", () => {
	/** Every face's id is its name's, and the decks it was made for are kept, so a test sees both. */
	function namedArt(): { artIds: (decks: readonly (string | null)[]) => ArtIds; decksSeen: (readonly (string | null)[])[] } {
		const decksSeen: (readonly (string | null)[])[] = [];
		const art: ArtIds = { face: ({ name }) => ({ scryfallId: `id:${name}` }), card: () => undefined, images: (name) => [`id:${name}`], backs: () => [] };
		return { artIds: (decks) => (decksSeen.push(decks), art), decksSeen };
	}
	/** The watcher stream the live recorder writes today: the real fixture through `createProjector(EVERY_PLAYER, art)`. */
	function liveEnvs(matchId: string): unknown[] {
		const projector = createProjector(EVERY_PLAYER, namedArt().artIds([]));
		return fixtureFrames().map((frame, i) => ({ t: 'env', at: i * 100, env: { matchId, cursor: { epoch: 'e', seq: i + 1 }, frame: projector.project(frame) } }));
	}
	/** The same stream as a recording from before v0.57.0 wrote it: no face carries `ScryfallId`. */
	function unstamped(envs: unknown[]): { envs: unknown[]; stripped: number } {
		let stripped = 0;
		const text = JSON.stringify(envs, (key, value: unknown) => {
			if (key !== 'ScryfallId') return value;
			stripped += 1;
			return undefined;
		});
		return { envs: JSON.parse(text) as unknown[], stripped };
	}
	const facesOf = (envs: unknown[]): Record<string, unknown>[] =>
		envs.flatMap((e) => {
			const frame = (e as { env: { frame: StateFrame } }).env.frame;
			if (frame.method !== 'applyDelta') return [];
			const { newObjects, objectDeltas } = frame.payload.packet;
			return [...Object.entries(newObjects), ...Object.entries(objectDeltas)].filter(([key]) => deltaKeyType(Number(key)) === DELTA_TYPE.cardState).map(([, face]) => face);
		});

	it('serves each face the art the live watcher is sent, with the match decks from its action log, and its header art as ids', async () => {
		const dir = await recordingsDir();
		const live = liveEnvs('m-old');
		const { envs, stripped } = unstamped(live);
		expect(stripped, 'the fixture is stamped live, so stripping it is no no-op').toBeGreaterThan(20);
		writePublic(dir, 'm-old', { envs, art: [{ name: 'Mountain', set: 'M11' }, { name: 'Shock', set: null }] });
		writeActionsOnly(dir, 'm-old', { seats: [{ name: 'A', ai: false, deck: 'deck-a' }, { name: 'B', ai: false, deck: 'deck-b' }] });
		const { artIds, decksSeen } = namedArt();
		const base = await openApp(dir, { artIds });
		const { status, json } = await call(base, '/api/replays/m-old');
		expect(status).toBe(200);
		const served = (json.envs as { at: number; env: unknown }[]).map(({ at, env }) => ({ t: 'env', at, env }));
		expect(served, 'every face as the live watcher was sent it').toEqual(live);
		expect(facesOf(served).filter((face) => face.ScryfallId !== undefined).length).toBe(stripped);
		expect((json.header as { art: unknown }).art).toEqual(['id:Mountain', 'id:Shock']);
		expect(decksSeen).toEqual([['deck-a', 'deck-b']]);
	});

	it('serves a stream recorded with its art exactly as it was written, and an unwired server serves an old one as written', async () => {
		const dir = await recordingsDir();
		writePublic(dir, 'm-new', { envs: liveEnvs('m-new'), art: ['id:Mountain'] });
		const { envs } = unstamped(liveEnvs('m-old'));
		writePublic(dir, 'm-old', { envs, art: [{ name: 'Mountain', set: 'M11' }] });
		const { artIds, decksSeen } = namedArt();
		const asWritten = async (matchId: string): Promise<unknown> => (await call(await openApp(dir), `/api/replays/${matchId}`)).json;
		const stamped = await call(await openApp(dir, { artIds }), '/api/replays/m-new');
		expect(JSON.stringify(stamped.json)).toBe(JSON.stringify(await asWritten('m-new')));
		expect(decksSeen, 'a stamped stream asks for no art at all').toEqual([]);
		expect(((await asWritten('m-old')) as { header: { art: unknown } }).header.art).toEqual([{ name: 'Mountain', set: 'M11' }]);
	});
});

describe('a replay\'s people', () => {
	const SEATS = [
		{ seat: 0, claimed: true, playerId: 0, avatarId: 'sage', userId: 'uid-ari' },
		{ seat: 1, claimed: true, playerId: 1, avatarId: 'herald' },
	];
	const people = {
		resolve: async (ids: readonly string[]) =>
			new Map(ids.filter((id) => id === 'uid-ari').map((id) => [id, { name: 'Ari', sprite: 'mage', look: { picture: 'https://cdn.discordapp.com/avatars/1/a.png', cosmetics: { overlay: 'overlay.crown' } } }] as const)),
		peek: () => undefined,
	};

	it('never serves a seat\'s userId with the replay itself', async () => {
		const dir = await recordingsDir();
		writePublic(dir, 'm-1', { seats: SEATS });
		const { json } = await call(await openApp(dir, { people }), '/api/replays/m-1');
		expect((json.end as { seats: unknown[] }).seats).toEqual([
			{ seat: 0, claimed: true, playerId: 0, avatarId: 'sage' },
			{ seat: 1, claimed: true, playerId: 1, avatarId: 'herald' },
		]);
		expect(JSON.stringify(json)).not.toContain('uid-ari');
	});

	it('answers each seat holder as they are now, briefly cached, and nothing for a seat it cannot look up', async () => {
		const dir = await recordingsDir();
		writePublic(dir, 'm-1', { seats: SEATS });
		const { status, json, cache } = await call(await openApp(dir, { people }), '/api/replays/m-1/people');
		expect(status).toBe(200);
		expect(cache).toBe('private, max-age=60');
		expect(json).toEqual({ people: { 0: { name: 'Ari', avatarId: 'mage', look: { picture: 'https://cdn.discordapp.com/avatars/1/a.png', cosmetics: { overlay: 'overlay.crown' } } } } });
	});

	it('names a replay that only its action log can rebuild from the log\'s users, by seat', async () => {
		const dir = await recordingsDir();
		writeGz(join(dir, 'm-3.actions.jsonl.gz'), [
			{ t: 'header', v: 2, matchId: 'm-3', roomId: null, pin: 'abc', bridge: 'def', server: '0', startedAt: '2026-01-01T00:00:00.000Z', spec: { seats: [{ name: 'Player 1', ai: false }, { name: 'Forge AI', ai: true }] } },
			{ t: 'end', endedAt: '2026-01-01T00:05:00.000Z', reason: 'game-over', users: ['uid-ari', null] },
		]);
		const { json } = await call(await openApp(dir, { people }), '/api/replays/m-3/people');
		expect(json).toEqual({ people: { 0: { name: 'Ari', avatarId: 'mage', look: { picture: 'https://cdn.discordapp.com/avatars/1/a.png', cosmetics: { overlay: 'overlay.crown' } } } } });
	});

	it('lists each player by the name they have now, a stream or a rebuild alike, and a seat nobody can look up as it was recorded', async () => {
		const dir = await recordingsDir();
		writePublic(dir, 'm-1', { seats: SEATS, startedAt: '2026-01-01T00:00:02.000Z' });
		writeGz(join(dir, 'm-3.actions.jsonl.gz'), [
			{ t: 'header', v: 2, matchId: 'm-3', roomId: null, pin: 'abc', bridge: 'def', server: '0', startedAt: '2026-01-01T00:00:01.000Z', spec: { seats: [{ name: 'Player 1', ai: false }, { name: 'Forge AI', ai: true }] } },
			{ t: 'end', endedAt: '2026-01-01T00:05:00.000Z', reason: 'game-over', users: ['uid-ari', null] },
		]);
		const { json } = await call(await openApp(dir, { people, canRebuild: () => true }), '/api/replays');
		expect((json.replays as { matchId: string; players: string[] }[]).map((r) => [r.matchId, r.players])).toEqual([
			['m-1', ['Ari', 'B']],
			['m-3', ['Ari', 'Forge AI']],
		]);
	});

	it('is withheld exactly as the replay is, and a recording from before userIds were kept has nobody', async () => {
		const dir = await recordingsDir();
		writePublic(dir, 'm-1', { roomId: 'r-test', seats: SEATS });
		writePublic(dir, 'm-2');
		testingRooms.add('r-test');
		const base = await openApp(dir, { people });
		expect((await call(base, '/api/replays/m-1/people')).status).toBe(404);
		expect((await call(base, '/api/replays/m-2/people')).json).toEqual({ people: {} });
		expect((await call(base, '/api/replays/m-9/people')).status).toBe(404);
	});
});

describe('POST /api/replays/report', () => {
	it('logs a known trouble with its match, and refuses an unknown one', async () => {
		const base = await openApp(await recordingsDir());
		expect((await call(base, '/api/replays/report', 'friend', { what: 'player-error', matchId: 'm-1', ui: '0.1.0', detail: { error: 'x' } })).status).toBe(204);
		expect(logged).toContainEqual({ evt: 'replay-report', what: 'player-error', matchId: 'm-1', ui: '0.1.0', detail: { error: 'x' } });
		expect((await call(base, '/api/replays/report', 'friend', { what: 'anything', detail: {} })).status).toBe(400);
	});
});

describe("the list's bytes", () => {
	// Every kind of row the list can hold, in one directory: what the list answers for it is kept
	// byte for byte, so a change to how the list is read can be told from a change to what it says.
	it('answers exactly as it always has for every kind of recording', async () => {
		testingRooms.add('r-test');
		const dir = await recordingsDir();
		const env = (at: number): unknown => ({ t: 'env', at, env: { frame: { kind: 'notify' } } });
		const SEATS = [
			{ seat: 0, claimed: true, playerId: 0, avatarId: 'sage', userId: 'uid-ari' },
			{ seat: 1, claimed: true, playerId: 1, userId: 'uid-gone' },
		];
		writePublic(dir, 'm-stream', { roomId: 'r-1', winner: 1, seats: SEATS, startedAt: '2026-01-01T00:00:09.000Z', envs: [env(0), env(6_000), env(7_000)] });
		writeGz(join(dir, 'm-stream-e1.public.jsonl.gz'), [
			{ t: 'header', v: 2, matchId: 'm-stream', roomId: 'r-1', players: ['A', 'B'], ai: [false, false], decks: [['W'], ['U', 'B']], art: ['a1', 'a2'], startedAt: '2026-01-01T00:00:07.000Z' },
			env(0),
			{ t: 'end', endedAt: '2026-01-01T00:04:00.000Z', winner: null },
		]);
		writePublic(dir, 'm-vsai', { ai: [false, true], startedAt: '2026-01-01T00:00:06.000Z' });
		writePublic(dir, 'm-testing', { roomId: 'r-test', startedAt: '2026-01-01T00:00:05.000Z' });
		writePublic(dir, 'm-v1', { v: 1, startedAt: '2026-01-01T00:00:04.000Z' });
		writeActionsOnly(dir, 'm-v1', { startedAt: '2026-01-01T00:00:04.000Z' });
		writeActionsOnly(dir, 'm-rebuild', { startedAt: '2026-01-01T00:00:03.000Z' });
		writeActionsOnly(dir, 'm-unknown', { seats: null, startedAt: '2026-01-01T00:00:02.000Z' });
		writeActionsOnly(dir, 'm-refused', { startedAt: '2026-01-01T00:00:01.000Z' });
		writeGz(join(dir, 'm-users.actions.jsonl.gz'), [
			{ t: 'header', v: 2, matchId: 'm-users', roomId: null, pin: 'abc', bridge: 'def', server: '0', startedAt: '2026-01-01T00:00:00.500Z', spec: { seats: [{ name: 'Player 1', ai: false }, { name: 'Player 2', ai: false }] } },
			{ t: 'end', endedAt: '2026-01-01T00:05:00.000Z', reason: 'game-over', users: [null, 'uid-ari'] },
		]);
		writeFileSync(join(dir, 'm-corrupt.public.jsonl.gz'), 'not gzip');
		writeFileSync(join(dir, 'notes.txt'), 'not a recording');
		const people = { resolve: async (ids: readonly string[]) => new Map(ids.filter((id) => id === 'uid-ari').map((id) => [id, { name: 'Ari', sprite: 'mage' }] as const)), peek: () => undefined };
		const base = await openApp(dir, { people: people as never, canRebuild: (header) => header.matchId !== 'm-refused' });
		const text = async (path: string, tier = 'friend'): Promise<string> => (await fetch(`${base}${path}`, { headers: { 'x-edge-auth': EDGE_SECRET, 'x-hadoku-tier': tier, 'x-user-id': 'u-1', 'x-user-name': 'u-1', 'x-user-key': 'k' } })).text();
		for (const [path, tier] of [['/api/replays', 'friend'], ['/api/replays', 'admin'], ['/api/replays?humans=only', 'friend'], ['/api/replays?limit=2', 'friend'], ['/api/replays?limit=abc', 'admin']] as const) {
			expect(await text(path, tier)).toMatchSnapshot(`${tier} ${path}`);
		}
	});
});
