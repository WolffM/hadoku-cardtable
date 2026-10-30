/*
 * A table's game, resolved from its card (`docs/planning/table-card-plan.md`; the operator, 2026-10-23:
 * *"it would be nice if the 'Return to game' button had options for concede and abandon. that would
 * allow us to resolve games without having to close rooms"*).
 *
 *   POST /api/rooms/:roomId/tables/:tableId/concede   the caller concedes the table's game in play
 *   POST /api/rooms/:roomId/tables/:tableId/abandon   a constructed table's series ends with no result
 *   POST /api/rooms/:roomId/tables/:tableId/drop      a pod's (draft or tournament) match is forfeited
 *   POST /api/rooms/:roomId/tables/:tableId/reset     the leader restarts the table's game in play
 *   POST /api/rooms/:roomId/pod/dq { memberId }       the leader disqualifies a pod entrant
 *
 * The last two are the room leader's, seated or watching (the operator, 2026-10-30: *"there is no
 * concept of an admin for now. the room leader is the admin"*): `Lobby.resetGame`, `Lobby.dqPlayer`.
 * A reset's game is stopped, with no result; a DQ'd entrant's game is conceded for them
 * (`endForfeitedGame`), so the other screen ends on its win.
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
import type { Match } from '../play/match.js';
import { jsonLogger } from '../log.js';
import { httpCaller } from './request.js';

export interface TableActionsDeps {
	lobby: Pick<Lobby, 'get' | 'isMember' | 'abandonTable' | 'dropTableMatch' | 'resetGame' | 'dqPlayer'>;
	/** A live match by id, or undefined. */
	match(matchId: string): Pick<Match, 'seatOf' | 'fromClient' | 'stop'> | undefined;
	/** The series ended here: its seats go back to their registered decks (`TablesHandle.seriesEnded`). */
	seriesEnded(roomId: string, tableId: string): void;
	callerOf?: (req: Request) => ParticipantId;
	log?: (entry: Record<string, unknown>) => void;
}

const NO_ROOM = { error: 'no such room' };

/**
 * A game the room let go of as `loser`'s forfeit (a DQ, or leaving mid-tournament): conceded for their
 * seat, so Forge ends it and the other screen shows the win, or stopped when they hold none (an AI
 * entrant). The room has already recorded the result; the game's own end records nothing more.
 */
export function endForfeitedGame(match: Pick<Match, 'seatOf' | 'fromClient' | 'stop'> | undefined, loser: string): void {
	if (match === undefined) return;
	const seat = match.seatOf(loser as ParticipantId);
	if (seat === null || !match.fromClient(seat, { kind: 'act', method: 'concede' }).ok) match.stop();
}

/** The leader tools' refusals. */
const LEADER_REFUSED: Record<string, [number, string]> = {
	'no-room': [404, 'no such room'],
	'not-leader': [403, 'only the room leader can do that'],
	'no-such-table': [404, 'no such table'],
	'no-game': [409, 'there is no game in play at this table'],
	'no-pod': [409, 'there are no rounds under way'],
	'not-entrant': [404, 'that player is not in this tournament'],
	'already-dropped': [409, 'that player is already out'],
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
	const router = Router();

	router.post('/:roomId/tables/:tableId/concede', (req: Request, res: Response) => {
		const roomId = String(req.params.roomId);
		const tableId = String(req.params.tableId);
		const me = callerOf(req);
		const room = deps.lobby.get(roomId);
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
		const me = callerOf(req);
		if (deps.lobby.get(roomId) === undefined || !deps.lobby.isMember(roomId, me)) return res.status(404).json(NO_ROOM);
		const done = deps.lobby.resetGame(roomId, me, tableId);
		log({ evt: 'game-reset', room: roomId, table: tableId, by: me, ok: done.ok, ...(done.ok ? { matchId: done.matchId } : { reason: done.reason }) });
		if (!done.ok) {
			const [status, error] = LEADER_REFUSED[done.reason] ?? [409, done.reason];
			return res.status(status).json({ error });
		}
		deps.match(done.matchId)?.stop();
		res.json({ ok: true });
	});

	router.post('/:roomId/pod/dq', (req: Request, res: Response) => {
		const roomId = String(req.params.roomId);
		const me = callerOf(req);
		if (deps.lobby.get(roomId) === undefined || !deps.lobby.isMember(roomId, me)) return res.status(404).json(NO_ROOM);
		const body: unknown = req.body;
		const memberId = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).memberId : undefined;
		if (typeof memberId !== 'string' || memberId === '' || Object.keys(body as object).length !== 1) return res.status(400).json({ error: 'body: { memberId } and nothing else' });
		const done = deps.lobby.dqPlayer(roomId, me, memberId);
		log({ evt: 'player-dq', room: roomId, by: me, memberId, ok: done.ok, ...(done.ok ? { table: done.tableId, matchIds: done.matchIds } : { reason: done.reason }) });
		if (!done.ok) {
			const [status, error] = LEADER_REFUSED[done.reason] ?? [409, done.reason];
			return res.status(status).json({ error });
		}
		for (const matchId of done.matchIds) endForfeitedGame(deps.match(matchId), memberId);
		if (done.tableId !== null) deps.seriesEnded(roomId, done.tableId);
		res.json({ ok: true });
	});

	api.use('/rooms', router);
}
