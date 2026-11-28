import { createServer, type Server } from 'node:http';
import { standAll } from '../room/testing-seats.ts';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Request } from 'express';
import { httpCaller } from '@hadoku/game-server/http/request';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotWriter } from '@hadoku/game-server/persist/snapshot-writer';
import type { ParticipantId } from '@wolffm/rooms-protocol';

import { openLobby, type Lobby } from '../room/lobby.js';
import type { GameHooks } from '../room/pods.js';
import { newGauntlet } from '../room/gauntlet.ts';
import { attachRooms } from './rooms.js';
import { attachTableActions } from './table-actions.js';
import { magicView } from '../room/magic-view.js';
import { isPodAi } from '@hadoku/shared';

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
	restored: string[];
	awarded: { table: string; winner: 0 | 1 }[];
	events: Record<string, unknown>[];
}

/** A room alice leads and bob is in, its table playing `MATCH` with alice at seat 0 and bob at seat 1 — mounted after the rooms router, as `index.ts` mounts it. */
async function open(opts: { refuse?: string; pod?: boolean; starting?: boolean } = {}): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-table-actions-'));
	const lobby = await openLobby({ dir });
	const made = lobby.create({ id: ALICE, name: 'alice', userId: null }, { name: 'tonight', gameType: 'constructed-1v1', clientMode: 'builtin', ...(opts.pod === true ? { mode: { mode: 'classic', modeOptions: {} } } : {}) });
	if (!made.ok) throw new Error(made.reason);
	const roomId = made.room.id;
	expect(lobby.join(roomId, { id: BOB, name: 'bob', userId: null }).ok).toBe(true);
	expect(lobby.join(roomId, { id: CAROL, name: 'carol', userId: null }).ok).toBe(true);
	// A pod: Bob and Carol play the tournament's one pairing, Alice leads it watching.
	const players = opts.pod === true ? [BOB, CAROL] : [ALICE, BOB];
	let tableId = magicView(lobby.get(roomId))!.tables[0]!.id;
	if (opts.pod === true) {
		expect(lobby.setSettings(roomId, ALICE, { tournament: true }).ok).toBe(true);
		standAll(lobby, roomId);
		players.forEach((id, seat) => expect(lobby.sitSeat(roomId, id, seat).ok).toBe(true));
		const checks: GameHooks = {
			draftComplete: () => true,
			built: () => true,
			seatState: () => null,
			holdsSeriesDeck: () => true,
			roundNamesOf: () => ['', '', ''],
			hasLegalSeatDeck: () => true,
			currentTournamentDeck: () => null,
			seatTournamentDeck: () => {},
		};
		lobby.useGameType('constructed-1v1', checks);
		lobby.useGameType('draft', checks);
		const started = lobby.startDraft(roomId, ALICE);
		if (!started.ok) throw new Error(started.reason);
		tableId = started.room.game!.pod!.pairings[0]!.tableId;
	} else {
		expect(lobby.sit(roomId, tableId, ALICE) && lobby.sit(roomId, tableId, BOB)).toBe(true);
	}
	expect(lobby.setTableMatch(roomId, tableId, MATCH)).toBe(true);
	const acts: Harness['acts'] = [];
	const stopped: string[] = [];
	const ended: string[] = [];
	const restored: string[] = [];
	const awarded: Harness['awarded'] = [];
	const events: Harness['events'] = [];
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
		report: (event, context) => void events.push({ event, ...context }),
		restore: (id) => (id === MATCH && !stopped.includes(MATCH) ? (restored.push(id), { from: 'snapshot', turn: 7 }) : null),
		awardGame: (_room, table, winner) => (awarded.push({ table, winner }), true),
		epochsOf: (id) => [`${id}-e1`],
		match: (id) => {
			if (id !== MATCH) return undefined;
			const fromClient = (seat: number, frame: { kind: 'act'; method: 'concede' }) => {
				acts.push({ seat, frame });
				return opts.refuse === undefined ? { ok: true as const } : { ok: false as const, error: opts.refuse };
			};
			return {
				seatOf: (who) => seats.get(who) ?? null,
				fromClient,
				concedeFor: (seat) => (opts.starting === true ? false : fromClient(seat, { kind: 'act', method: 'concede' }).ok),
				concedeAi: () => false,
				inspect: () => ({ status: 'running', startedAt: 0, turn: 7, active: 1, life: [20, 3], restoreTurn: 7, lastActivityAt: 0, seats: [] }),
				stop: () => void stopped.push(MATCH),
			};
		},
	});
	app.use('/api', api);
	const server: Server = createServer(app);
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	cleanups.push(async () => {
		await new Promise<void>((done) => server.close(() => done()));
		await snapshotWriter().idle();
		await rm(dir, { recursive: true, force: true });
	});
	return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, lobby, roomId, tableId, acts, stopped, ended, restored, awarded, events };
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
		expect(magicView(h.lobby.get(h.roomId))!.tables[0]).toMatchObject({ matchId: null, series: { phase: 'seating', games: [] } });
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

const leader = (h: Harness, as: string, path: string, body?: unknown, tier?: string) =>
	fetch(`${h.base}/api/rooms/${h.roomId}/${path}`, {
		method: 'POST',
		headers: { 'x-test-user': as, 'content-type': 'application/json', ...(tier === undefined ? {} : { 'x-hadoku-tier': tier }) },
		body: JSON.stringify(body ?? {}),
	});

describe('POST /api/rooms/:roomId/tables/:tableId/reset', () => {
	it('the leader, watching, restarts the game in play: it is stopped, the series score stands', async () => {
		const h = await open({ pod: true });
		const res = await leader(h, ALICE, `tables/${h.tableId}/reset`);
		expect(res.status).toBe(200);
		expect(h.stopped).toEqual([MATCH]);
		expect(h.acts, 'a reset concedes nothing').toEqual([]);
		expect(magicView(h.lobby.get(h.roomId))!.tables.find((t) => t.id === h.tableId)).toMatchObject({ matchId: null, series: { phase: 'playing', wins: [0, 0] } });
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

describe('POST /api/rooms/:roomId/tables/reset', () => {
	it('the leader starts a room over after its opponent left: the series and Gauntlet go, the room and who sits stay', async () => {
		const h = await open();
		expect(h.lobby.recordGameResult(h.roomId, h.tableId, { matchId: MATCH, winner: 0 }).ok).toBe(true);
		expect(h.lobby.setGauntlet(h.roomId, newGauntlet(), h.tableId)).toBe(true);
		expect(h.lobby.leave(h.roomId, BOB).ok).toBe(true);
		expect(magicView(h.lobby.get(h.roomId))!.tables[0]!.series, 'left behind: one game played, nobody to finish it').toMatchObject({ wins: [1, 0], games: [{ matchId: MATCH }] });
		const res = await leader(h, ALICE, 'tables/reset');
		expect(res.status).toBe(200);
		expect(h.stopped, 'no game was in play').toEqual([]);
		expect(h.ended).toEqual([h.tableId]);
		const room = magicView(h.lobby.get(h.roomId))!;
		expect(room.tables[0]).toMatchObject({ players: [{ memberId: ALICE }], matchId: null, series: { phase: 'seating', wins: [0, 0], games: [] } });
		expect(h.lobby.gauntlet(h.roomId, h.tableId)).toBeNull();
		expect(room.members.map((m) => m.id)).toEqual([ALICE, CAROL]);
		expect(room.name).toBe('tonight');
	});

	it('lets go of the game in play without a result and stops it', async () => {
		const h = await open();
		expect((await leader(h, ALICE, 'tables/reset')).status).toBe(200);
		expect(h.stopped).toEqual([MATCH]);
		expect(h.acts, 'a reset concedes nothing').toEqual([]);
		expect(magicView(h.lobby.get(h.roomId))!.tables[0]).toMatchObject({ players: [{ memberId: ALICE }, { memberId: BOB }], matchId: null, series: { phase: 'seating', games: [] } });
	});

	it('is the leader’s alone, a non-member hears of no room, and a tournament under way is closed instead', async () => {
		const h = await open();
		expect((await leader(h, BOB, 'tables/reset')).status).toBe(403);
		expect((await leader(h, 'fk:dddddddddddddddd', 'tables/reset')).status).toBe(404);
		expect(h.stopped).toEqual([]);
		const pod = await open({ pod: true });
		const refused = await leader(pod, ALICE, 'tables/reset');
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ error: 'a draft or tournament under way can only be closed' });
		expect(pod.stopped).toEqual([]);
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
		const pod = h.lobby.get(h.roomId)!.game!.pod!;
		expect(pod.dropped).toEqual([CAROL]);
		expect(pod.results).toEqual([{ round: 1, playerA: BOB, playerB: CAROL, gamesA: 2, gamesB: 0 }]);
	});

	it('refuses anyone but the leader, a body that names nobody, a non-entrant, and a room with no rounds', async () => {
		const h = await open({ pod: true });
		expect((await leader(h, BOB, 'pod/dq', { memberId: CAROL })).status).toBe(403);
		expect((await leader(h, ALICE, 'pod/dq', {})).status).toBe(400);
		expect((await leader(h, ALICE, 'pod/dq', { memberId: CAROL, extra: 1 })).status).toBe(400);
		expect((await leader(h, ALICE, 'pod/dq', { memberId: ALICE })).status).toBe(404);
		expect(h.lobby.get(h.roomId)!.game!.pod!.dropped).toEqual([]);
		const plain = await open();
		expect((await leader(plain, ALICE, 'pod/dq', { memberId: BOB })).status).toBe(409);
		expect(h.acts).toEqual([]);
	});
});

/** Someone who is not in the room at all, as the edge names them. */
const OUTSIDER = 'fk:eeeeeeeeeeeeeeee';

describe('an operator (raw edge tier wife or admin) has the leader’s tools in any room', () => {
	it('resets a game, DQs a player and resets a room without being the leader or even a member; member and friend are refused', async () => {
		const h = await open({ pod: true });
		for (const tier of ['member', 'friend', 'guest']) {
			expect((await leader(h, BOB, `tables/${h.tableId}/reset`, {}, tier)).status, `a ${tier} player`).toBe(403);
			expect((await leader(h, OUTSIDER, `tables/${h.tableId}/reset`, {}, tier)).status, `a ${tier} outsider`).toBe(404);
		}
		expect(h.stopped).toEqual([]);
		expect((await leader(h, OUTSIDER, `tables/${h.tableId}/reset`, {}, 'wife')).status).toBe(200);
		expect(h.stopped).toEqual([MATCH]);
		expect((await leader(h, OUTSIDER, 'pod/dq', { memberId: CAROL }, 'admin')).status).toBe(200);
		expect(h.lobby.get(h.roomId)!.game!.pod!.dropped).toEqual([CAROL]);
		const plain = await open();
		expect((await leader(plain, BOB, 'tables/reset', {}, 'wife')).status).toBe(200);
		expect(plain.stopped).toEqual([MATCH]);
	});

	it('every act, done or refused, is a server event naming who did it and their tier', async () => {
		const h = await open({ pod: true });
		await leader(h, BOB, `tables/${h.tableId}/reset`, {}, 'member');
		await leader(h, OUTSIDER, `tables/${h.tableId}/reset`, {}, 'admin');
		expect(h.events).toMatchObject([
			{ event: 'admin-act', act: 'game-reset', by: BOB, tier: 'member', ok: false, reason: 'not-leader' },
			{ event: 'admin-act', act: 'game-reset', by: OUTSIDER, tier: 'admin', ok: true, matchId: MATCH },
		]);
		expect(new Set(h.events.map((e) => e.key)).size, 'each its own incident key, so none is folded into another').toBe(2);
	});
});

describe('POST /api/rooms/:roomId/tables/:tableId/award', () => {
	it('a game in play is the seat’s: the other seat concedes it, so both screens end and the series records it', async () => {
		const h = await open({ pod: true });
		expect((await leader(h, OUTSIDER, `tables/${h.tableId}/award`, { seat: 0 }, 'wife')).status).toBe(200);
		expect(h.acts).toEqual([{ seat: 1, frame: { kind: 'act', method: 'concede' } }]);
		expect(h.awarded).toEqual([]);
		expect(h.stopped).toEqual([]);
	});

	it('a game that cannot end itself (still starting) is recorded for the seat and stopped', async () => {
		const h = await open({ pod: true, starting: true });
		expect((await leader(h, ALICE, `tables/${h.tableId}/award`, { seat: 1 })).status).toBe(200);
		expect(h.awarded).toEqual([{ table: h.tableId, winner: 1 }]);
		expect(h.stopped).toEqual([MATCH]);
	});

	it('the whole match is the seat’s: the series ends at the majority, the standings take it, the game in play is conceded', async () => {
		const h = await open({ pod: true });
		const res = await leader(h, OUTSIDER, `tables/${h.tableId}/award`, { seat: 1, match: true }, 'admin');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, wins: [0, 2] });
		expect(h.acts).toEqual([{ seat: 0, frame: { kind: 'act', method: 'concede' } }]);
		expect(h.ended).toEqual([h.tableId]);
		expect(h.lobby.get(h.roomId)!.game!.pod!.results).toEqual([{ round: 1, playerA: BOB, playerB: CAROL, gamesA: 0, gamesB: 2 }]);
	});

	it('a match of a round already paired past is refused, for the tournaments command', async () => {
		const h = await open({ pod: true });
		expect((await leader(h, CAROL, `tables/${h.tableId}/drop`)).status).toBe(200);
		const refused = await leader(h, ALICE, `tables/${h.tableId}/award`, { seat: 1, match: true });
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ error: 'that round is over: correct it with the tournaments command' });
	});

	it('refuses a player who is not the leader, a member-tier outsider, a bad body, and a match outside a pod', async () => {
		const h = await open({ pod: true });
		expect((await leader(h, BOB, `tables/${h.tableId}/award`, { seat: 0 }, 'member')).status).toBe(403);
		expect((await leader(h, BOB, `tables/${h.tableId}/award`, { seat: 0, match: true }, 'friend')).status).toBe(403);
		expect((await leader(h, OUTSIDER, `tables/${h.tableId}/award`, { seat: 0 }, 'member')).status).toBe(404);
		expect((await leader(h, ALICE, `tables/${h.tableId}/award`, { seat: 2 })).status).toBe(400);
		expect((await leader(h, ALICE, `tables/${h.tableId}/award`, { seat: 0, why: 'x' })).status).toBe(400);
		expect(h.acts).toEqual([]);
		const plain = await open();
		expect((await leader(plain, ALICE, `tables/${plain.tableId}/award`, { seat: 0, match: true })).status).toBe(409);
	});
});

describe('POST /api/rooms/:roomId/tables/:tableId/restore and /replay', () => {
	it('restore starts the game in play again at the start of its turn; nothing in play is refused', async () => {
		const h = await open({ pod: true });
		expect((await leader(h, BOB, `tables/${h.tableId}/restore`, {}, 'member')).status).toBe(403);
		const res = await leader(h, OUTSIDER, `tables/${h.tableId}/restore`, {}, 'wife');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, from: 'snapshot', turn: 7 });
		expect(h.restored).toEqual([MATCH]);
		h.lobby.releaseTableMatch(h.roomId, h.tableId);
		expect((await leader(h, ALICE, `tables/${h.tableId}/restore`)).status).toBe(409);
	});

	it('replay plays the match again from 0–0 with the same seats and no result, its game stopped', async () => {
		const h = await open({ pod: true });
		expect(h.lobby.recordGameResult(h.roomId, h.tableId, { matchId: MATCH, winner: 0 }).ok).toBe(true);
		expect(h.lobby.setTableMatch(h.roomId, h.tableId, MATCH)).toBe(true);
		expect((await leader(h, BOB, `tables/${h.tableId}/replay`, {}, 'friend')).status).toBe(403);
		expect((await leader(h, OUTSIDER, `tables/${h.tableId}/replay`, {}, 'admin')).status).toBe(200);
		expect(h.stopped).toEqual([MATCH]);
		expect(h.ended).toEqual([h.tableId]);
		expect(magicView(h.lobby.get(h.roomId))!.tables.find((t) => t.id === h.tableId)).toMatchObject({
			players: [{ memberId: BOB }, { memberId: CAROL }],
			matchId: null,
			series: { phase: 'seating', wins: [0, 0], games: [] },
		});
		expect(h.lobby.get(h.roomId)!.game!.pod!.results).toEqual([]);
	});
});

describe('GET /api/rooms/:roomId/admin/live', () => {
	const live = (h: Harness, as: string, tier?: string) => fetch(`${h.base}/api/rooms/${h.roomId}/admin/live`, { headers: { 'x-test-user': as, ...(tier === undefined ? {} : { 'x-hadoku-tier': tier }) } });

	it('lists every table under way with its match as it stands, for the leader or an operator only', async () => {
		const h = await open({ pod: true });
		expect((await live(h, BOB, 'member')).status).toBe(403);
		expect((await live(h, OUTSIDER, 'friend')).status).toBe(404);
		const res = await live(h, OUTSIDER, 'wife');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { round: number; tables: unknown[] };
		expect(body.round).toBe(1);
		expect(body.tables).toEqual([
			{
				tableId: h.tableId,
				players: [{ memberId: BOB, name: 'bob' }, { memberId: CAROL, name: 'carol' }],
				series: { phase: 'playing', wins: [0, 0], games: 0, length: 3 },
				matchId: MATCH,
				match: { status: 'running', startedAt: 0, turn: 7, active: 1, life: [20, 3], restoreTurn: 7, lastActivityAt: 0, seats: [] },
				epochs: [`${MATCH}-e1`],
			},
		]);
	});
});

describe('the room’s seat routes take an operator as the leader (before the lock)', () => {
	it('an operator stands a no-show up, puts the AI in their seat, closes a seat; a member or friend may not', async () => {
		// The room routes derive each caller from the edge's headers, as in production.
		const idOf = (user: string) => httpCaller({ headers: { 'x-user-id': user } } as unknown as Request);
		const [ALICE, BOB, CAROL, OUTSIDER] = ['user-alice', 'user-bob', 'user-carol', 'user-outsider'].map(idOf) as [ParticipantId, ParticipantId, ParticipantId, ParticipantId];
		const dir = await mkdtemp(join(tmpdir(), 'cardtable-admin-seats-'));
		const lobby = await openLobby({ dir });
		const made = lobby.create({ id: ALICE, name: 'alice', userId: null }, { name: 'sunday', gameType: 'constructed-1v1', clientMode: 'builtin', mode: { mode: 'classic', modeOptions: {} } });
		if (!made.ok) throw new Error(made.reason);
		const roomId = made.room.id;
		for (const p of [BOB, CAROL]) expect(lobby.join(roomId, { id: p, name: p, userId: null }).ok).toBe(true);
		expect(lobby.setSettings(roomId, ALICE, { tournament: true }).ok).toBe(true);
		standAll(lobby, roomId);
		expect(lobby.sitSeat(roomId, BOB, 0).ok && lobby.sitSeat(roomId, CAROL, 1).ok).toBe(true);
		const app = express();
		const api = express.Router();
		api.use(express.json());
		attachRooms(api, { lobby, log: () => undefined, checkPlan: async () => ({ ok: true, cards: 0 }) });
		app.use('/api', api);
		const server = createServer(app);
		await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
		cleanups.push(async () => {
			await new Promise<void>((done) => server.close(() => done()));
			await rm(dir, { recursive: true, force: true });
		});
		const h = { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, roomId } as Harness;
		const seats = () => lobby.get(roomId)!.game!.pod!.seats.map((s) => (s === null ? null : isPodAi(s.memberId) ? 'ai' : s.memberId));
		const userOf: Record<string, string> = { [BOB]: 'user-bob', [OUTSIDER]: 'user-outsider' };
		const as = (who: string, tier: string) => ({ 'x-user-id': userOf[who]!, 'x-hadoku-tier': tier });
		const post = (path: string, body: unknown, headers: Record<string, string>) =>
			fetch(`${h.base}/api/rooms/${roomId}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
		expect((await post('seats/remove', { memberId: CAROL }, as(BOB, 'member'))).status).toBe(403);
		expect((await post('seats/bot', { seat: 1 }, as(BOB, 'friend'))).status).toBe(403);
		expect(seats().slice(0, 2)).toEqual([BOB, CAROL]);
		expect((await post('seats/remove', { memberId: CAROL }, as(OUTSIDER, 'wife'))).status).toBe(200);
		expect(seats().slice(0, 2)).toEqual([BOB, null]);
		expect((await post('seats/bot', { seat: 0 }, as(OUTSIDER, 'admin'))).status).toBe(200);
		expect(seats()[0]).toBe('ai');
		expect((await post('pod/close', { seat: 1, closed: true }, as(OUTSIDER, 'wife'))).status).toBe(200);
		expect(lobby.get(roomId)!.members.map((m) => m.id), 'evicted to the spectator row, still in the room').toContain(BOB);
	});
});
