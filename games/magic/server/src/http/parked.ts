/**
 * The parked games' routes (`play/parked.ts`): a player's unfinished games, and picking one up again.
 *
 *   GET  /api/play/parked                  the caller's parked games, newest first
 *   POST /api/play/parked/:matchId/resume  a new room playing the game from its snapshot, or the
 *                                          room it was already resumed in
 *
 * Resuming (the operator, 2026-11-02: *"resuming then means creating a new room and reconstructing
 * the game from snapshot"*) starts the match first, through play's own start (`PlayHandle.start`:
 * the ceiling, the drain, the queue), with every seat already held by the player who held it; only
 * a match Forge has opened gets a room. So a restore that fails — a card this build of Forge no
 * longer reads, say — answers its error and leaves the record and the lobby as they were. The room
 * is the original's settings under its name, with the caller as its leader, the other player (if
 * one) a member, and both seated at its table in the game's seat order: the table's seat is the
 * match's seat, which is how the series and the stats name the winner. The second player to resume
 * the same game is sent to that room (`resumedAs`) for as long as its match is being played.
 */

import type { Request, Response, Router } from 'express';
import type { RateLimitConfig } from '@wolffm/rooms-server';
import { draftIdOfPool, type Lobby } from '../room/lobby.js';
import type { ParkedStore, ParkedSummary } from '../play/parked.js';
import type { PlayHandle } from '../play/socket.js';
import { callerOf, httpCaller, perCallerLimit } from '@hadoku/game-server/http/request';
import { ROOM_CREATE_RATE_LIMIT } from './rooms.js';
import { MAX_MATCHES_PER_PERSON } from './routes.js';

/** A parked game as its player's list draws it. */
export interface ParkedGame {
	matchId: string;
	/** The room it was played in. */
	room: string;
	format: string;
	turn: number;
	parkedAt: string;
	/** In seat order: each player's (or the AI's) name and deck, and which is the caller's. */
	seats: { name: string; deck: string | null; ai: boolean; you: boolean }[];
	/** The room it is being played in again, while it is. */
	resumed: { roomId: string; tableId: string } | null;
}

/** Where a resume sends the player. */
interface Resumed {
	roomId: string;
	tableId: string;
	matchId: string;
}

type ResumeOutcome = { ok: true; status: 200 | 201; body: Resumed } | { ok: false; status: number; error: string };

export interface ParkedRoutesDeps {
	store: ParkedStore;
	lobby: Pick<Lobby, 'create' | 'join' | 'get' | 'seats' | 'sit' | 'stand' | 'setFormat' | 'setSettings' | 'setTableMatch'>;
	/** Read lazily: play is attached after the routes. Null without Forge. */
	play(): Pick<PlayHandle, 'matches' | 'start'> | null;
	log(entry: Record<string, unknown>): void;
	/** Overrides `ROOM_CREATE_RATE_LIMIT`: a resume makes a room. `null` is none (`perCallerLimit`). */
	resumeRateLimit?: RateLimitConfig | null;
}

export function attachParked(api: Router, deps: ParkedRoutesDeps): void {
	const { store, lobby, log } = deps;
	const resumeLimit = perCallerLimit(deps.resumeRateLimit === undefined ? ROOM_CREATE_RATE_LIMIT : deps.resumeRateLimit, 'too many resumed games; wait a little and try again', {
		act: 'game-resume',
		onRefused: () => log({ evt: 'parked-resume-refused', reason: 'rate-limited' }),
	});
	/** Resumes in flight, by parked match: a second player's resume waits for the first's room. */
	const resuming = new Map<string, Promise<ResumeOutcome>>();

	/** The room a parked game is being played in again, while its match is being played. */
	const liveResume = (summary: ParkedSummary): Resumed | null => {
		const as = summary.resumedAs;
		const status = as === undefined ? undefined : deps.play()?.matches.get(as.matchId)?.status;
		return as !== undefined && (status === 'starting' || status === 'running') ? { roomId: as.roomId, tableId: as.tableId, matchId: as.matchId } : null;
	};

	api.get('/play/parked', (req: Request, res: Response) => {
		const me = httpCaller(req);
		const games: ParkedGame[] = store.listFor(me).map((s) => {
			const resumed = liveResume(s);
			return {
				matchId: s.matchId,
				room: s.room.name,
				format: s.formatName,
				turn: s.turn,
				parkedAt: s.parkedAt,
				seats: s.seats.map((seat) => ({ name: seat.name, deck: seat.deckName, ai: seat.ai, you: seat.owner === me })),
				resumed: resumed === null ? null : { roomId: resumed.roomId, tableId: resumed.tableId },
			};
		});
		res.json({ games });
	});

	async function resume(req: Request, matchId: string): Promise<ResumeOutcome> {
		const record = store.get(matchId);
		if (record === null) return { ok: false, status: 404, error: 'no such parked game' };
		const play = deps.play();
		if (play === null) return { ok: false, status: 503, error: 'Forge is not configured on this server' };
		const caller = callerOf(req);
		const humans = record.seats.flatMap((s) => (s.owner === null ? [] : [s.owner]));
		const playing = play.matches.active().filter((m) => m.status === 'starting' || m.status === 'running');
		const full = record.seats.find((s) => s.owner !== null && playing.filter((m) => m.seatOf(s.owner!) !== null).length >= MAX_MATCHES_PER_PERSON);
		if (full !== undefined) return { ok: false, status: 409, error: `${full.name} is already playing ${MAX_MATCHES_PER_PERSON} matches` };

		const started = await play.start(req, record.spec, humans, {
			owners: record.seats.map((s) => s.owner),
			snapshot: record.snapshot,
			...(record.clockMs === undefined ? {} : { clockMs: record.clockMs }),
		});
		if (!started.ok) {
			log({ evt: 'parked-resume-failed', matchId, turn: record.turn, pin: record.pin, error: started.error });
			return { ok: false, status: started.status, error: `This game could not be picked up again: ${started.error}` };
		}
		const { match } = started;
		const made = lobby.create(caller, {
			name: record.room.name,
			gameType: 'constructed-1v1',
			clientMode: record.room.clientMode,
			// A Gauntlet's or a tournament's table is driven by its own rounds; the game goes on in a plain table.
			...(record.room.mode === null || record.room.mode.mode === 'gauntlet' ? {} : { mode: record.room.mode }),
		});
		if (!made.ok) {
			match.stop();
			return { ok: false, status: 400, error: 'a room needs a signed-in player' };
		}
		const roomId = made.room.id;
		const tableId = made.room.tables[0]!.id;
		for (const s of record.seats) if (s.owner !== null && s.owner !== caller.id) lobby.join(roomId, { id: s.owner, name: s.name, userId: null });
		if (record.room.gameType === 'constructed-1v1' && draftIdOfPool(record.room.format) === null) lobby.setFormat(roomId, caller.id, record.room.format);
		lobby.setSettings(roomId, caller.id, { ...record.room.settings, tournament: false });
		// The table's seats in the match's order, whoever a join seated first.
		for (const seated of lobby.seats(roomId, tableId)) lobby.stand(roomId, tableId, seated.memberId);
		for (const owner of humans) lobby.sit(roomId, tableId, owner);
		lobby.setTableMatch(roomId, tableId, match.id);
		store.resumed(matchId, { roomId, tableId, matchId: match.id });
		log({ evt: 'parked-resume', matchId, as: match.id, room: roomId, turn: record.turn, pin: record.pin });
		return { ok: true, status: 201, body: { roomId, tableId, matchId: match.id } };
	}

	api.post('/play/parked/:matchId/resume', async (req: Request, res: Response) => {
		const matchId = String(req.params.matchId);
		const me = httpCaller(req);
		const summary = store.listFor(me).find((s) => s.matchId === matchId);
		if (summary === undefined) {
			res.status(404).json({ error: 'no such parked game of yours' });
			return;
		}
		const live = liveResume(summary);
		if (live !== null) {
			res.status(200).json(live);
			return;
		}
		let pending = resuming.get(matchId);
		if (pending === undefined) {
			// Only the ask that starts the game spends a token: one that joins it waits for its room.
			if (!resumeLimit(req, res)) return;
			pending = resume(req, matchId).finally(() => resuming.delete(matchId));
			resuming.set(matchId, pending);
		}
		const outcome = await pending;
		if (outcome.ok) res.status(outcome.status).json(outcome.body);
		else res.status(outcome.status).json({ error: outcome.error });
	});
}
