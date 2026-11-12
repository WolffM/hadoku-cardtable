/**
 * The relay's own `HostedMatch` — `RelaySession` (`./relay.ts`) composed with the same
 * seat/rejoin-grace/watcher machinery every other hosted game runs on, so a relay match's end is
 * recorded by the shell rather than only by `relay-socket.ts`'s bare `onEnded` callback, and a
 * seat gone past its own grace is driven out of the game (`RelaySession.seatLeft`) — the first
 * thing that ever drove one.
 *
 * There is no engine underneath a relay match — `RelaySession.command`/`fromSeat` are reached
 * directly, never through a spawned process — so this file's own `MatchHostFactory` (below) is a
 * trivial one, reused from `runtimes/in-process.ts` rather than written by hand: nothing ever
 * calls `send`, nothing ever produces a line (`RelayLine` is `never`; see `./relay.ts`'s own
 * header), and the match is `running` the instant {@link RelayMatch.attach} gives it somewhere to
 * relay to — there is no boot to wait for.
 *
 * `RelayMatch` also implements `relay-socket.ts`'s own `RelayRoster`: it is both the match AND the
 * roster a relay socket joins against (seating each socket where the room seats its owner), so
 * `plugins/relay.ts`'s `rosterOf` can simply read one back
 * out of {@link relayMatches} — the module singleton `plugins/relay.ts` registers into, from
 * `room/lobby.ts`'s `onRelayRoomOpened` hook (kept out of this file's own importers; see
 * {@link relayMatches}'s own doc).
 */

import type { ParticipantId } from '@wolffm/rooms-protocol';

import { HostedMatch, type HostedMatchDeps } from '../match/hosted.js';
import type { ShellSeat } from '../match/shell.js';
import type { MatchHostFactory, MatchSpec } from '../host.js';
import type { RelayRoster } from '../relay-socket.js';
import { inProcessHost } from './in-process.js';
import { RelaySession, type RelayCommand, type RelayLine, type RelayOutcome, type RelaySink } from './relay.js';

/** A `MatchSpec` with `seatCount` seats, none AI. `host.ts`'s own tuple-typed `seats` is Forge's;
 *  nothing here ever reads a relay match's `spec` back (there is no engine to configure), so the
 *  cast below is inert and stays local to this one file. */
function relaySpec(seatCount: number): MatchSpec {
	const seats = Array.from({ length: seatCount }, (_, seat) => ({ ai: false, name: `Seat ${seat}`, deck: null }));
	return { seats } as unknown as MatchSpec;
}

/**
 * The host every `RelayMatch` runs on by default: nothing ever boots, nothing is ever sent down
 * it, and stopping it is a no-op — reused from the generic `InProcessEngine` seam
 * (`runtimes/in-process.ts`) rather than written by hand, so a relay match's "host" is proven
 * generic the same way the toy game's engine is.
 */
const relayNullHost: MatchHostFactory<RelayLine, RelayCommand> = inProcessHost<MatchSpec, RelayLine, RelayCommand>({
	start: () => ({ send: () => {}, stop: () => {} }),
});

/** What `RelayMatch`'s own constructor is handed: {@link HostedMatchDeps} with `host` always
 *  filled in (by {@link createRelayMatch}, below) plus this file's own grace. */
interface RelayMatchInternalDeps extends HostedMatchDeps<RelayLine, RelayCommand> {
	seatRejoinGraceMs?: number;
	roomSeatOf: (participantId: ParticipantId) => number | null;
}

/** What a `RelayMatch` needs beyond {@link HostedMatchDeps}: `host` is optional here (unlike the
 *  interface it extends) because {@link createRelayMatch} fills {@link relayNullHost} in when it
 *  is left out — nothing about a relay match ever needs a different one. */
export interface RelayMatchDeps extends Omit<HostedMatchDeps<RelayLine, RelayCommand>, 'host'> {
	host?: MatchHostFactory<RelayLine, RelayCommand>;
	/**
	 * A seat gone this long without reconnecting is out: `RelaySession.seatLeft` fires for it
	 * (through the same `command` sink the shell's own concede paths use), and the match goes on
	 * for whoever is left. Absent (0, the default): a seat that never comes back never leaves on
	 * its own — only the whole match's `rejoinGraceMs` (NOBODY here at all) ever stops anything.
	 */
	seatRejoinGraceMs?: number;
	/**
	 * The seat the room has this participant in (`Lobby.gameSeatOf`), or null for one it seats
	 * nowhere: the room's seating is the one seat list, so the relay seats a socket exactly where
	 * every screen's `RoomView.seats` shows its owner — never by which socket arrived first.
	 */
	roomSeatOf: (participantId: ParticipantId) => number | null;
}

/**
 * `RelaySession` composed with `HostedMatch`'s seat/rejoin-grace/watcher machinery — see this
 * file's own header. A `RelayMatch` is also the `RelayRoster` `relay-socket.ts` joins against:
 * `roleOf` seats a participant where the room seats them (every room auto-sits every joiner, the
 * 2026-11-02 ruling, and the room's seats are the one record of who sat where) and `attach` is
 * where its `RelaySession` is actually built, the moment it has live sockets to relay through.
 */
export class RelayMatch extends HostedMatch<RelayLine, RelayCommand> implements RelayRoster {
	readonly seats: ShellSeat[];
	/** Set once the match ends ({@link RelaySession}'s own `onEnded`) — mirrors `ToyMatch`'s own result field. */
	result: RelayOutcome | null = null;
	/** When the match ended; null until then. */
	endedAt: number | null = null;
	private sessionRef: RelaySession | null = null;
	private readonly seatGrace = new Map<number, ReturnType<typeof setTimeout>>();
	declare protected readonly deps: RelayMatchInternalDeps;

	constructor(
		id: string,
		seatCount: number,
		deps: RelayMatchInternalDeps,
		restore?: { epoch: string | null; owners: (string | null)[]; startedAt: number; clockMs?: [number, number] },
	) {
		super(id, relaySpec(seatCount), deps, restore);
		this.seats = Array.from({ length: seatCount }, (_, seat) => ({ seat, ai: false, owner: null, playerId: seat, departure: null, here: false, away: false }));
		for (const [seat, owner] of (restore?.owners ?? []).entries()) {
			const s = this.seats[seat];
			if (s !== undefined && owner !== null) s.owner = owner as ParticipantId;
		}
	}

	/** `RelayRoster.seatCount`. */
	get seatCount(): number {
		return this.seats.length;
	}

	/**
	 * `RelayRoster.roleOf`: the seat the room has this participant in (`deps.roomSeatOf`), read
	 * fresh on every join, or null — a watcher — for one the room seats nowhere. The seat's owner
	 * follows the room: a member who moved seats, or a match restored with no owners, is seated
	 * where the room says, whichever socket reaches here first. Never `undefined` — this match
	 * keeps no membership list to refuse a stranger by, because the room's own join already settled
	 * that before any socket reached here.
	 */
	roleOf(participantId: ParticipantId): number | null {
		const roomSeat = this.deps.roomSeatOf(participantId);
		const seat = roomSeat === null ? undefined : this.seats[roomSeat];
		if (seat === undefined) return null;
		if (seat.owner !== participantId) {
			for (const s of this.seats) if (s.owner === participantId) s.owner = null;
			seat.owner = participantId;
			this.remember();
			this.deps.log({ evt: 'seat-claimed', matchId: this.id, seat: seat.seat, participantId });
		}
		return seat.seat;
	}

	/**
	 * `RelayRoster.attach`: this match's own `RelaySession`, built the moment it has somewhere to
	 * relay to (`relay-socket.ts`'s first join). A second call — should not happen, `relay-socket.ts`
	 * calls this at most once per roster — returns the session already built rather than replacing it.
	 */
	attach(sink: RelaySink, onEnded: (outcome: RelayOutcome | null) => void): RelaySession {
		if (this.sessionRef !== null) return this.sessionRef;
		const session = new RelaySession(this.seats.length, sink, (outcome) => {
			this.applyEnded(outcome);
			onEnded(outcome);
		});
		this.sessionRef = session;
		this.game = session;
		// A relay match has no engine underneath it to wait for: it is `running` from the instant
		// it is given somewhere to relay to, the same way the toy game's own 'ready' line flips it
		// (`fixtures/toy-game/match.ts`), except here there is no line to wait for at all.
		this.status = 'running';
		for (const done of this.runningWaiters.splice(0)) done({ ok: true });
		this.armRejoinGrace();
		return session;
	}

	private applyEnded(outcome: RelayOutcome | null): void {
		if (this.status !== 'running') return;
		this.status = 'over';
		this.result = outcome;
		this.endedAt = this.now();
		this.syncClock();
		for (const timer of this.seatGrace.values()) clearTimeout(timer);
		this.seatGrace.clear();
		this.tellEnded();
	}

	/**
	 * The shell's notice hook (see `runtimes/relay.ts`'s own `notice` method). `Match.serverStopping`'s
	 * own twin: the server is going down and this match cannot outlive it, so every seat is told
	 * in words.
	 */
	serverStopping(message: string): void {
		this.deps.log({ evt: 'match-ending-with-server', matchId: this.id, status: this.status });
		this.sessionRef?.notice('server-stopping', message);
	}

	/**
	 * Drives `RelaySession.seatLeft` after `seatRejoinGraceMs` — R's own "unverified" line settles
	 * here: nothing drove a rejoin-grace timer for a relay match before this file existed.
	 */
	override seatConnected(seat: number): void {
		super.seatConnected(seat);
		const timer = this.seatGrace.get(seat);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.seatGrace.delete(seat);
			this.deps.log({ evt: 'relay-seat-back', matchId: this.id, seat });
		}
	}

	override seatDisconnected(seat: number): void {
		super.seatDisconnected(seat);
		const grace = this.deps.seatRejoinGraceMs ?? 0;
		if (grace <= 0 || this.seatGrace.has(seat)) return;
		const timer = setTimeout(() => {
			this.seatGrace.delete(seat);
			const s = this.seats[seat];
			if (s === undefined || s.here) return;
			this.deps.log({ evt: 'relay-seat-left', matchId: this.id, seat });
			this.game.command(this.concedeCommand(seat));
		}, grace);
		timer.unref();
		this.seatGrace.set(seat, timer);
		this.deps.log({ evt: 'relay-seat-held', matchId: this.id, seat, graceMs: grace });
	}

	protected onLine(_line: RelayLine): void {
		// `RelayLine` is `never` — no engine ever produces one (see `runtimes/relay.ts`'s module
		// doc). Implemented only to satisfy `MatchShell`'s abstract contract.
	}

	protected concedeCommand(seat: number): RelayCommand {
		return { t: 'concede', seat };
	}

	/**
	 * `MatchShell.forceConcede`: relay's own `command` is synchronous and unconditional
	 * (`RelaySession.command` → `seatLeft`), so there is nothing to wait on before forcing it —
	 * this IS the concede, the same one path that ever reaches it (a seat past its own grace, or
	 * the whole match's chess-clock flag, which a relay match never has).
	 */
	protected forceConcede(seat: number): void {
		this.game.command(this.concedeCommand(seat));
	}
}

/** Builds one `RelayMatch`, filling {@link relayNullHost} in when `deps.host` is left out. */
export function createRelayMatch(id: string, seatCount: number, deps: RelayMatchDeps): RelayMatch {
	return new RelayMatch(id, seatCount, { ...deps, host: deps.host ?? relayNullHost });
}

export interface RelayMatchRegistry {
	/**
	 * Builds one `RelayMatch` under `id` — a room's own id, since a relay room IS its own match:
	 * there is no separate "start" a non-Magic room's UI ever presses (`rooms/BundleSlot.tsx`'s own
	 * doc). Replaces whatever was already registered under `id`. When that match ends, the room's
	 * next one is registered in its place with the same `deps` (so the same seats, by
	 * `roomSeatOf`): a room plays as many matches as its players start, one after another.
	 */
	register(id: string, seatCount: number, deps: RelayMatchDeps): RelayMatch;
	get(id: string): RelayMatch | undefined;
}

/**
 * A registry of `RelayMatch`es, keyed by match (room) id. A match that ends is replaced by the
 * room's next one at once, before `relay-socket.ts` tells any screen it ended, so every screen's
 * rejoin (`relay-channel.ts` sends its join again on `relay:ended`) finds the new match.
 */
export function createRelayMatchRegistry(): RelayMatchRegistry {
	const matches = new Map<string, RelayMatch>();
	function register(id: string, seatCount: number, deps: RelayMatchDeps): RelayMatch {
		const match = createRelayMatch(id, seatCount, {
			...deps,
			ended: () => {
				if (matches.get(id) === match) register(id, seatCount, deps);
				deps.ended?.();
			},
		});
		matches.set(id, match);
		return match;
	}
	return {
		register,
		get(id) {
			return matches.get(id);
		},
	};
}

/**
 * The one instance `plugins/relay.ts` shares between `ctx.state.lobby.onRelayRoomOpened`'s hook
 * (what puts a `RelayMatch` in) and `rosterOf` (what reads one back out). `room/lobby.ts` never
 * imports this module itself — see `Lobby.onRelayRoomOpened`'s own doc for the import cycle that
 * would otherwise close back to `match.ts`'s `HostedMatch`. A plain module-level singleton rather
 * than a field on `plugins/state.ts`'s `Cardtable` bag, which carries none for it this wave (that
 * file is nobody's lane this wave). Unit tests build their own with
 * {@link createRelayMatchRegistry} instead, so they never share state with this one or with each
 * other.
 */
export const relayMatches: RelayMatchRegistry = createRelayMatchRegistry();
