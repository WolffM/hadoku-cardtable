/**
 * The relay's socket path: joins a seat's or a watcher's connection to a
 * match's `RelaySession` (`runtimes/relay.ts`), and fans each relayed
 * message out to the right live sockets. A real roster
 * (`runtimes/relay-match.ts`'s `RelayMatch`, registered from a room's seats
 * by `room/lobby.ts`'s one hook and read back by `plugins/relay.ts`'s
 * `rosterOf`) now backs it — before that this file was proven only with a
 * directly-injected test roster, refusing every join for lack of one.
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
 *
 * ## A room's next match is joined with the same `relay:join`
 *
 * When a match ends, its roster's owner has already put the room's next match under the same id
 * (`runtimes/relay-match.ts`'s registry), and every live socket is told `relay:ended`. A screen
 * rejoins by sending `relay:join` again on the socket it already has (`relay-channel.ts` does on
 * every `relay:ended`): no new event and no reconnect. Until it does, that socket speaks for
 * nothing — its sends and its disconnect belong to the match it joined, which is over.
 */

import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { ParticipantId } from '@wolffm/rooms-protocol';
import type { RateLimitConfig } from '@wolffm/rooms-server';

import { gateSocketIo } from '../gate.js';
import { identityFromHeaders } from '../room/identity.js';
import { costlyActLimit } from '../http/request.js';
import { type RelayMessage, type RelayOutcome, type RelaySession, type RelaySink } from './runtimes/relay.js';

export const RELAY_EVENTS = {
	join: 'relay:join',
	message: 'relay:message',
	/** The host's own word that the match ended: `{ winners }` (the `over` message's seat
	 *  numbers), or `{ winners: null }` when every seat left. To every live socket of the match,
	 *  the sender of `over` and every watcher included, so the room can show the result. */
	ended: 'relay:ended',
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
 * match's lifecycle — `runtimes/relay-match.ts`'s `RelayMatch`.
 *
 * `roleOf` answers `undefined` for a participant the match does not
 * recognise at all — refused the same way `forge:join` refuses an unknown
 * one — and `null` for a recognised watcher.
 *
 * **This file no longer builds the session itself.** `attach` is called at
 * most once per roster, the first time anybody joins, and hands the
 * lifecycle owner this file's own live-socket sink — the owner builds (or
 * finishes building) its `RelaySession` AT THAT POINT, wired to sockets that
 * did not exist a moment earlier, and returns it for this file to relay
 * through. `seatConnected`/`seatDisconnected` are the same two hooks
 * `play/match/shell.ts`'s `MatchShell` already exposes by those names; a
 * roster backed by one simply forwards them, so its own rejoin-grace timers
 * (RelaySession.seatLeft, past the grace) see the same socket transitions
 * this file does.
 */
export interface RelayRoster {
	seatCount: number;
	roleOf(participantId: ParticipantId): number | null | undefined;
	/** This match's own session, wired to `sink`; `onEnded` is this file's own cleanup, called once. */
	attach(sink: RelaySink, onEnded: (outcome: RelayOutcome | null) => void): RelaySession;
	/** A seat's first live socket joined, or its last one went. Absent: nothing is told. */
	seatConnected?(seat: number): void;
	seatDisconnected?(seat: number): void;
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
	roster: RelayRoster;
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
		const session = roster.attach(
			{
				toSeat: (seat, msg) => {
					for (const s of seatSockets.get(seat) ?? []) s.emit(RELAY_EVENTS.message, msg);
				},
				toWatchers: (msg) => {
					for (const s of watcherSockets) s.emit(RELAY_EVENTS.message, msg);
				},
			},
			(outcome) => {
				const ending = live.get(matchId);
				const word = { winners: outcome?.winners ?? null };
				for (const set of ending?.seatSockets.values() ?? []) for (const s of set) s.emit(RELAY_EVENTS.ended, word);
				for (const s of ending?.watcherSockets ?? []) s.emit(RELAY_EVENTS.ended, word);
				live.delete(matchId);
				log({ evt: 'relay-ended', matchId, winners: word.winners });
				deps.onEnded?.(matchId, outcome);
			},
		);
		const entry: LiveMatch = { session, roster, seatSockets, watcherSockets };
		live.set(matchId, entry);
		return entry;
	}

	io.on('connection', (socket: Socket) => {
		const participantId = identityFromHeaders(socket.request.headers, socket.id);
		// The match this socket joined, by its live entry rather than its id: a room's next match
		// lives under the same id, and a socket that has not rejoined it speaks for nothing there.
		let joined: { matchId: string; match: LiveMatch; seat: number | null } | null = null;

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
				// This seat had no live socket a moment ago (a fresh join, or a rejoin after every
				// earlier one dropped) — told every time regardless, same as `MatchShell.seatConnected`
				// itself is: harmless to tell twice, and cheaper than tracking "was it already zero".
				match.roster.seatConnected?.(role);
			}
			joined = { matchId, match, seat: role };
			log({ evt: 'relay-joined', matchId, seat: role });
			reply({ ok: true, seat: role });
		});

		socket.on(RELAY_EVENTS.message, (msg: RelayMessage) => {
			if (joined === null) return;
			const { match } = joined;
			if (live.get(joined.matchId) !== match) return;
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
			const { match } = joined;
			if (live.get(joined.matchId) !== match) return;
			if (joined.seat === null) {
				match.watcherSockets.delete(socket);
			} else {
				const set = match.seatSockets.get(joined.seat);
				set?.delete(socket);
				// A plain disconnect is not a leave: rejoining is `relay:join` again on a new socket,
				// which simply re-adds it to the same seat's set above. Whether THIS is a leave for
				// good is the roster's own rejoin-grace timer's call — told only once the
				// seat's last live socket is actually gone, never on an earlier one among several tabs.
				if (set === undefined || set.size === 0) match.roster.seatDisconnected?.(joined.seat);
			}
			log({ evt: 'relay-disconnected', matchId: joined.matchId, seat: joined.seat });
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
