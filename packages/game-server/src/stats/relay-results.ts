/**
 * A relay game's round results, reported to the game-stats store.
 *
 * The relay is opaque end to end (`play/relay-socket.ts` fans a seat's message out without
 * reading it), so no server-side place sees a round end. The match host's page POSTs each round's
 * result instead: `POST /api/rooms/:id/result { matchId, result }`, where `result` is whatever
 * the game's bundle reports and `matchId` is the ROUND's own id, minted by the host (the store
 * keeps the first report per id, so one id per room would drop every round after the first).
 *
 * The game turns its own payload into the store's report (`toReport`). Everything else is here:
 * who may report (the room's leader, or anyone seated, since whoever pressed Start hosts), the id
 * check, and who sits where.
 *
 * ## Identity comes from the server, never from the result
 *
 * The result names players by the `clientId` the match roster gave them. Each is looked up in
 * the seats as the server holds them (`buildFrozenSeats`), so a host cannot attribute a seat to
 * anyone the server did not seat. A human with a friend key reports `kind: 'user'` with that key,
 * which prefs-api resolves and discards; a human without one is a `guest`. Never a userId: that
 * would be a claim, and the key is a credential. It lives in server memory, goes to prefs-api and
 * nowhere else, never onto the wire nor into a log line.
 */

import type { Request, Response, Router } from 'express';
import { MATCH_ID_PATTERN, type MatchReport } from '@wolffm/prefs-client/games';
import { AI_SEAT, CLOSED_SEAT } from '@hadoku/platform-wire/seats';
import { participantHandle } from '@wolffm/rooms-protocol';

import { callerOf } from '../http/request.js';
import type { StatsReporter } from './reporter.js';

/** Who sat in one slot when the round ended: what a game's `toReport` names players by. */
export type FrozenSeat =
	| { playerId: number; clientId: string; kind: 'user'; userKey: string; name: string }
	| { playerId: number; clientId: string; kind: 'guest' | 'bot'; name: string };

/** What a game's `toReport` is handed beside its own payload. */
export interface RoundContext {
	matchId: string;
	roomId: string;
	endedAt: number;
	seats: readonly FrozenSeat[];
}

export type ReportOutcome = { ok: true; report: MatchReport } | { ok: false; reason: string };

/** A room as this reads it: who holds each seat, its members, and its bots' names. */
export interface ResultRoom {
	leader: string;
	seats: readonly (string | null)[];
	members: readonly { id: string; name: string }[];
	aiSeats?: readonly ({ name: string } | null)[];
}

/**
 * Who sits in each occupied seat NOW, in seat order, with a dense `playerId` — the match roster's
 * own numbering. A human's `clientId` is their full participant id (the roster's); a bot's is
 * `botClientId(seat)`, by SEAT number, never by how many bots came before it, so it agrees with
 * the roster whichever seats the bots took. A bot is named as the room names it (`aiSeats`).
 */
export function buildFrozenSeats(
	room: Pick<ResultRoom, 'seats' | 'members' | 'aiSeats'>,
	userKeys: ReadonlyMap<string, string>,
	botClientId: (seat: number) => string = (seat) => `ai:${seat}`,
): FrozenSeat[] {
	const seats: FrozenSeat[] = [];
	let bots = 0;
	for (const [seat, holder] of room.seats.entries()) {
		if (holder === null || holder === CLOSED_SEAT) continue;
		const playerId = seats.length;
		if (holder === AI_SEAT) {
			bots += 1;
			seats.push({ playerId, clientId: botClientId(seat), kind: 'bot', name: room.aiSeats?.[seat]?.name ?? `Bot ${bots}` });
			continue;
		}
		const name = room.members.find((m) => m.id === holder)?.name ?? participantHandle(holder);
		const userKey = userKeys.get(holder);
		seats.push(userKey === undefined ? { playerId, clientId: holder, kind: 'guest', name } : { playerId, clientId: holder, kind: 'user', userKey, name });
	}
	return seats;
}

export interface ResultRouteDeps {
	lobby: { get(roomId: string): ResultRoom | undefined };
	/** Each `/room` connection's friend key, by participant id. */
	userKeys: ReadonlyMap<string, string>;
	stats: StatsReporter;
	/** The game's own: its bundle's payload, as the store's report, or why not. */
	toReport(raw: unknown, ctx: RoundContext): ReportOutcome;
	botClientId?: (seat: number) => string;
	log: (line: Record<string, unknown>) => void;
	now?: () => number;
}

/** Mount `POST /rooms/:id/result` on `api` (mounted at `/api`, below the tier floor). */
export function attachResultRoute(api: Router, deps: ResultRouteDeps): void {
	const now = deps.now ?? Date.now;
	api.post('/rooms/:id/result', (req: Request, res: Response) => {
		const roomId = String(req.params.id);
		const room = deps.lobby.get(roomId);
		if (room === undefined) {
			res.status(404).json({ error: 'no such room' });
			return;
		}
		const caller = callerOf(req);
		if (room.leader !== caller.id && !room.seats.includes(caller.id)) {
			res.status(403).json({ error: 'only a seated player may report a result' });
			return;
		}
		const body = req.body as { result?: unknown; matchId?: unknown } | undefined;
		const matchId = body?.matchId;
		if (typeof matchId !== 'string' || !MATCH_ID_PATTERN.test(matchId)) {
			res.status(400).json({ error: "a result needs its round's own matchId" });
			return;
		}
		const seats = buildFrozenSeats(room, deps.userKeys, deps.botClientId);
		const built = deps.toReport(body?.result, { matchId, roomId, endedAt: now(), seats });
		if (!built.ok) {
			deps.log({ evt: 'stats-refused', roomId, reason: built.reason });
			res.status(built.reason === 'bad-result' ? 400 : 422).json({ ok: false, error: built.reason });
			return;
		}
		deps.stats.report(built.report);
		res.json({ ok: true });
	});
}
