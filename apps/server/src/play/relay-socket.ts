/**
 * The relay's socket path: joins a seat's or a watcher's connection to a
 * match's `RelaySession` (`runtimes/relay.ts`), and fans each relayed
 * message out to the right live sockets. There is no client for this yet —
 * a native game is the first — so the path is proven
 * with a directly-injected roster rather than a real match registry; see
 * `plugins/relay.ts` for the one line that wires it into the running
 * server, refusing every join until something real registers one.
 *
 * ## The gate is the play socket's, re-applied
 *
 * `../gate.ts`'s `gateSocketIo` with the SAME `surface: 'play-socket'` the
 * play socket itself uses (`play/socket.ts`) — not a new check, the
 * identical one, installed again on the same `io` for the same reason
 * `play/socket.ts`'s own header gives: an ordering dependency on who
 * attaches first is how a gate goes missing.
 *
 * ## Identity is derived, never accepted
 *
 * `identityFromHeaders` over the sanitized handshake, exactly as the play
 * socket does. `relay:join`'s `matchId` is read from the payload; nothing
 * else about who is speaking is.
 *
 * ## One session per match, created on its first join
 *
 * A `RelaySession` has nothing to do until somebody joins it, so there is
 * no reason to build one earlier. It is dropped from `live` once it ends.
 */

import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { ParticipantId } from '@wolffm/rooms-protocol';
import type { RateLimitConfig } from '@wolffm/rooms-server';

import { gateSocketIo } from '../gate.js';
import { identityFromHeaders } from '../room/identity.js';
import { costlyActLimit } from '../http/request.js';
import { RelaySession, type RelayMessage, type RelayOutcome } from './runtimes/relay.js';

export const RELAY_EVENTS = {
	join: 'relay:join',
	message: 'relay:message',
} as const;

/** Joins per caller: a burst of 10, then one every 10 s. A seat opens one
 *  relay connection per tab, so a burst covers a refresh storm without
 *  covering a scan. */
export const RELAY_JOIN_RATE_LIMIT: RateLimitConfig = {
	capacity: 10,
	refillAmount: 1,
	refillIntervalMs: 10_000,
};

/**
 * A match's own roster, read fresh on every join: how many seats it has,
 * and which one (if any) a participant holds. Supplied by whoever owns the
 * match's lifecycle — today nobody; `HostedMatch` will, once a relay
 * adapter exists to build one.
 *
 * `roleOf` answers `undefined` for a participant the match does not
 * recognise at all — refused the same way `forge:join` refuses an unknown
 * one — and `null` for a recognised watcher.
 */
export interface RelayRoster {
	seatCount: number;
	roleOf(participantId: ParticipantId): number | null | undefined;
}

export type RelayJoinAck = { ok: true; seat: number | null } | { ok: false; error: 'bad-request' | 'unknown-match' | 'not-joined' | 'rate-limited' };

export interface RelayDeps {
	/** The tier floor; `CONFIG.minTier` in production. */
	minTier: string;
	/** This match's roster, or `undefined` for a matchId nothing is running — refused as `unknown-match`. */
	rosterOf(matchId: string): RelayRoster | undefined;
	/** The match ended: every seat left (`null`), or the leader's own bundle said `{ t: 'over', winners }`. */
	onEnded?(matchId: string, outcome: RelayOutcome | null): void;
	/** Overrides `RELAY_JOIN_RATE_LIMIT`; `null` is none. */
	joinRateLimit?: RateLimitConfig | null;
	log?(entry: Record<string, unknown>): void;
}

export interface RelayHandle {
	/** The live session for a match that has at least one join — a test seam, and the composition seam once something builds on it. */
	sessionOf(matchId: string): RelaySession | undefined;
	/** Ends every live session (sweeps them as `every seat left`) and forgets them. */
	close(): void;
}

interface LiveMatch {
	session: RelaySession;
	seatSockets: Map<number, Set<Socket>>;
	watcherSockets: Set<Socket>;
}

function readMatchId(payload: unknown): string | null {
	const matchId = (payload as { matchId?: unknown } | null)?.matchId;
	return typeof matchId === 'string' && matchId !== '' ? matchId : null;
}

/**
 * Attaches the relay's `connection`/`relay:join`/`relay:message` handlers to
 * `io`. Safe to call once per process; a second call on the same `io` would
 * install the gate twice (harmless, same precedent as `play/socket.ts`) and
 * a second, independent `live` map, so callers should not do that.
 */
export function attachRelay(io: SocketIOServer, deps: RelayDeps): RelayHandle {
	gateSocketIo(io, { minTier: deps.minTier, surface: 'play-socket' });
	const log = deps.log ?? ((): void => {});
	const live = new Map<string, LiveMatch>();

	const joinLimit = costlyActLimit(deps.joinRateLimit === undefined ? RELAY_JOIN_RATE_LIMIT : deps.joinRateLimit, {
		act: 'relay-join',
		onRefused: () => log({ evt: 'relay-join-refused', reason: 'rate-limited' }),
	});

	function matchOf(matchId: string, roster: RelayRoster): LiveMatch {
		const found = live.get(matchId);
		if (found !== undefined) return found;
		const seatSockets = new Map<number, Set<Socket>>();
		const watcherSockets = new Set<Socket>();
		const session = new RelaySession(
			roster.seatCount,
			{
				toSeat: (seat, msg) => {
					for (const s of seatSockets.get(seat) ?? []) s.emit(RELAY_EVENTS.message, msg);
				},
				toWatchers: (msg) => {
					for (const s of watcherSockets) s.emit(RELAY_EVENTS.message, msg);
				},
			},
			(outcome) => {
				live.delete(matchId);
				deps.onEnded?.(matchId, outcome);
			},
		);
		const entry: LiveMatch = { session, seatSockets, watcherSockets };
		live.set(matchId, entry);
		return entry;
	}

	io.on('connection', (socket: Socket) => {
		const participantId = identityFromHeaders(socket.request.headers, socket.id);
		let joined: { matchId: string; seat: number | null } | null = null;

		socket.on(RELAY_EVENTS.join, (payload: unknown, ack?: (res: RelayJoinAck) => void) => {
			const reply = ack ?? ((): void => {});
			const matchId = readMatchId(payload);
			if (matchId === null) {
				reply({ ok: false, error: 'bad-request' });
				return;
			}
			if (!joinLimit(participantId, socket.handshake.headers)) {
				reply({ ok: false, error: 'rate-limited' });
				return;
			}
			const roster = deps.rosterOf(matchId);
			if (roster === undefined) {
				reply({ ok: false, error: 'unknown-match' });
				return;
			}
			const role = roster.roleOf(participantId);
			if (role === undefined) {
				reply({ ok: false, error: 'not-joined' });
				return;
			}
			const match = matchOf(matchId, roster);
			if (role === null) {
				match.watcherSockets.add(socket);
			} else {
				const set = match.seatSockets.get(role) ?? new Set<Socket>();
				set.add(socket);
				match.seatSockets.set(role, set);
			}
			joined = { matchId, seat: role };
			log({ evt: 'relay-joined', matchId, seat: role });
			reply({ ok: true, seat: role });
		});

		socket.on(RELAY_EVENTS.message, (msg: RelayMessage) => {
			if (joined === null) return;
			const match = live.get(joined.matchId);
			if (match === undefined) return;
			if (joined.seat === null) {
				// A watcher's own send is refused, always — `RelaySession.fromWatcher`
				// is the no-op behind this, but the refusal belongs here: this is
				// the one place that knows a connection is a watcher's.
				log({ evt: 'relay-send-refused', matchId: joined.matchId, reason: 'watcher' });
				return;
			}
			match.session.fromSeat(joined.seat, msg);
		});

		socket.on('disconnect', () => {
			if (joined === null) return;
			const match = live.get(joined.matchId);
			if (match === undefined) return;
			if (joined.seat === null) match.watcherSockets.delete(socket);
			else match.seatSockets.get(joined.seat)?.delete(socket);
			log({ evt: 'relay-disconnected', matchId: joined.matchId, seat: joined.seat });
			// A plain disconnect is not a leave: rejoining is `relay:join` again
			// on a new socket, which simply re-adds it to the same seat's set
			// above. Nothing here calls `session.seatLeft` — that is a rejoin-
			// grace timer's job, and nothing drives one for a relay match yet.
		});
	});

	return {
		sessionOf: (matchId) => live.get(matchId)?.session,
		close: () => {
			for (const { session } of live.values()) session.ended('server-stopping');
			live.clear();
		},
	};
}
