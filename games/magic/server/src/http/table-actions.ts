/*
 * A table's game, resolved from its card (`docs/planning/table-card-plan.md`; the operator, 2026-10-23:
 * *"it would be nice if the 'Return to game' button had options for concede and abandon. that would
 * allow us to resolve games without having to close rooms"*).
 *
 *   POST /api/rooms/:roomId/tables/:tableId/concede   the caller concedes the table's game in play
 *   POST /api/rooms/:roomId/tables/:tableId/abandon   a constructed table's series ends with no result
 *   POST /api/rooms/:roomId/tables/:tableId/drop      a pod's (draft or tournament) match is forfeited
 *   POST /api/rooms/:roomId/tables/:tableId/reset     the leader restarts the table's game in play
 *   POST /api/rooms/:roomId/tables/reset              the leader starts every table of the room over
 *   POST /api/rooms/:roomId/pod/dq { memberId }       the leader disqualifies a pod entrant
 *   POST /api/rooms/:roomId/tables/:tableId/award { seat, match? }  a game (or the whole match) is that seat's
 *   POST /api/rooms/:roomId/tables/:tableId/restore   the game in play goes back to the start of its turn
 *   POST /api/rooms/:roomId/tables/:tableId/replay    the match is played again from 0–0, no result
 *   GET  /api/rooms/:roomId/admin/live                every live match of the room, as it stands
 *
 * Everything after concede, abandon and drop is the room leader's, seated or watching (the operator,
 * 2026-10-30: *"the room leader is the admin"*), and an operator's: anyone the edge names `wife` or
 * `admin` (the operator, 2026-11-27, for the first big tournament: the raw edge tier, never the
 * member-promoting `tierOf`; friend and member are not included), in any room, member or not
 * (`isOperator`). Seating before the lock — a no-show stood up or replaced by the AI — is the room's own
 * seat routes (`room-core.ts`'s `/seats/remove`, `/seats/bot`), which take an operator the same way. A reset's games are stopped, with no result; a DQ'd entrant's game, or an
 * awarded one, is conceded for its loser (`endForfeitedGame`), so the other screen ends on its win.
 * Every one of them, done or refused, is reported as an `admin-act` server event naming who did it.
 *
 * A concede here is the board's own (`Match.fromClient`'s `concede` act, Forge's concede): the other seat
 * wins the game, and the series goes on from it as it does from any game (a Bo3 to its sideboarding).
 * Abandon and Drop are the room's (`Lobby.abandonTable`, `Lobby.dropTableMatch`): the series ends there,
 * and a game in play is stopped after the room has let go of it, so its end records nothing.
 *
 * A non-member is told there is no such room, as every room route tells them.
 */
import { Router, type Request, type Response } from 'express';
import type { ParticipantId } from '@wolffm/rooms-protocol';

import type { Lobby } from '../room/lobby.js';
import { magicView } from '../room/magic-view.js';
import type { Match } from '../play/match.js';
import { jsonLogger } from '@hadoku/service-kernel/log';
import { edgeTierOf, isOperator } from '@hadoku/service-kernel/auth';
import { httpCaller } from '@hadoku/game-server/http/request';
import { report } from '@hadoku/game-server/telemetry';
import type { MatchInspection } from '../play/match.js';
import { isAiEntrant } from '../room/pods.js';
import { PICK_TIMER_SPEED_MAX, PICK_TIMER_SPEED_MIN, PickTimerSchema } from '@hadoku/shared';

type TableMatch = Pick<Match, 'seatOf' | 'fromClient' | 'stop' | 'concedeFor' | 'concedeAi' | 'inspect' | 'unstick'>;

export interface TableActionsDeps {
	lobby: Pick<
		Lobby,
		'get' | 'isMember' | 'abandonTable' | 'dropTableMatch' | 'resetGame' | 'resetRoom' | 'dqPlayer' | 'awardMatch' | 'replayMatch' | 'setPickTimer'
	>;
	/** A live match by id, or undefined. */
	match(matchId: string): TableMatch | undefined;
	/** The game in play started again at its latest turn (`MatchRegistry.restore`); null: no such match. */
	restore(matchId: string): { from: 'snapshot'; turn: number } | { from: 'spec' } | null;
	/** The series ended here: its seats go back to their registered decks (`TablesHandle.seriesEnded`). */
	seriesEnded(roomId: string, tableId: string): void;
	/** The recordings a match's earlier epochs left, each served as a replay under its id (`earlierEpochs`). */
	epochsOf?: (matchId: string) => string[];
	/** A game recorded as `winner`'s with no game to end (`TablesHandle.awardGame`). */
	awardGame(roomId: string, tableId: string, winner: 0 | 1): boolean;
	/**
	 * The draft socket's hand on a running draft (`DraftSocketHandle.pickFor`): `memberId`'s seat picks by
	 * the draft bot now and at every pick until they come back (`on`), or no longer. Read when asked: play
	 * attaches the socket after these routes.
	 */
	draft?: () => { pickFor(roomId: string, memberId: string, on: boolean): 'ok' | 'not-drafting' | 'not-a-drafter' } | undefined;
	callerOf?: (req: Request) => ParticipantId;
	log?: (entry: Record<string, unknown>) => void;
	/** The server event every leader or operator act posts (`report`, service cardtable). */
	report?: (event: string, context: Record<string, string | number | boolean | null>) => void;
}

const NO_ROOM = { error: 'no such room' };

/**
 * A game the room let go of as `loser`'s forfeit (a DQ, or leaving mid-tournament): conceded for their
 * seat, so Forge ends it and the other screen shows the win, or stopped when they hold none (an AI
 * entrant). The room has already recorded the result; the game's own end records nothing more.
 */
export function endForfeitedGame(match: Pick<Match, 'seatOf' | 'concedeFor' | 'concedeAi' | 'stop'> | undefined, loser: string): void {
	if (match === undefined) return;
	const seat = match.seatOf(loser as ParticipantId);
	const conceded = seat !== null ? match.concedeFor(seat) : isAiEntrant(loser) && match.concedeAi();
	if (!conceded) match.stop();
}

/** The leader tools' refusals. */
const LEADER_REFUSED: Record<string, [number, string]> = {
	'no-room': [404, 'no such room'],
	'not-leader': [403, 'only the room leader can do that'],
	'no-such-table': [404, 'no such table'],
	'no-game': [409, 'there is no game in play at this table'],
	'no-pod': [409, 'there are no rounds under way'],
	'not-pod-table': [409, 'only a tournament or draft match has a result to award'],
	'round-over': [409, 'that round is over: correct it with the tournaments command'],
	'not-entrant': [404, 'that player is not in this tournament'],
	'already-dropped': [409, 'that player is already out'],
	'pod-under-way': [409, 'a draft or tournament under way can only be closed'],
	'not-drafting': [409, 'there is no draft running in this room'],
	'not-a-drafter': [404, 'that player is not drafting here'],
};

/** Each refusal of `Lobby.abandonTable` / `dropTableMatch`, as a status and the words the card shows. */
const REFUSED: Record<string, [number, string]> = {
	'no-room': [404, 'no such room'],
	'no-such-table': [404, 'no such table'],
	'not-seated': [403, 'only a player at this table can do that'],
	'pod-table': [409, 'a tournament or draft match is dropped, not abandoned'],
	'not-pod-table': [409, 'only a tournament or draft match can be dropped'],
	'nothing-to-abandon': [409, 'there is no series under way at this table'],
	'nothing-to-drop': [409, 'this match is already over'],
};

export function attachTableActions(api: Router, deps: TableActionsDeps): void {
	const log = deps.log ?? jsonLogger('cardtable-tables');
	const callerOf = deps.callerOf ?? httpCaller;
	const post = deps.report ?? report;
	const router = Router();

	/**
	 * Who may use a leader's tool here: the room's leader (the lobby checks that itself), or an operator
	 * (`isOperator`), whose `override` the lobby takes in place of it. Null once refused: a caller who
	 * is neither a member nor an operator is told there is no such room, as every room route tells them.
	 */
	const authority = (req: Request, res: Response, roomId: string): { me: ParticipantId; override: boolean } | null => {
		const me = callerOf(req);
		const override = isOperator(req);
		if (deps.lobby.get(roomId) === undefined || (!override && !deps.lobby.isMember(roomId, me))) {
			res.status(404).json(NO_ROOM);
			return null;
		}
		return { me, override };
	};

	/** One leader or operator act, done or refused: the server log, and a server event naming who did it. */
	const acted = (req: Request, act: string, roomId: string, outcome: Record<string, unknown>): void => {
		const by = callerOf(req);
		const tier = edgeTierOf(req);
		log({ evt: act, room: roomId, by, tier, ...outcome });
		const flat = (v: unknown): string | number | boolean | null => (v === undefined ? null : typeof v === 'object' && v !== null ? JSON.stringify(v) : (v as string | number | boolean | null));
		// Its own key, so no act is folded into another of the same minute (`monitoringSink`'s window).
		post('admin-act', { act, roomId, by, tier, key: `${act}:${roomId}:${String(Date.now())}:${Math.random().toString(36).slice(2, 8)}`, ...Object.fromEntries(Object.entries(outcome).map(([k, v]) => [k, flat(v)])) });
	};

	/** A refusal of the lobby's, as its status and words. */
	const refuse = (res: Response, reason: string): void => {
		const [status, error] = LEADER_REFUSED[reason] ?? [409, reason];
		res.status(status).json({ error });
	};

	/** The table a route names, read from the room as it is now. */
	const tableOf = (roomId: string, tableId: string) => magicView(deps.lobby.get(roomId))?.tables.find((t) => t.id === tableId);

	router.post('/:roomId/tables/:tableId/concede', (req: Request, res: Response) => {
		const roomId = String(req.params.roomId);
		const tableId = String(req.params.tableId);
		const me = callerOf(req);
		// A room of a game Magic does not play has no tables: no room here.
		const room = magicView(deps.lobby.get(roomId));
		if (room === undefined || !deps.lobby.isMember(roomId, me)) return res.status(404).json(NO_ROOM);
		const table = room.tables.find((t) => t.id === tableId);
		if (table === undefined) return res.status(404).json({ error: 'no such table' });
		const match = table.matchId === null ? undefined : deps.match(table.matchId);
		if (match === undefined) return res.status(409).json({ error: 'there is no game in play at this table' });
		const seat = match.seatOf(me);
		if (seat === null) return res.status(403).json({ error: 'only a player at this table can concede its game' });
		const outcome = match.fromClient(seat, { kind: 'act', method: 'concede' });
		log({ evt: 'table-concede', room: roomId, table: tableId, matchId: table.matchId, seat, ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error }) });
		if (!outcome.ok) return res.status(409).json({ error: outcome.error });
		res.json({ ok: true });
	});

	for (const action of ['abandon', 'drop'] as const) {
		router.post(`/:roomId/tables/:tableId/${action}`, (req: Request, res: Response) => {
			const roomId = String(req.params.roomId);
			const tableId = String(req.params.tableId);
			const me = callerOf(req);
			if (deps.lobby.get(roomId) === undefined || !deps.lobby.isMember(roomId, me)) return res.status(404).json(NO_ROOM);
			const done = action === 'abandon' ? deps.lobby.abandonTable(roomId, me, tableId) : deps.lobby.dropTableMatch(roomId, me, tableId);
			log({ evt: `table-${action}`, room: roomId, table: tableId, ok: done.ok, ...(done.ok ? { matchId: done.matchId } : { reason: done.reason }) });
			if (!done.ok) {
				const [status, error] = REFUSED[done.reason] ?? [409, done.reason];
				return res.status(status).json({ error });
			}
			if (done.matchId !== null) deps.match(done.matchId)?.stop();
			deps.seriesEnded(roomId, tableId);
			res.json({ ok: true });
		});
	}

	router.post('/:roomId/tables/:tableId/reset', (req: Request, res: Response) => {
		const roomId = String(req.params.roomId);
		const tableId = String(req.params.tableId);
		const who = authority(req, res, roomId);
		if (who === null) return;
		const done = deps.lobby.resetGame(roomId, who.me, tableId, who.override);
		acted(req, 'game-reset', roomId, { table: tableId, ok: done.ok, ...(done.ok ? { matchId: done.matchId } : { reason: done.reason }) });
		if (!done.ok) return refuse(res, done.reason);
		if (done.matchId !== null) deps.match(done.matchId)?.stop();
		res.json({ ok: true });
	});

	router.post('/:roomId/tables/reset', (req: Request, res: Response) => {
		const roomId = String(req.params.roomId);
		const who = authority(req, res, roomId);
		if (who === null) return;
		const done = deps.lobby.resetRoom(roomId, who.me, who.override);
		acted(req, 'room-reset', roomId, { ok: done.ok, ...(done.ok ? { matchIds: done.matchIds } : { reason: done.reason }) });
		if (!done.ok) return refuse(res, done.reason);
		for (const matchId of done.matchIds) deps.match(matchId)?.stop();
		for (const tableId of done.tableIds) deps.seriesEnded(roomId, tableId);
		res.json({ ok: true });
	});

	/**
	 * The pick timer, set mid-draft too (`Lobby.setPickTimer`): with it on, a drafter who closed their tab
	 * gets the draft bot's pick when their time runs out instead of holding the pod.
	 */
	router.post('/:roomId/draft/timer', (req: Request, res: Response) => {
		const roomId = String(req.params.roomId);
		const who = authority(req, res, roomId);
		if (who === null) return;
		const timer = PickTimerSchema.safeParse(req.body);
		if (!timer.success) return res.status(400).json({ error: `body: { on: boolean, speed: ${PICK_TIMER_SPEED_MIN}–${PICK_TIMER_SPEED_MAX} }` });
		const done = deps.lobby.setPickTimer(roomId, who.me, timer.data, who.override);
		acted(req, 'pick-timer-set', roomId, { ...timer.data, ok: done.ok, ...(done.ok ? {} : { reason: done.reason }) });
		if (!done.ok) return refuse(res, done.reason);
		res.json({ ok: true });
	});

	/** A drafter's seat picked for by the draft bot, now and until they come back (`on`), or no longer. */
	router.post('/:roomId/draft/pick-for', (req: Request, res: Response) => {
		const roomId = String(req.params.roomId);
		const who = authority(req, res, roomId);
		if (who === null) return;
		const body = req.body as Record<string, unknown> | undefined;
		const memberId = body?.memberId;
		const on = body?.on ?? true;
		if (typeof memberId !== 'string' || memberId === '' || typeof on !== 'boolean' || Object.keys(body ?? {}).some((k) => k !== 'memberId' && k !== 'on')) {
			return res.status(400).json({ error: 'body: { memberId, on? } and nothing else' });
		}
		if (!who.override && magicView(deps.lobby.get(roomId))?.leader !== who.me) {
			acted(req, 'pick-for', roomId, { memberId, on, ok: false, reason: 'not-leader' });
			return refuse(res, 'not-leader');
		}
		const done = deps.draft?.()?.pickFor(roomId, memberId, on) ?? 'not-drafting';
		acted(req, 'pick-for', roomId, { memberId, on, ok: done === 'ok', ...(done === 'ok' ? {} : { reason: done }) });
		if (done !== 'ok') return refuse(res, done);
		res.json({ ok: true });
	});

	router.post('/:roomId/pod/dq', (req: Request, res: Response) => {
		const roomId = String(req.params.roomId);
		const who = authority(req, res, roomId);
		if (who === null) return;
		const memberId = onlyField(req.body, 'memberId');
		if (typeof memberId !== 'string' || memberId === '') return res.status(400).json({ error: 'body: { memberId } and nothing else' });
		const done = deps.lobby.dqPlayer(roomId, who.me, memberId, who.override);
		acted(req, 'player-dq', roomId, { memberId, ok: done.ok, ...(done.ok ? { table: done.tableId, matchIds: done.matchIds } : { reason: done.reason }) });
		if (!done.ok) return refuse(res, done.reason);
		for (const matchId of done.matchIds) endForfeitedGame(deps.match(matchId), memberId);
		if (done.tableId !== null) deps.seriesEnded(roomId, done.tableId);
		res.json({ ok: true });
	});

	/**
	 * A game, or with `match: true` the whole match, is `seat`'s. A game in play ends as the other seat's
	 * concede (`Match.concedeFor`), so both screens end on it and the series records it as any game; a
	 * game that cannot end itself (still starting, failed, or none between games) is recorded straight
	 * (`awardGame`) and stopped. A match is the lobby's forfeit by the other seat (`Lobby.awardMatch`).
	 */
	router.post('/:roomId/tables/:tableId/award', (req: Request, res: Response) => {
		const roomId = String(req.params.roomId);
		const tableId = String(req.params.tableId);
		const who = authority(req, res, roomId);
		if (who === null) return;
		const body = req.body as Record<string, unknown> | undefined;
		const seat = body?.seat;
		const whole = body?.match ?? false;
		if ((seat !== 0 && seat !== 1) || typeof whole !== 'boolean' || Object.keys(body ?? {}).some((k) => k !== 'seat' && k !== 'match')) {
			return res.status(400).json({ error: 'body: { seat: 0 | 1, match?: boolean }' });
		}
		const loserSeat = seat === 0 ? 1 : 0;
		if (whole) {
			const done = deps.lobby.awardMatch(roomId, who.me, tableId, seat, who.override);
			acted(req, 'match-awarded', roomId, { table: tableId, seat, ok: done.ok, ...(done.ok ? { matchId: done.matchId, wins: done.wins } : { reason: done.reason }) });
			if (!done.ok) return refuse(res, done.reason);
			if (done.matchId !== null) {
				const match = deps.match(done.matchId);
				if (done.loser !== null) endForfeitedGame(match, done.loser);
				else match?.stop();
			}
			deps.seriesEnded(roomId, tableId);
			return res.json({ ok: true, wins: done.wins });
		}
		if (!who.override && magicView(deps.lobby.get(roomId))?.leader !== who.me) {
			acted(req, 'game-awarded', roomId, { table: tableId, seat, ok: false, reason: 'not-leader' });
			return refuse(res, 'not-leader');
		}
		const table = tableOf(roomId, tableId);
		if (table === undefined) return refuse(res, 'no-such-table');
		if (table.series.phase === 'done') {
			acted(req, 'game-awarded', roomId, { table: tableId, seat, ok: false, reason: 'already-over' });
			return res.status(409).json({ error: 'this match is already over: award the match instead' });
		}
		// A match's seats are its table's, in order (`seatOrder`), so the losing seat is the same number in both.
		const match = table.matchId === null ? undefined : deps.match(table.matchId);
		const conceded = match !== undefined && match.concedeFor(loserSeat);
		if (!conceded) {
			deps.awardGame(roomId, tableId, seat);
			match?.stop();
		}
		acted(req, 'game-awarded', roomId, { table: tableId, seat, ok: true, matchId: table.matchId, how: conceded ? 'concede' : 'recorded' });
		res.json({ ok: true });
	});

	/** The game in play starts again at the start of its latest turn, on a new JVM (`MatchRegistry.restore`): a softlock's way out. */
	router.post('/:roomId/tables/:tableId/restore', (req: Request, res: Response) => {
		const roomId = String(req.params.roomId);
		const tableId = String(req.params.tableId);
		const who = authority(req, res, roomId);
		if (who === null) return;
		if (!who.override && magicView(deps.lobby.get(roomId))?.leader !== who.me) {
			acted(req, 'game-restored', roomId, { table: tableId, ok: false, reason: 'not-leader' });
			return refuse(res, 'not-leader');
		}
		const table = tableOf(roomId, tableId);
		if (table === undefined) return refuse(res, 'no-such-table');
		// A turn its snapshot cannot hold is never restored, as a player's Restart turn refuses it (`restorable`).
		const lossy = table.matchId === null ? [] : (deps.match(table.matchId)?.inspect().restoreLossy ?? []);
		if (lossy.length > 0) {
			acted(req, 'game-restored', roomId, { table: tableId, matchId: table.matchId, ok: false, reason: 'lossy', lossy });
			return res.status(409).json({ error: `this turn cannot be restored exactly (${lossy.join(', ')}): reset the game or award it` });
		}
		const restored = table.matchId === null ? null : deps.restore(table.matchId);
		acted(req, 'game-restored', roomId, { table: tableId, matchId: table.matchId, ok: restored !== null, ...(restored === null ? { reason: 'no-game' } : { from: restored.from, turn: 'turn' in restored ? restored.turn : null }) });
		if (restored === null) return refuse(res, 'no-game');
		res.json({ ok: true, from: restored.from, ...('turn' in restored ? { turn: restored.turn } : {}) });
	});

	/** The match is played again from its first game, with no result (`Lobby.replayMatch`). */
	/**
	 * A game that does not move though no screen shows anything to do: every human seat is sent again what
	 * Forge waits on and what the server holds for it (`Match.unstick`). Answers, per seat, what Forge waits
	 * on beside what the seat had been shown, so the room can see which it was. Changes nothing in the game.
	 */
	router.post('/:roomId/tables/:tableId/unstick', async (req: Request, res: Response) => {
		const roomId = String(req.params.roomId);
		const tableId = String(req.params.tableId);
		const who = authority(req, res, roomId);
		if (who === null) return;
		if (!who.override && magicView(deps.lobby.get(roomId))?.leader !== who.me) {
			acted(req, 'asks-resent', roomId, { table: tableId, ok: false, reason: 'not-leader' });
			return refuse(res, 'not-leader');
		}
		const table = tableOf(roomId, tableId);
		if (table === undefined) return refuse(res, 'no-such-table');
		const match = table.matchId === null ? undefined : deps.match(table.matchId);
		if (match === undefined) return refuse(res, 'no-game');
		const seats = await match.unstick();
		acted(req, 'asks-resent', roomId, { table: tableId, matchId: table.matchId, ok: true, seats });
		res.json({ ok: true, seats });
	});

	router.post('/:roomId/tables/:tableId/replay', (req: Request, res: Response) => {
		const roomId = String(req.params.roomId);
		const tableId = String(req.params.tableId);
		const who = authority(req, res, roomId);
		if (who === null) return;
		const done = deps.lobby.replayMatch(roomId, who.me, tableId, who.override);
		acted(req, 'match-replayed', roomId, { table: tableId, ok: done.ok, ...(done.ok ? { matchId: done.matchId } : { reason: done.reason }) });
		if (!done.ok) return refuse(res, done.reason);
		if (done.matchId !== null) deps.match(done.matchId)?.stop();
		deps.seriesEnded(roomId, tableId);
		res.json({ ok: true });
	});

	/** Every table of the room's current round (or, outside a pod, under way), and its live match as it stands (`Match.inspect`). */
	router.get('/:roomId/admin/live', (req: Request, res: Response) => {
		const roomId = String(req.params.roomId);
		const who = authority(req, res, roomId);
		if (who === null) return;
		const room = magicView(deps.lobby.get(roomId));
		if (room === undefined) return res.status(404).json(NO_ROOM);
		if (!who.override && room.leader !== who.me) return refuse(res, 'not-leader');
		const now = Date.now();
		// A pod's: the current round's tables, finished ones too. Any other room's: what is under way.
		const pairings = room.game?.pod?.pairings;
		const round = pairings === undefined ? null : new Set(pairings.map((p) => p.tableId));
		const tables: LiveTable[] = room.tables
			.filter((t) => (round !== null ? round.has(t.id) : t.matchId !== null || (t.series.phase !== 'seating' && t.series.phase !== 'done')))
			.map((t) => {
				const match = t.matchId === null ? undefined : deps.match(t.matchId);
				return {
					tableId: t.id,
					players: t.players,
					series: { phase: t.series.phase, wins: t.series.wins, games: t.series.games.length, length: t.series.length },
					matchId: t.matchId,
					match: match?.inspect() ?? null,
					epochs: t.matchId === null ? [] : (deps.epochsOf?.(t.matchId) ?? []),
				};
			});
		res.json({ now, round: room.game?.pod?.round ?? null, tables });
	});

	api.use('/rooms', router);
}

/** `GET …/admin/live`'s one table. */
export interface LiveTable {
	tableId: string;
	/** The humans at it, by seat; an AI seat is the match's (`MatchInspection.seats[].ai`). */
	players: { memberId: string; name: string }[];
	series: { phase: string; wins: readonly number[]; games: number; length: number };
	matchId: string | null;
	match: MatchInspection | null;
	/** The game before each restore of its match, as replay ids (`#/replay/<id>`). */
	epochs: string[];
}

/** A body of exactly one field, `key`: its value, or undefined for any other shape. */
function onlyField(body: unknown, key: string): unknown {
	if (typeof body !== 'object' || body === null) return undefined;
	const keys = Object.keys(body);
	return keys.length === 1 && keys[0] === key ? (body as Record<string, unknown>)[key] : undefined;
}
