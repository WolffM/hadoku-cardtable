import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { ParticipantId } from '@wolffm/rooms-protocol';

import { openLobby, type Lobby } from '../room/lobby.js';
import { attachRooms } from './rooms.js';
import { attachTableActions } from './table-actions.js';

const ALICE = 'fk:aaaaaaaaaaaaaaaa' as ParticipantId;
const BOB = 'fk:bbbbbbbbbbbbbbbb' as ParticipantId;
const CAROL = 'fk:cccccccccccccccc' as ParticipantId;
const MATCH = 'm-0000000000c1';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

interface Harness {
	base: string;
	lobby: Lobby;
	roomId: string;
	tableId: string;
	acts: { seat: number; frame: unknown }[];
	stopped: string[];
	ended: string[];
}

/** A room alice leads and bob is in, its table playing `MATCH` with alice at seat 0 and bob at seat 1 — mounted after the rooms router, as `index.ts` mounts it. */
async function open(opts: { refuse?: string } = {}): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-table-actions-'));
	const lobby = await openLobby({ dir });
	const made = lobby.create({ id: ALICE, name: 'alice' }, { name: 'tonight', gameType: 'constructed-1v1', clientMode: 'builtin' });
	if (!made.ok) throw new Error(made.reason);
	const roomId = made.room.id;
	expect(lobby.join(roomId, { id: BOB, name: 'bob' }).ok).toBe(true);
	expect(lobby.join(roomId, { id: CAROL, name: 'carol' }).ok).toBe(true);
	const tableId = lobby.get(roomId)!.tables[0]!.id;
	expect(lobby.sit(roomId, tableId, ALICE) && lobby.sit(roomId, tableId, BOB)).toBe(true);
	expect(lobby.setTableMatch(roomId, tableId, MATCH)).toBe(true);
	const acts: Harness['acts'] = [];
	const stopped: string[] = [];
	const ended: string[] = [];
	const seats = new Map<string, number>([
		[ALICE, 0],
		[BOB, 1],
	]);
	const app = express();
	const api = express.Router();
	api.use(express.json());
	attachRooms(api, { lobby, log: () => undefined, checkPlan: async () => ({ ok: true, cards: 0 }) });
	attachTableActions(api, {
		lobby,
		log: () => undefined,
		seriesEnded: (_room, table) => void ended.push(table),
		callerOf: (req) => String(req.headers['x-test-user']) as ParticipantId,
		match: (id) =>
			id !== MATCH
				? undefined
				: {
						seatOf: (who) => seats.get(who) ?? null,
						fromClient: (seat, frame) => {
							acts.push({ seat, frame });
							return opts.refuse === undefined ? { ok: true } : { ok: false, error: opts.refuse };
						},
						stop: () => void stopped.push(MATCH),
					},
	});
	app.use('/api', api);
	const server: Server = createServer(app);
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	cleanups.push(async () => {
		await new Promise<void>((done) => server.close(() => done()));
		await rm(dir, { recursive: true, force: true });
	});
	return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, lobby, roomId, tableId, acts, stopped, ended };
}

const concede = (h: Harness, as: string, tableId = h.tableId) =>
	fetch(`${h.base}/api/rooms/${h.roomId}/tables/${tableId}/concede`, { method: 'POST', headers: { 'x-test-user': as } });

describe('POST /api/rooms/:roomId/tables/:tableId/concede', () => {
	it('concedes the caller’s own game, as the board’s own concede, for their seat', async () => {
		const h = await open();
		const res = await concede(h, BOB);
		expect(res.status).toBe(200);
		expect(h.acts).toEqual([{ seat: 1, frame: { kind: 'act', method: 'concede' } }]);
	});

	it('refuses a member who plays at no seat of it, and tells a non-member there is no such room', async () => {
		const h = await open();
		expect((await concede(h, CAROL)).status).toBe(403);
		expect((await concede(h, 'fk:dddddddddddddddd')).status).toBe(404);
		expect(h.acts).toEqual([]);
	});

	it('says so for a table with no game in play, or one that is not there', async () => {
		const h = await open();
		h.lobby.releaseTableMatch(h.roomId, h.tableId);
		expect((await concede(h, ALICE)).status).toBe(409);
		expect((await concede(h, ALICE, 't-00000000')).status).toBe(404);
	});

	it('passes on the match’s own refusal: a game already over', async () => {
		const h = await open({ refuse: 'concede-after-game-over (match is over)' });
		const res = await concede(h, ALICE);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toContain('concede-after-game-over');
	});
});

const act = (h: Harness, what: 'abandon' | 'drop', as: string, tableId = h.tableId) =>
	fetch(`${h.base}/api/rooms/${h.roomId}/tables/${tableId}/${what}`, { method: 'POST', headers: { 'x-test-user': as } });

describe('POST /api/rooms/:roomId/tables/:tableId/abandon', () => {
	it('ends the series with no result and stops its game in play, for a player seated at it', async () => {
		const h = await open();
		const res = await act(h, 'abandon', BOB);
		expect(res.status).toBe(200);
		expect(h.stopped).toEqual([MATCH]);
		expect(h.ended, 'its seats go back to their registered decks').toEqual([h.tableId]);
		expect(h.lobby.get(h.roomId)!.tables[0]).toMatchObject({ matchId: null, series: { phase: 'seating', games: [] } });
	});

	it('refuses a member with no seat at it, a non-member, and a table that is not there', async () => {
		const h = await open();
		expect((await act(h, 'abandon', CAROL)).status).toBe(403);
		expect((await act(h, 'abandon', 'fk:dddddddddddddddd')).status).toBe(404);
		expect((await act(h, 'abandon', ALICE, 't-00000000')).status).toBe(404);
		expect(h.stopped).toEqual([]);
		expect(h.ended).toEqual([]);
	});

	it('says there is nothing to abandon at a table with no series under way, and Drop is a pod’s', async () => {
		const h = await open();
		expect((await act(h, 'drop', ALICE)).status).toBe(409);
		h.lobby.releaseTableMatch(h.roomId, h.tableId);
		expect((await act(h, 'abandon', ALICE)).status).toBe(409);
		expect(h.stopped).toEqual([]);
	});
});
