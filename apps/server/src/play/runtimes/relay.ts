/**
 * The relay runtime: a match with no engine. `RelaySession` is the
 * `GameSession` (`../game-adapter.ts`) for a game that has no bridge of its
 * own — the host's only job is to hand each seat's own message to every
 * other seat, and to every watcher read-only, through the match's socket
 * (`../relay-socket.ts`). Rooms, seats, rejoin and watchers come from
 * `MatchShell`; this is the other half of that seam.
 *
 * A native game such as bomberman is this runtime plus the bundle's own
 * `channel` (`@hadoku/rooms-protocol`'s `MatchChannel`), so the semantics
 * here — ordering per sender, at-most-once delivery, a watcher's refused
 * send — follow that reference exactly: a bundle on the other side of a
 * relay match is already written against it.
 *
 * There is no bridge, so nothing ever produces a "line" for this session to
 * read: `onLine` exists only to satisfy `GameSession` and is never called.
 * What actually drives a relay match is `fromSeat`, called by
 * `relay-socket.ts` whenever one seat's own connection sends a message —
 * never through `GameSession` itself, because nothing upstream of a seat's
 * own socket produces one.
 */

import type { GameSession } from '../game-adapter.js';

/** A seat's or a watcher's message: opaque to the host, meaningful only to the game on both ends. */
export type RelayMessage = unknown;

/**
 * `command()`'s one real case: a seat that must leave as a loss (a seat
 * dropped past its grace, the shell's own concede). Nothing else goes down
 * this sink — there is no engine underneath to send anything else to.
 */
export type RelayCommand = { t: 'concede'; seat: number };

/** `GameSession.onLine`'s parameter has nothing to carry: see the module doc. */
export type RelayLine = never;

/** What the match ended with: a ranking from the leader's own `{ t: 'over', winners }`
 *  message, or `null` when it ended because every seat left instead. */
export interface RelayOutcome {
	winners: readonly number[];
}

/** Where a relayed message actually goes: wired to the live sockets by `relay-socket.ts`. */
export interface RelaySink {
	toSeat(seat: number, msg: RelayMessage): void;
	toWatchers(msg: RelayMessage): void;
}

/** Whether `msg` is the leader's own end-of-game message. Read directly off
 *  the opaque content — the same way `GameAdapter.classify`'s `'over'` case
 *  reads Forge's own gameover line, except here the "line" is just one
 *  seat's relayed message. */
function isOverMessage(msg: RelayMessage): msg is { t: 'over'; winners: readonly number[] } {
	if (typeof msg !== 'object' || msg === null) return false;
	const t = (msg as { t?: unknown }).t;
	const winners = (msg as { winners?: unknown }).winners;
	return t === 'over' && Array.isArray(winners) && winners.every((w) => typeof w === 'number');
}

export class RelaySession implements GameSession<RelayLine, RelayCommand> {
	private readonly left = new Set<number>();
	private outcome: RelayOutcome | null = null;
	private closed = false;
	private relayedAny = false;

	constructor(
		private readonly seatCount: number,
		private readonly sink: RelaySink,
		/** Called once, the first time the match ends — by `{ t: 'over', winners }` or by every seat leaving. */
		private readonly onEnded?: (outcome: RelayOutcome | null) => void,
		/**
		 * Whether `seat` may end the match with `{ t: 'over' }` — the protocol's host, the room's
		 * leader. An `over` it refuses is not relayed at all (every other seat would take it as
		 * final) and ends nothing. Absent: any seat may.
		 */
		private readonly mayEnd?: (seat: number) => boolean,
	) {}

	get isEnded(): boolean {
		return this.closed;
	}

	get result(): RelayOutcome | null {
		return this.outcome;
	}

	/** Whether any seat has said anything in this match yet: the match is under way from its first message. */
	get started(): boolean {
		return this.relayedAny;
	}

	/**
	 * One seat's own connection sent `msg`: relay it to every OTHER seat and,
	 * read-only, to every watcher — never back to the sender. A seat already
	 * recorded as `left` cannot speak for it again; `relay-socket.ts` should
	 * never call this for a departed seat, but the guard is cheap insurance
	 * against exactly that race (a close and a late message crossing).
	 */
	fromSeat(seat: number, msg: RelayMessage): void {
		if (this.closed || this.left.has(seat)) return;
		const over = isOverMessage(msg);
		if (over && this.mayEnd !== undefined && !this.mayEnd(seat)) return;
		this.relayedAny = true;
		for (let other = 0; other < this.seatCount; other += 1) {
			if (other !== seat) this.sink.toSeat(other, msg);
		}
		this.sink.toWatchers(msg);
		if (over) this.finish({ winners: msg.winners });
	}

	/**
	 * A watcher's own connection sent something: refused, always — a watcher
	 * has no seat to speak from (`MatchChannel`'s own doc has the same rule).
	 * `relay-socket.ts` must refuse this before it ever reaches here; this
	 * method exists only so a caller that forgets that guard fails safe
	 * (silently drops it) rather than failing loud.
	 */
	fromWatcher(): void {
		// Deliberately empty.
	}

	/**
	 * A seat's holder left for good — not a plain disconnect, which the
	 * socket layer alone tracks for rejoin. The match ends once every seat
	 * has.
	 */
	seatLeft(seat: number): void {
		if (this.closed || this.left.has(seat)) return;
		this.left.add(seat);
		if (this.left.size >= this.seatCount) this.finish(null);
	}

	private finish(outcome: RelayOutcome | null): void {
		if (this.closed) return;
		this.closed = true;
		this.outcome = outcome;
		this.onEnded?.(outcome);
	}

	/* ── GameSession ──────────────────────────────────────────────────── */

	onLine(_line: RelayLine): void {
		// No bridge produces one; see the module doc.
	}

	command(cmd: RelayCommand): void {
		if (cmd.t === 'concede') this.seatLeft(cmd.seat);
	}

	waitedOn(_seat: number): boolean {
		// A relay match's clock is the game's own business, carried inside the
		// opaque messages it relays; the shell has nothing to wait on here.
		return false;
	}

	tellRoster(): void {
		// The shell's own roster frame already reaches every seat; a relay
		// session has nothing of its own to add to it.
	}

	turn(): number | null {
		return null;
	}

	activeSeat(): { seat: number; playerId: number } | null {
		return null;
	}

	openAsks(_seat: number): number {
		return 0;
	}

	/*
	 * ── `GameSession`'s two optional hooks ───────────────────────────────
	 * Both now declared on `game-adapter.ts` (G's file), optional until
	 * every `GameSession` implements them. `MatchShell`/`HostedMatch` does
	 * not yet compose with a relay session, so nothing on the shell's side
	 * calls these yet, but `relay-socket.ts` already calls `ended` directly
	 * for its own sweep (see `close()`); implemented now so wiring the rest
	 * in is a no-op once something does.
	 */

	/** A replayed command closes the session's own open ask. A relay match
	 *  keeps no replay log and opens no asks of its own, so there is nothing
	 *  to close. */
	replayed(_command: RelayCommand): void {
		// Deliberately empty.
	}

	/**
	 * The session's sweep at stop, fail or exit — `null` for a stop, same as
	 * the interface's own doc. `finish(null)` already covers "every seat
	 * left"; this is the same sweep from the OUTSIDE (the shell, or
	 * `relay-socket.ts`'s own `close()`, ending the match for reasons of its
	 * own). Idempotent, like every path into `finish`.
	 */
	ended(_reason: string | null): void {
		this.finish(null);
	}

	/**
	 * `GameSession.notice` (`game-adapter.ts`): the shell's own hook for words with no game state
	 * behind them. `Match.serverStopping` moves behind the same hook on Forge's side; here the
	 * server is going down and this match cannot outlive it, so every SEAT (never a watcher — the
	 * same "seats only" rule Forge's own `endNotice` follows) is told in words, as a relayed
	 * message shaped like any other: `{ t: 'notice', message }`. A match already ended has nothing
	 * left to tell.
	 */
	notice(_kind: 'server-stopping', message: string): void {
		if (this.closed) return;
		const msg: RelayMessage = { t: 'notice', message };
		for (let seat = 0; seat < this.seatCount; seat += 1) this.sink.toSeat(seat, msg);
	}
}
