/*
 * A table's game, resolved from its card (`docs/planning/table-card-plan.md`; the operator, 2026-10-23:
 * *"it would be nice if the 'Return to game' button had options for concede and abandon. that would
 * allow us to resolve games without having to close rooms"*).
 *
 *   POST /api/rooms/:roomId/tables/:tableId/concede   the caller concedes the table's game in play
 *
 * A concede here is the board's own (`Match.fromClient`'s `concede` act, Forge's concede): the other seat
 * wins the game, and the series goes on from it as it does from any game (a Bo3 to its sideboarding).
 * A non-member is told there is no such room, as every room route tells them.
 */
import { Router, type Request, type Response } from 'express';
import type { ParticipantId } from '@wolffm/rooms-protocol';

import type { Lobby } from '../room/lobby.js';
import type { Match } from '../play/match.js';
import { jsonLogger } from '../log.js';
import { httpCaller } from './request.js';

export interface TableActionsDeps {
	lobby: Pick<Lobby, 'get' | 'isMember'>;
	/** A live match by id, or undefined. */
	match(matchId: string): Pick<Match, 'seatOf' | 'fromClient'> | undefined;
	callerOf?: (req: Request) => ParticipantId;
	log?: (entry: Record<string, unknown>) => void;
}

const NO_ROOM = { error: 'no such room' };

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

	api.use('/rooms', router);
}
