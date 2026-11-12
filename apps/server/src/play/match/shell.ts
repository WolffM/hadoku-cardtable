/**
 * The platform half of a match (`play/match.ts`'s `Match` is this plus its game's {@link GameSession}):
 * its lifecycle and its seats' holders, never what the game in it is. Who holds which seat and whether
 * they are here, the grace a match nobody comes back to gets, the chess clock, the concede that
 * always ends a game, the start queue's waiters, the record a restart re-attaches from, and the
 * restart-turn ask between the two seats. Every fact about the game itself — is a seat's own decision
 * open, whose turn it is, what a seat's asks are — is asked of {@link MatchShell.game}.
 *
 * Nothing here imports Magic: a game that is not Forge runs under the same shell.
 */

import { isDurableParticipantId, type ParticipantId } from '@wolffm/rooms-protocol';

import { report } from '../../telemetry.js';
import { ChessClock } from '../clock.js';
import type { GameSession } from '../game-adapter.js';
import type { MatchHost, MatchSpec, TurnSnapshot } from '../host.js';

/**
 * This shell's own `game`/`host` fields stay platform: a bare `{ t }` would reject the literal
 * commands and lines it still builds itself (a forced concede's `act`, a forced `gameover`) under
 * excess-property checking, so the index signature absorbs them without naming Forge's own
 * `BridgeLine`/`BridgeCommand` (`bridge-protocol.ts`, magic) here.
 */
type EngineMsg = { t: string } & Record<string, unknown>;
import type { MatchStatus } from './outcome.js';

export type ClaimOutcome = { ok: true; seat: number; fresh: boolean } | { ok: false; error: string };
export type ClientOutcome = { ok: true } | { ok: false; error: string };

/** How far back {@link MatchShell.activity} counts the seconds in which the table changed. */
export const ACTIVITY_WINDOW_MS = 120_000;

/** How long a restart ask waits for the other seat before it counts as declined. */
export const RESTART_ASK_MS = 30_000;

/**
 * How long Forge gets to end the game after a seat concedes before the concede is sent again, and
 * again before the server ends the game itself. Forge ends a conceded game within the act's own
 * turn at the gate (`ActGate`, at most 5 s); the monkey's matches met concedes Forge received, logged
 * no error for, and never ended, each holding its place under the ceiling for good.
 */
export const CONCEDE_ANSWER_MS = 10_000;

/** A seat's restart act: `@hadoku/shared`'s `RESTART_ACTS`, the four the wire carries. */
export type RestartAct = 'ask' | 'allow' | 'decline' | 'cancel';

/** Where a restart of the current turn stands: `@hadoku/shared`'s `RestartState`, the payload the wire carries. */
export interface RestartState {
	matchId: string;
	turn: number;
	ask: { from: number } | null;
	declined: boolean;
	restorable: boolean;
}

/** What the shell keeps of a seat: who holds it and whether they are here. The game's own seat state extends it. */
export interface ShellSeat {
	seat: number;
	ai: boolean;
	/** Bound on first claim, never changed. */
	owner: ParticipantId | null;
	/** From this seat's `openView`. Null until Forge has opened the game. */
	playerId: number | null;
	/** Armed when the seat's last connection went; aborts its asks when it fires. */
	departure: NodeJS.Timeout | null;
	/** A person is on this seat: connected, or gone for less than the grace. Never true for an AI seat. */
	here: boolean;
	/**
	 * The person on this seat LEFT: they were here, and have been gone past the
	 * grace. Told to the other seat (`SeatIdentity.away`) so it is not left
	 * reading "is choosing…" for a player who closed the tab (the rejoin audit,
	 * 2026-10-19). A seat nobody has joined yet is not away — it is starting.
	 */
	away: boolean;
}

/** What the shell is handed: the log, and the graces and hooks of a seat's presence, a restart and an ending. */
export interface ShellDeps {
	log(entry: Record<string, unknown>): void;
	/**
	 * How long a match with no seat here waits for one to come back before it stops
	 * ({@link Match.armRejoinGrace}). Absent or 0: never — a suite that drives a match without
	 * sockets has no seat to be here. `attachPlay` passes 5 minutes (`socket.ts`'s
	 * `DEFAULT_REJOIN_GRACE_MS`).
	 */
	rejoinGraceMs?: number;
	/**
	 * Whether a seat's holder is still connected to this server — watching another match, or on the
	 * room's own screens, whose feed is a socket too (the operator,
	 * 2026-10-23: *"even people who are seated and have an active game to play should be able to
	 * spectate other people and their games"*). A holder watching another table is still in the room's
	 * games, so the rejoin grace waits for them rather than stopping their own. Absent: nobody is.
	 */
	ownerOnline?(owner: ParticipantId): boolean;
	/**
	 * How long a seat with no connection still counts as at the table
	 * ({@link Match.anyoneHere}). 0 (the default) is gone at once; `attachPlay`
	 * passes 30 s so a refresh is not a departure. Its asks stay open either way.
	 */
	disconnectGraceMs?: number;
	/** Where a restart stands ({@link Match.restartState}) changed: the socket layer tells every socket of the match. */
	restartChanged?(state: RestartState): void;
	/**
	 * A restart of the current turn was allowed ({@link Match.restartAct}): start this match again from
	 * its latest turn-start snapshot. The registry's {@link MatchRegistry.restore} of this match. Absent
	 * (a unit suite with no registry): no restart can be made.
	 */
	restartTurn?(): void;
	/**
	 * Nobody came back ({@link Match.armRejoinGrace}): the match is about to be stopped with its game
	 * unfinished. Told before the stop, while the match still holds what a later resume needs — its
	 * latest turn-start snapshot, its seats' owners, its clock.
	 */
	abandoned?(): void;
	/** The match let go of its JVM for good, stopped or failed, and says nothing more. Told once. */
	ended?(): void;
	now?: () => number;
}

export abstract class MatchShell {
	readonly id: string;
	/** Minted per match-process start: a restart is a new epoch. */
	readonly epoch: string;
	status: MatchStatus = 'starting';
	failure: string | null = null;
	/** The seat whose concede Forge was sent, or null — the one end reason the board cannot show. */
	concededBy: number | null = null;
	/** The seat whose chess clock ran out, or null. The server conceded the game for it ({@link flag}). */
	timedOut: number | null = null;
	/**
	 * The chess clock (`clock.ts`), or null in a game without one (`MatchSpec.clockMs`). A seat's
	 * runs exactly while {@link waitingOnFor} names it — the same fact the other seat's banner
	 * reads — so a window the server answers for it never reaches it live and never costs it time.
	 * A disconnected seat's keeps running: being away answers nothing.
	 */
	readonly clock: ChessClock | null;
	/** Fires when the running seat with the least time left runs out ({@link syncClock}). */
	protected flagTimer: NodeJS.Timeout | null = null;
	/**
	 * When the match was started, in ms. A match taken back after a restart
	 * keeps the start its JVM's record has (`MatchRecord.startedAt`), so this is
	 * the same instant whichever process ends it.
	 */
	readonly startedAt: number;
	readonly spec: MatchSpec;
	host: MatchHost<EngineMsg> | null = null;
	protected readonly now: () => number;
	readonly runningWaiters: ((outcome: ClientOutcome) => void)[] = [];
	/** `whenRunning` timeouts not yet started, because the match is waiting for a boot slot. */
	protected readonly bootWaiters: (() => void)[] = [];
	/**
	 * This match's place among the starts waiting for a boot slot (`start-queue.ts`), 1-based, or
	 * null once its JVM is booting — and for a match that never waited.
	 */
	queuePlace: number | null = null;
	protected overTimer: NodeJS.Timeout | null = null;
	/** Waiting on Forge to end a conceded game: {@link watchConcede}. */
	protected concedeWatch: NodeJS.Timeout | null = null;
	/**
	 * True while `resume` is feeding an earlier server's lines back in. Nothing
	 * may go OUT during that: every command in the stream was already sent by the
	 * server that read it, and sending it twice would act twice in Forge.
	 */
	replaying = false;
	/** Armed while no seat is here ({@link Match.armRejoinGrace}): a match nobody comes back to is stopped. */
	protected rejoinTimer: NodeJS.Timeout | null = null;
	/** Whether {@link MatchDeps.ended} was told. */
	protected endedTold = false;

	/**
	 * The game at the start of its latest turn, from the bridge's `snapshot` line: what
	 * {@link MatchRegistry.restore} starts this match again from. Kept here and in the match's
	 * record on disk (`remember`), never only on the JVM's host.
	 */
	latestSnapshot: TurnSnapshot | null;

	/** The open restart ask: the asking seat, the turn it is about, and its {@link RESTART_ASK_MS} expiry. */
	protected restartAsk: { from: number; turn: number; timer: ReturnType<typeof setTimeout> } | null = null;
	/** The turn a restart ask was declined in: no second ask until the next. */
	protected restartDeclined: number | null = null;
	/** What {@link Match.restartState} last told, so a turn or snapshot that changes nothing tells no one. */
	protected restartKey = '';

	/**
	 * Why this server could not give the match a Forge at all (the host threw: a full
	 * disk, a JVM that could not be spawned), or null. The match is `failed` with it;
	 * `POST /play/matches` answers it as 503, since it says nothing about the match.
	 */
	unstartable: string | null = null;

	/**
	 * A match with no seat here is a JVM nobody is using: the seats have
	 * {@link MatchDeps.rejoinGraceMs} to come back before it is stopped for good. Armed when the
	 * match goes running or is taken back (its seats can join from then on, not while Forge boots)
	 * and when the last seat's departure grace runs out; {@link Match.seatConnected} disarms it. Before this covered every match, only a
	 * re-attached one had it, and a match both players had left held one of the server's two slots
	 * for ~2 h (2026-10-11: `seat-departing` for both seats, then nothing, then a refused rematch).
	 */
	armRejoinGrace(): void {
		const grace = this.deps.rejoinGraceMs ?? 0;
		if (grace <= 0 || this.rejoinTimer !== null || this.anyoneHere()) return;
		this.rejoinTimer = setTimeout(() => {
			this.rejoinTimer = null;
			if (this.anyoneHere()) return;
			// A holder watching another match is still about: wait for them another grace.
			if (this.seats.some((s) => s.owner !== null && this.deps.ownerOnline?.(s.owner) === true)) {
				this.armRejoinGrace();
				return;
			}
			this.deps.log({ evt: 'match-not-rejoined', matchId: this.id, status: this.status, afterMs: grace });
			if (this.status === 'running') this.deps.abandoned?.();
			this.stop();
		}, grace);
		this.rejoinTimer.unref();
	}

	/** The host could not give this match a JVM, now or from the start queue: see {@link unstartable}. */
	protected refuseStart(err: Error): void {
		this.unstartable = `this server could not start a match just now (${err.message})`;
		this.fail(this.unstartable);
	}

	/** seat → owner, for the on-disk record a re-attach reads and for a restore. */
	owners(): (string | null)[] {
		return this.seats.map((s) => s.owner);
	}

	/** What a re-attach or a restore of this match needs that only the match knows, onto its record on disk. */
	/**
	 * Also the chess clock's time left: written at the start, at each turn's snapshot and when the
	 * server hands the match over, so a crash between two of those gives a seat back at most a turn.
	 */
	protected remember(): void {
		const clockMs = this.clockLeft();
		this.host?.remember?.({ epoch: this.epoch, owners: this.owners(), snapshot: this.latestSnapshot, ...(clockMs === null ? {} : { clockMs }) });
	}

	/** Each seat's chess-clock time left, or null in a game without one. */
	clockLeft(): [number, number] | null {
		return this.clock?.left(this.now()) ?? null;
	}

	/**
	 * Run each seat's clock exactly while the game waits on it, and re-tell the roster when that
	 * changed — the clock rides on `forge:seats` ({@link seatIdentities}), so both screens and every
	 * watcher draw the same reading. Called wherever {@link waitingOnFor}'s inputs move: every
	 * {@link checkWaitingOn}, and every bar {@link send} puts on the wire.
	 */
	syncClock(): void {
		if (this.clock === null || this.replaying) return;
		const now = this.now();
		const running = this.status === 'running' && this.timedOut === null;
		const moved = this.clock.set([running && this.game.waitedOn(0), running && this.game.waitedOn(1)], now);
		if (!moved) return;
		if (this.flagTimer !== null) clearTimeout(this.flagTimer);
		this.flagTimer = null;
		const next = this.clock.nextFlag(now);
		if (next !== null) {
			this.flagTimer = setTimeout(() => {
				this.flagTimer = null;
				const flagged = this.clock?.flagged(this.now()) ?? null;
				if (flagged !== null) this.flag(flagged);
				else this.syncClock();
			}, next.inMs);
			this.flagTimer.unref();
		}
		this.game.tellRoster();
	}

	/** Nobody's time runs any more: the match is letting go of its game. */
	protected stopClock(): void {
		if (this.flagTimer !== null) clearTimeout(this.flagTimer);
		this.flagTimer = null;
		this.clock?.stop(this.now());
	}

	/**
	 * A seat's chess clock reached zero: it loses (the operator, 2026-10-30: *"at zero, that player
	 * loses the match"*). The server concedes the game for it, exactly as its own Concede would, and
	 * {@link gameOutcome} marks the win `timedOut`, which the room logs; the game is lost like any other.
	 */
	protected flag(seat: number): void {
		if (this.status !== 'running' || this.timedOut !== null) return;
		this.timedOut = seat;
		this.concededBy = seat;
		this.clock?.stop(this.now());
		this.deps.log({ evt: 'clock-flag', matchId: this.id, seat, left: this.clockLeft() });
		this.game.tellRoster();
		this.game.command({ t: 'act', seat, frame: { kind: 'act', method: 'concede' } });
		this.watchConcede(seat);
	}

	/**
	 * A concede always ends the game. If Forge has not ended it {@link CONCEDE_ANSWER_MS} after the
	 * concede, it is sent once more (Forge's concede is idempotent: an out player conceding again only
	 * re-runs the game-over check); if the game is still running after that, the server ends it as
	 * Forge would have, the conceding seat the loser, and Forge's game is stopped with the match.
	 */
	watchConcede(seat: number, resent = false): void {
		if (this.concedeWatch !== null) return;
		const since = this.now();
		this.concedeWatch = setTimeout(() => {
			this.concedeWatch = null;
			if (this.status !== 'running') return;
			if (!resent) {
				this.deps.log({ evt: 'concede-unanswered', matchId: this.id, seat, waitedMs: this.now() - since });
				this.game.command({ t: 'act', seat, frame: { kind: 'act', method: 'concede' } });
				this.watchConcede(seat, true);
				return;
			}
			const loser = this.seats[seat]?.playerId ?? null;
			this.deps.log({ evt: 'concede-forced', matchId: this.id, seat, playerId: loser });
			// A warning in telemetry, every time: how often Forge ignores a concede is the open question.
			report('concede-forced', { matchId: this.id, seat, waitedMs: this.now() - since }, 'warn');
			this.onLine({
				t: 'gameover',
				winner: this.spec.seats[seat === 0 ? 1 : 0]?.name ?? null,
				...(loser === null ? {} : { losers: [loser], lost: [{ player: loser, reason: 'Conceded' }] }),
			});
		}, CONCEDE_ANSWER_MS);
		this.concedeWatch.unref();
	}

	/* ── Seats ──────────────────────────────────────────────────────── */

	/** The seat this participant holds, or null. */
	seatOf(participantId: ParticipantId): number | null {
		return this.seats.find((s) => s.owner === participantId)?.seat ?? null;
	}

	/**
	 * Bind a participant to a seat, or find the one they already hold.
	 * Idempotent, permanent, and refused to anyone who could not come back.
	 */
	claim(participantId: ParticipantId): ClaimOutcome {
		const held = this.seatOf(participantId);
		if (held !== null) return { ok: true, seat: held, fresh: false };
		if (!isDurableParticipantId(participantId)) {
			return { ok: false, error: 'a seat needs a durable identity (account or device)' };
		}
		const free = this.seats.find((s) => !s.ai && s.owner === null);
		if (free === undefined) return { ok: false, error: 'match-full' };
		free.owner = participantId;
		// Written down beside the JVM: if this server is replaced mid-match, the
		// next one must seat this person at THIS seat and no other.
		this.remember();
		this.deps.log({ evt: 'seat-claimed', matchId: this.id, seat: free.seat, participantId });
		return { ok: true, seat: free.seat, fresh: true };
	}

	/**
	 * Resolves when every human seat knows its Forge player, or the match has failed. `timeoutMs`
	 * counts from when its JVM began booting: a start waiting its turn (`start-queue.ts`) is not
	 * Forge failing to start.
	 */
	whenRunning(timeoutMs: number): Promise<ClientOutcome> {
		if (this.status !== 'starting') {
			return Promise.resolve(
				this.status === 'failed' ? { ok: false, error: this.failure ?? 'failed' } : { ok: true },
			);
		}
		return new Promise((done) => {
			let timer: NodeJS.Timeout | null = null;
			const arm = (): void => {
				timer = setTimeout(() => {
					const i = this.runningWaiters.indexOf(finish);
					if (i >= 0) this.runningWaiters.splice(i, 1);
					done({ ok: false, error: 'match-starting' });
				}, timeoutMs);
			};
			const finish = (outcome: ClientOutcome): void => {
				if (timer !== null) clearTimeout(timer);
				const i = this.bootWaiters.indexOf(arm);
				if (i >= 0) this.bootWaiters.splice(i, 1);
				done(outcome);
			};
			this.runningWaiters.push(finish);
			if (this.queuePlace === null) arm();
			else this.bootWaiters.push(arm);
		});
	}

	/**
	 * The seat's last connection is gone. It stops counting as at the table once
	 * it has stayed gone for `disconnectGraceMs` — at once when that is 0. Its
	 * asks stay open: they are re-sent when it comes back.
	 */
	seatDisconnected(seat: number): void {
		const s = this.seats[seat];
		if (s === undefined || s.departure !== null) return;
		const grace = this.deps.disconnectGraceMs ?? 0;
		this.deps.log({ evt: 'seat-departing', matchId: this.id, seat, graceMs: grace, openAsks: this.game.openAsks(s.seat) });
		const gone = (): void => {
			s.here = false;
			s.away = true;
			this.game.tellRoster();
			this.armRejoinGrace();
		};
		if (grace <= 0) {
			gone();
			return;
		}
		s.departure = setTimeout(() => {
			s.departure = null;
			gone();
		}, grace);
		s.departure.unref();
	}

	/**
	 * Somebody is at the table: a seat connected now, or gone for less than the grace.
	 * A running match nobody is at is not worth holding a deploy for — the deploy hands
	 * it over, and nobody's game is interrupted (`busy.ts`).
	 */
	anyoneHere(): boolean {
		return this.seats.some((s) => s.here);
	}

	/** A connection for this seat is back: whatever `seatDisconnected` armed is off. */
	seatConnected(seat: number): void {
		const s = this.seats[seat];
		if (s === undefined) return;
		s.here = true;
		if (s.away) {
			s.away = false;
			this.game.tellRoster();
		}
		// Before the departure check, and not inside it: a seat that was never here at all (a new or
		// re-attached match) disarms it too.
		if (this.rejoinTimer !== null) {
			clearTimeout(this.rejoinTimer);
			this.rejoinTimer = null;
		}
		if (s.departure === null) return;
		clearTimeout(s.departure);
		s.departure = null;
		this.deps.log({ evt: 'seat-returned', matchId: this.id, seat, openAsks: this.game.openAsks(s.seat) });
	}

	/* ── The server is going down (Wave 22 §E) ──────────────────────── */

	/**
	 * This process is stopping and this match is NOT: let go of the JVM without
	 * killing it, so the next process can take it back. False when the match
	 * cannot outlive us — the caller then owes its seats `serverStopping`.
	 *
	 * A FINISHED match (`over`, inside its `overGraceMs`) is handed over too: its
	 * players are on its result screen, and the board and the ending they are
	 * looking at are this match's to answer after a deploy exactly as a running
	 * game's are (the operator, 2026-10-17, prod m-e055472e0d6e: a deploy turned
	 * a result screen into "no longer running"). The next process's replay ends
	 * on the same `gameover`, which re-arms the grace from there.
	 *
	 * **Nothing is emitted here, on purpose.** A frame sent now would take a `seq`
	 * that the next server's replay cannot reproduce, and the seat's cursor would
	 * be one ahead of a stream that then reuses the number. The seats learn what
	 * happened from the reconnect, which is what the client is already built for.
	 */
	handOver(): boolean {
		if (this.status !== 'starting' && this.status !== 'running' && this.status !== 'over') return false;
		if (this.host?.handOver === undefined) return false;
		if (!this.host.handOver()) return false;
		if (this.rejoinTimer !== null) clearTimeout(this.rejoinTimer);
		this.rejoinTimer = null;
		if (this.overTimer !== null) clearTimeout(this.overTimer);
		this.overTimer = null;
		this.stopClock();
		this.remember();
		this.deps.log({ evt: 'match-handed-over', matchId: this.id, epoch: this.epoch });
		return true;
	}

	protected tellEnded(): void {
		if (this.endedTold) return;
		this.endedTold = true;
		this.deps.ended?.();
	}

	/**
	 * The whole seconds in which the table changed, oldest first, for the last {@link ACTIVITY_WINDOW_MS}.
	 * Stamped on every watcher-channel state frame, so one act's burst of frames is one second, and a
	 * game waiting on a player stamps nothing. `featured.ts` reads it through {@link activity}.
	 */
	protected activeSeconds: number[] = [];

	/** When the table last changed, and in how many of the last {@link ACTIVITY_WINDOW_MS}'s seconds. */
	activity(now = this.now()): { lastAt: number | null; recent: number } {
		const from = Math.floor((now - ACTIVITY_WINDOW_MS) / 1000);
		while (this.activeSeconds.length > 0 && this.activeSeconds[0]! <= from) this.activeSeconds.shift();
		const last = this.activeSeconds.at(-1);
		return { lastAt: last === undefined ? null : last * 1000, recent: this.activeSeconds.length };
	}

	noteActivity(): void {
		const second = Math.floor(this.now() / 1000);
		if (this.activeSeconds.at(-1) !== second) this.activeSeconds.push(second);
		this.activity();
	}

	/** Where a restart of the current turn stands, the same for every socket of the match. */
	restartState(): RestartState {
		const turn = this.game.turn() ?? 0;
		const ask = this.restartAsk;
		return {
			matchId: this.id,
			turn,
			ask: ask !== null && ask.turn === turn ? { from: ask.from } : null,
			declined: this.restartDeclined === turn,
			restorable: this.restorable(turn),
		};
	}

	/** Whether `turn` can be played again from its start: the match holds that turn's snapshot, and it holds the whole game. */
	protected restorable(turn: number): boolean {
		const snap = this.latestSnapshot;
		return this.status === 'running' && snap !== null && snap.turn === turn && (snap.lossy?.length ?? 0) === 0;
	}

	/**
	 * A seat's restart act (`docs/planning/restart-turn-plan.md`). `ask`: the seat whose turn it is
	 * wants the turn played again from its start; an AI opponent allows at once, a human one is asked,
	 * and no answer in {@link RESTART_ASK_MS} is a decline. `allow` / `decline`: the other seat's
	 * answer. `cancel`: the asker takes the ask back. The game is not paused while an ask is open:
	 * an allow undoes everything since the turn began anyway.
	 */
	restartAct(seat: number, act: RestartAct): ClientOutcome {
		const s = this.seats[seat];
		if (s === undefined || s.ai) return { ok: false, error: 'no-such-seat' };
		const turn = this.game.turn();
		const open = this.restartAsk !== null && this.restartAsk.turn === turn ? this.restartAsk : null;
		if (act === 'cancel') {
			if (open === null || open.from !== seat) return { ok: false, error: 'no-ask' };
			this.deps.log({ evt: 'restart-cancelled', matchId: this.id, seat, turn });
			this.closeRestartAsk();
			this.tellRestart(true);
			return { ok: true };
		}
		if (act === 'allow' || act === 'decline') {
			if (open === null || open.from === seat) return { ok: false, error: 'no-ask' };
			return this.answerRestart(seat, act === 'allow', 'player');
		}
		if (this.status !== 'running' || turn === null) return { ok: false, error: 'not-running' };
		if (this.game.activeSeat()?.seat !== seat) return { ok: false, error: 'not-your-turn' };
		if (!this.restorable(turn)) return { ok: false, error: 'not-restorable' };
		if (open !== null) return { ok: false, error: 'already-asked' };
		if (this.restartDeclined === turn) return { ok: false, error: 'declined-this-turn' };
		const other = this.seats.find((x) => x.seat !== seat);
		if (other === undefined) return { ok: false, error: 'no-opponent' };
		this.deps.log({ evt: 'restart-asked', matchId: this.id, seat, turn, ai: other.ai });
		if (other.ai) return this.restartNow(seat, turn, 'ai');
		this.closeRestartAsk();
		const timer = setTimeout(() => this.answerRestart(other.seat, false, 'timeout'), RESTART_ASK_MS);
		timer.unref();
		this.restartAsk = { from: seat, turn, timer };
		this.tellRestart(true);
		return { ok: true };
	}

	protected answerRestart(seat: number, allow: boolean, why: 'player' | 'timeout'): ClientOutcome {
		const ask = this.restartAsk;
		if (ask === null) return { ok: false, error: 'no-ask' };
		this.closeRestartAsk();
		this.deps.log({ evt: 'restart-answered', matchId: this.id, seat, turn: ask.turn, allow, why });
		if (!allow) {
			this.restartDeclined = ask.turn;
			this.tellRestart(true);
			return { ok: true };
		}
		if (this.game.turn() !== ask.turn || !this.restorable(ask.turn)) {
			this.tellRestart(true);
			return { ok: false, error: 'turn-moved-on' };
		}
		return this.restartNow(ask.from, ask.turn, 'opponent');
	}

	protected restartNow(seat: number, turn: number, allowedBy: 'ai' | 'opponent'): ClientOutcome {
		if (this.deps.restartTurn === undefined) return { ok: false, error: 'cannot-restart' };
		this.deps.log({ evt: 'restart-turn', matchId: this.id, seat, turn, allowedBy });
		this.deps.restartTurn();
		return { ok: true };
	}

	protected closeRestartAsk(): void {
		if (this.restartAsk !== null) clearTimeout(this.restartAsk.timer);
		this.restartAsk = null;
	}

	/** Tell every socket where a restart stands, when it changed (or always, `force`: an act's own answer). */
	tellRestart(force = false): void {
		const state = this.restartState();
		const key = JSON.stringify(state);
		if (!force && key === this.restartKey) return;
		this.restartKey = key;
		this.deps.restartChanged?.(state);
	}
	/** The game this match plays: every fact about it the shell needs is asked of it. Set by the composing match, before anything can reach it. */
	protected game!: GameSession<EngineMsg, EngineMsg>;
	abstract readonly seats: readonly ShellSeat[];
	protected readonly deps: ShellDeps;

	constructor(
		id: string,
		spec: MatchSpec,
		deps: ShellDeps,
		restore?: { epoch: string | null; startedAt: number; snapshot?: TurnSnapshot | null; clockMs?: [number, number] },
	) {
		this.id = id;
		this.spec = spec;
		this.deps = deps;
		this.now = deps.now ?? Date.now;
		// A match taken back keeps the time its seats had left when it was last written down; the gap the
		// server was down for is nobody's (`remember`'s callers say how stale that can be).
		const clockMs = restore?.clockMs ?? spec.clockMs;
		this.clock = clockMs === undefined ? null : new ChessClock(clockMs);
		this.startedAt = restore?.startedAt ?? this.now();
		this.epoch = restore?.epoch ?? `${id}:${this.startedAt}`;
		this.latestSnapshot = restore?.snapshot ?? null;
	}

	/** One line from the engine, as the composing match reads it: a concede the engine never ends ends here as its game-over would. */
	protected abstract onLine(line: EngineMsg): void;
	abstract fail(reason: string, frames?: string[]): void;
	abstract stop(): void;
}
