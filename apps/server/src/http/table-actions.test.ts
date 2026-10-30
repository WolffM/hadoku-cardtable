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
async function open(opts: { refuse?: string; pod?: boolean } = {}): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-table-actions-'));
	const lobby = await openLobby({ dir });
	const made = lobby.create({ id: ALICE, name: 'alice' }, { name: 'tonight', gameType: 'constructed-1v1', clientMode: 'builtin', ...(opts.pod === true ? { mode: { mode: 'classic', modeOptions: {} } } : {}) });
	if (!made.ok) throw new Error(made.reason);
	const roomId = made.room.id;
	expect(lobby.join(roomId, { id: BOB, name: 'bob' }).ok).toBe(true);
	expect(lobby.join(roomId, { id: CAROL, name: 'carol' }).ok).toBe(true);
	// A pod: Bob and Carol play the tournament's one pairing, Alice leads it watching.
	const players = opts.pod === true ? [BOB, CAROL] : [ALICE, BOB];
	let tableId = lobby.get(roomId)!.tables[0]!.id;
	if (opts.pod === true) {
		expect(lobby.setSettings(roomId, ALICE, { tournament: true }).ok).toBe(true);
		players.forEach((id, seat) => expect(lobby.sitPod(roomId, id, seat).ok).toBe(true));
		lobby.setPodChecks({
			draftComplete: () => true,
			built: () => true,
			seatState: () => null,
			holdsSeriesDeck: () => true,
			roundNamesOf: () => ['', '', ''],
			hasLegalSeatDeck: () => true,
			currentTournamentDeck: () => null,
			seatTournamentDeck: () => {},
		});
		const started = lobby.startDraft(roomId, ALICE);
		if (!started.ok) throw new Error(started.reason);
		tableId = started.room.pod!.pairings[0]!.tableId;
	} else {
		expect(lobby.sit(roomId, tableId, ALICE) && lobby.sit(roomId, tableId, BOB)).toBe(true);
	}
	expect(lobby.setTableMatch(roomId, tableId, MATCH)).toBe(true);
	const acts: Harness['acts'] = [];
	const stopped: string[] = [];
	const ended: string[] = [];
	const seats = new Map<string, number>(players.map((id, seat) => [id, seat]));
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

const leader = (h: Harness, as: string, path: string, body?: unknown) =>
	fetch(`${h.base}/api/rooms/${h.roomId}/${path}`, { method: 'POST', headers: { 'x-test-user': as, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

describe('POST /api/rooms/:roomId/tables/:tableId/reset', () => {
	it('the leader, watching, restarts the game in play: it is stopped, the series score stands', async () => {
		const h = await open({ pod: true });
		const res = await leader(h, ALICE, `tables/${h.tableId}/reset`);
		expect(res.status).toBe(200);
		expect(h.stopped).toEqual([MATCH]);
		expect(h.acts, 'a reset concedes nothing').toEqual([]);
		expect(h.lobby.get(h.roomId)!.tables.find((t) => t.id === h.tableId)).toMatchObject({ matchId: null, series: { phase: 'playing', wins: [0, 0] } });
	});

	it('a seated leader may too; a player who is not the leader may not, and a non-member hears of no room', async () => {
		const h = await open();
		expect((await leader(h, BOB, `tables/${h.tableId}/reset`)).status).toBe(403);
		expect((await leader(h, 'fk:dddddddddddddddd', `tables/${h.tableId}/reset`)).status).toBe(404);
		expect(h.stopped).toEqual([]);
		expect((await leader(h, ALICE, `tables/${h.tableId}/reset`)).status).toBe(200);
		expect((await leader(h, ALICE, `tables/${h.tableId}/reset`)).status, 'nothing left in play').toBe(409);
		expect(h.stopped).toEqual([MATCH]);
	});
});

describe('POST /api/rooms/:roomId/pod/dq', () => {
	it('the leader disqualifies a player: their game is conceded for their seat, their match lost, and they are marked out', async () => {
		const h = await open({ pod: true });
		const res = await leader(h, ALICE, 'pod/dq', { memberId: CAROL });
		expect(res.status).toBe(200);
		expect(h.acts).toEqual([{ seat: 1, frame: { kind: 'act', method: 'concede' } }]);
		expect(h.stopped).toEqual([]);
		expect(h.ended).toEqual([h.tableId]);
		const pod = h.lobby.get(h.roomId)!.pod!;
		expect(pod.dropped).toEqual([CAROL]);
		expect(pod.results).toEqual([{ round: 1, playerA: BOB, playerB: CAROL, gamesA: 2, gamesB: 0 }]);
	});

	it('refuses anyone but the leader, a body that names nobody, a non-entrant, and a room with no rounds', async () => {
		const h = await open({ pod: true });
		expect((await leader(h, BOB, 'pod/dq', { memberId: CAROL })).status).toBe(403);
		expect((await leader(h, ALICE, 'pod/dq', {})).status).toBe(400);
		expect((await leader(h, ALICE, 'pod/dq', { memberId: CAROL, extra: 1 })).status).toBe(400);
		expect((await leader(h, ALICE, 'pod/dq', { memberId: ALICE })).status).toBe(404);
		expect(h.lobby.get(h.roomId)!.pod!.dropped).toEqual([]);
		const plain = await open();
		expect((await leader(plain, ALICE, 'pod/dq', { memberId: BOB })).status).toBe(409);
		expect(h.acts).toEqual([]);
	});
});
