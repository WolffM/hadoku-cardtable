/**
 * One live tab per player per room: `@wolffm/rooms-server`'s `SessionClaims`, on this server's sockets.
 *
 * The operator, 2026-11-07: *"whenever a player tried to join a game when they already have an active
 * session we should … show a prompt in the middle of the screen … asking whether they want to take
 * over in this session? if they click yes, then we terminate their previous session."* The rule is
 * the shared room layer's (`SessionClaims`' header, and `@wolffm/rooms-protocol`'s `session.ts` for the
 * wire); this file is where cardtable's sockets meet it.
 *
 * ## Which sockets
 *
 * A tab's screen gate (`apps/ui/src/room/session.ts`) opens one socket per room and sends
 * `session:claim` on it: that is the claim the player is asked about. The tab's other sockets for the
 * room join the same claim when they join as a player (`attach`): the pod's draft socket
 * (`room/socket.ts`) and the match socket (`play/socket.ts`), each naming its tab. So a take retires
 * every connection the old tab has in the room, its live match included, and a socket of a tab that
 * does not hold the room is refused its player's join (`session-elsewhere`) instead of silently
 * taking the seat.
 *
 * ## Who
 *
 * A player only (`isPlayer`): a seat at one of the room's tables, a place in its pod or draft, or a
 * seat in its match. Watchers keep as many tabs as they like, and their claim answers `watcher`
 * holding nothing. The screen claims again whenever its room changes, so a watcher who sits down is
 * then a player with a claim, and a player who stands up lets go of it.
 *
 * ## The room's key
 *
 * The room id the screen is in, and for a match that no room holds (a scenario, a direct game against
 * the AI) the match's own id: the same id `App.tsx`'s `roomIdFor` gives the screen.
 *
 * ## Liveness
 *
 * Every holding session socket is sent `session:beat` every `BEAT_MS`, and its ack is a heartbeat. A
 * beat is a message, so a hidden tab whose timers the browser throttles still answers at once; an
 * engine.io pong is one too, for every attached socket. A holder silent past `IDLE_MS` — a closed
 * laptop, a dropped network, a socket whose ping has not timed out yet — is replaced without asking.
 *
 * ## A take
 *
 * The old tab's sockets are told `session:taken` and closed from here. A server-side close does not
 * auto-reconnect, so the old tab cannot loop back into the room; it offers to take the session back,
 * which is the same claim with `take`. Every take reports `session-takeover` with the room and whether
 * the holder was live or stale.
 */

import type { Server as SocketIOServer, Socket } from 'socket.io';
import { SessionClaims, type SessionClaimDecision } from '@wolffm/rooms-server';
import { SESSION_EVENTS, parseSessionClaim, type SessionClaimAnswer, type SessionTaken } from '@wolffm/rooms-protocol';

import { identityFromHeaders } from './identity.js';
import { jsonLogger, type JsonLog } from '../log.js';
import { callerContext, report } from '../telemetry.js';

/** How often a holding session socket is asked whether it is alive. */
export const BEAT_MS = 5_000;
/** A holder that has answered nothing for this long is stale: two missed beats and change. */
export const IDLE_MS = 15_000;

export interface SessionDeps {
	/** Whether `participantId` plays in `room` (see the header's "Who"). */
	isPlayer(room: string, participantId: string): boolean;
	log?: JsonLog;
	beatMs?: number;
	idleMs?: number;
	now?: () => number;
}

export interface SessionHandle {
	/**
	 * A room socket of tab `tabId` joining `room` as `participantId`. False when another live tab of the
	 * account holds the room: refuse the player's join. True for a watcher, who holds nothing.
	 */
	attach(room: string, participantId: string, tabId: string, socket: Socket): boolean;
	close(): void;
}

const defaultLog = jsonLogger('cardtable-session');

const keyOf = (participantId: string, room: string): string => `${participantId}\n${room}`;

export function attachSessions(io: SocketIOServer, deps: SessionDeps): SessionHandle {
	const log = deps.log ?? defaultLog;
	const claims = new SessionClaims({ idleMs: deps.idleMs ?? IDLE_MS, ...(deps.now === undefined ? {} : { now: deps.now }) });
	/** Session sockets (the ones that sent a claim), which answer beats. */
	const sessionSockets = new Map<string, Socket>();

	/** A take's bookkeeping: close the old tab's sockets, say so, count it. */
	const took = (room: string, participantId: string, socket: Socket, decision: Extract<SessionClaimDecision, { type: 'taken' }>): void => {
		for (const id of decision.retire) {
			const old = io.sockets.sockets.get(id);
			if (old === undefined) continue;
			old.emit(SESSION_EVENTS.taken, { room } satisfies SessionTaken);
			old.disconnect(true);
		}
		const holder = decision.stale ? 'stale' : 'live';
		log({ evt: 'session-taken', room, participantId, socketId: socket.id, holder, retired: decision.retire.length });
		report('session-takeover', { room, holder, key: room, ...callerContext(socket.request.headers) });
	};

	io.on('connection', (socket) => {
		const participantId = identityFromHeaders(socket.request.headers, socket.id);
		socket.conn.on('heartbeat', () => {
			claims.heartbeat(socket.id);
		});

		socket.on(SESSION_EVENTS.claim, (raw: unknown, ack?: unknown) => {
			const answer = (message: SessionClaimAnswer): void => {
				if (typeof ack === 'function') (ack as (a: SessionClaimAnswer) => void)(message);
			};
			const request = parseSessionClaim(raw);
			if (request === null) {
				log({ evt: 'session-malformed', participantId });
				answer({ room: '', status: 'refused' });
				return;
			}
			const { room, tabId } = request;
			sessionSockets.set(socket.id, socket);
			if (!deps.isPlayer(room, participantId)) {
				claims.release(socket.id);
				answer({ room, status: 'watcher' });
				return;
			}
			const decision = claims.claim(keyOf(participantId, room), tabId, socket.id, { take: request.take === true });
			if (decision.type === 'held') {
				log({ evt: 'session-held', room, participantId, socketId: socket.id, take: request.take === true });
				answer({ room, status: 'held' });
				return;
			}
			if (decision.type === 'taken') took(room, participantId, socket, decision);
			answer({ room, status: 'granted' });
		});

		socket.on('disconnect', () => {
			sessionSockets.delete(socket.id);
			claims.release(socket.id);
		});
	});

	const beating = setInterval(() => {
		for (const [id, socket] of sessionSockets) {
			if (claims.keysOf(id).length === 0) continue;
			socket.timeout(deps.beatMs ?? BEAT_MS).emit(SESSION_EVENTS.beat, (err: Error | null) => {
				if (err === null) claims.heartbeat(id);
			});
		}
	}, deps.beatMs ?? BEAT_MS);
	beating.unref();

	return {
		attach(room, participantId, tabId, socket) {
			if (!deps.isPlayer(room, participantId)) return true;
			const decision = claims.claim(keyOf(participantId, room), tabId, socket.id);
			if (decision.type === 'held') {
				log({ evt: 'session-elsewhere', room, participantId, socketId: socket.id });
				return false;
			}
			if (decision.type === 'taken') took(room, participantId, socket, decision);
			// Its close lets go of the claim through the `disconnect` every socket has above.
			return true;
		},
		close() {
			clearInterval(beating);
			sessionSockets.clear();
		},
	};
}

/** The parts of a room view `playsIn` reads. */
export interface PlayedRoom {
	tables: readonly { players: readonly { memberId: string }[] }[];
	pod: { seats: readonly ({ memberId: string } | null)[]; drafters: readonly string[]; dropped?: readonly string[] } | null;
}

/** Whether `participantId` plays in the room: a table seat, a pod seat, or a place in its draft and rounds. */
export function playsIn(room: PlayedRoom, participantId: string): boolean {
	if (room.tables.some((t) => t.players.some((p) => p.memberId === participantId))) return true;
	const pod = room.pod;
	if (pod === null) return false;
	if (pod.seats.some((s) => s?.memberId === participantId)) return true;
	return pod.drafters.includes(participantId) && !(pod.dropped ?? []).includes(participantId);
}
