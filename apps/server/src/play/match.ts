/**
 * One match: Forge's stream in, one projected stream per seat out. Socket-free
 * on purpose, for the reason `room/draftRooms.ts` gives — the hazards here
 * (whose hand, which cursor, which ask) are tested by calling functions, not by
 * racing sockets. `socket.ts` is the half that needs `io`.
 *
 * ## Participants → seats → Forge players: the join point
 *
 * Three identities meet here, and every one of them is a different kind of id:
 *
 *   ParticipantId (`fk:…` / `dev:…`)  — who the PERSON is, from the edge headers
 *                                        (`room/identity.ts`). Never from a payload.
 *   seat (0, 1)                       — the lobby slot Forge seated the bridge's
 *                                        client in; the bridge asserts seat i is
 *                                        slot i (`PlayBridge.java`, "IN SEAT ORDER").
 *   Forge PlayerView id               — who that seat IS inside the game, learned
 *                                        from that seat's own `openView(myPlayers)`.
 *
 * `claim` binds a participant to a seat the first time they join, and the
 * binding is PERMANENT for the match. That is deliberately not the
 * `@wolffm/rooms-protocol` seat table's behaviour: there a departed player's
 * seat is released (and at most held for a TTL) so someone else can sit down,
 * which is right for a draft pod with bots and wrong here — a Forge seat has a
 * hand, and whoever took it over would be handed that hand. So a seat is never
 * transferred, a disconnect does not unseat, and only a durable identity may
 * claim one (an ephemeral id dies with its socket and could never come back).
 *
 * ## Per recipient, all the way down
 *
 * Each seat has its own projector (`visibility.ts`), its own cursor and its own
 * history. Nothing in this file produces a payload without naming the seat it
 * is for, and `emit` is handed `(seat, envelope)` — there is no call that sends
 * one envelope to two seats.
 *
 * ## Asks
 *
 * An open ask parks a Forge thread (`ReplyPool.get`, untimed). Usually a seat
 * has one — the game thread is single — but a diagnostic probe can open a
 * second, so asks are held by `callId` and each is answered or aborted on its
 * own; aborting one never touches another. Each is answered by the seat's
 * reply, or aborted — by the browser (`abort`), by the seat's last socket
 * going away and staying gone for `disconnectGraceMs` (`disconnected`, the
 * manager's clarification of the contract), or by the timeout armed on every
 * ask (`timeout`). An abort gets Forge's own answer to a null reply (the
 * bridge's `ABORTED` path), exactly what `FServerManager`'s `cancelAll` would
 * produce.
 *
 * ## Reconnect: a refresh is not a departure (Wave 10)
 *
 * A browser refresh closes the old socket BEFORE the new page connects. Wave 9
 * aborted the seat's asks on that close, so a refresh during a prompt handed
 * Forge a null answer — Forge acted for the player. Now the close only arms a
 * timer; a join for the same seat within `disconnectGraceMs` (`seatConnected`)
 * disarms it, and the open ask, still parked in Forge, is re-sent after the
 * snapshot with its original `callId`. The rest was already the draft's
 * machinery: the seat is bound to the participant permanently (the
 * reservation, never released), and the snapshot's cursor is on the same
 * epoch, so the client's `classifySeq` continues from it rather than seeing a
 * new match.
 *
 * ## Crash: the seats are told, on the stream they already read (Wave 10)
 *
 * When the JVM dies (or the bridge sends `fatal`) mid-match, `fail` sends every
 * seat that has a board a `showErrorDialog` notify — a frame forge-wire already
 * defines, on the seat's next cursor — and keeps it, so a seat that resyncs or
 * refreshes afterwards gets the board it had plus the same notice. The room,
 * the socket server and every other match are untouched: only this match's
 * status moves to `failed`, and `GET /play/matches/:id` says why.
 */

import { randomBytes } from 'node:crypto';
import { isDurableParticipantId, type ParticipantId } from '@wolffm/rooms-protocol';
import {
	isBlocking,
	isTierC,
	safeParseServerFrame,
	type ClientFrame,
	type ServerFrame,
} from '@hadoku/forge-wire';

import type { BridgeLine, MatchHost, MatchHostFactory, MatchSpec } from './host.js';
import type { MatchSnapshot, ServerEnvelope, WireCursor } from './transport.js';
import { createProjector, foldFrames, type ObjTable, type SeatProjector, type StateFrame } from './visibility.js';

export type MatchStatus = 'starting' | 'running' | 'over' | 'failed' | 'stopped';

export interface OpenAsk {
	callId: string;
	method: string;
	frame: ServerFrame;
	sentAt: number;
	timer: NodeJS.Timeout;
}

export interface SeatState {
	seat: number;
	ai: boolean;
	/** Bound on first claim, never changed. */
	owner: ParticipantId | null;
	/** From this seat's `openView`. Null until Forge has opened the game. */
	playerId: number | null;
	readonly projector: SeatProjector;
	/** The last `forge:s2c` seq this seat was sent. 0 = none yet. */
	seq: number;
	/** Every state frame this seat was sent, projected — the snapshot. */
	history: ServerFrame[];
	/** State frames that arrived before `openView` named the viewer. */
	early: StateFrame[];
	/** Open asks by callId, in the order they were sent. */
	asks: Map<string, OpenAsk>;
	/** The latest prompt and buttons, re-sent after a snapshot. */
	prompt: ServerFrame | null;
	buttons: ServerFrame | null;
	deck: string | null;
	/** The notice sent when the match failed; re-sent after every later snapshot. */
	ended: ServerFrame | null;
	/** Armed when the seat's last connection went; aborts its asks when it fires. */
	departure: NodeJS.Timeout | null;
}

export interface MatchDeps {
	host: MatchHostFactory;
	/** Deliver one envelope to every connection bound to this seat. */
	emit(seat: number, envelope: ServerEnvelope): void;
	log(entry: Record<string, unknown>): void;
	/** Every ask is aborted after this long unanswered. */
	askTimeoutMs: number;
	/** How long a finished match keeps its JVM (and answers resyncs) before stopping. */
	overGraceMs: number;
	/**
	 * How long a seat with no connection keeps its open asks before they are
	 * aborted as `disconnected`. 0 (the default) aborts at once — Wave 9's
	 * behaviour; `attachPlay` passes 30 s so a refresh survives.
	 */
	disconnectGraceMs?: number;
	now?: () => number;
}

/** What a seat is shown when its match fails. Title and wording are ours; the frame is forge-wire's. */
export const MATCH_ENDED_TITLE = 'Match ended';

export type ClaimOutcome = { ok: true; seat: number; fresh: boolean } | { ok: false; error: string };
export type ClientOutcome = { ok: true } | { ok: false; error: string };
export interface ProbeResult {
	answer?: boolean;
	ms?: number;
	error?: string;
}

export function newMatchId(): string {
	return `m-${randomBytes(6).toString('hex')}`;
}

export class Match {
	readonly id: string;
	/** Minted per match-process start: a restart is a new epoch. */
	readonly epoch: string;
	status: MatchStatus = 'starting';
	failure: string | null = null;
	winner: string | null = null;
	readonly seats: SeatState[];
	/** Frames Forge sent that forge-wire refused. Dropped, counted, logged. */
	invalidFrames = 0;

	private readonly deps: MatchDeps;
	private readonly spec: MatchSpec;
	private host: MatchHost | null = null;
	private readonly now: () => number;
	private readonly runningWaiters: ((outcome: ClientOutcome) => void)[] = [];
	private readonly probes = new Map<string, (r: ProbeResult) => void>();
	private overTimer: NodeJS.Timeout | null = null;

	constructor(id: string, spec: MatchSpec, deps: MatchDeps) {
		this.id = id;
		this.spec = spec;
		this.deps = deps;
		this.now = deps.now ?? Date.now;
		this.epoch = `${id}:${this.now()}`;
		this.seats = spec.seats.map((s, seat) => ({
			seat,
			ai: s.ai,
			owner: null,
			playerId: null,
			projector: createProjector(),
			seq: 0,
			history: [],
			early: [],
			asks: new Map(),
			prompt: null,
			buttons: null,
			deck: null,
			ended: null,
			departure: null,
		}));
	}

	/** Start Forge. Separate from the constructor so nothing can emit before the match is registered. */
	start(): void {
		if (this.host !== null) return;
		this.host = this.deps.host(this.id, this.spec, {
			line: (line) => this.onLine(line),
			exit: (reason) => this.onExit(reason),
			log: (entry) => this.deps.log(entry),
		});
	}

	private command(command: Parameters<MatchHost['send']>[0]): void {
		if (this.host === null) throw new Error(`match ${this.id} was never started`);
		this.host.send(command);
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
		this.deps.log({ evt: 'seat-claimed', matchId: this.id, seat: free.seat, participantId });
		return { ok: true, seat: free.seat, fresh: true };
	}

	/** Resolves when every human seat knows its Forge player, or the match has failed. */
	whenRunning(timeoutMs: number): Promise<ClientOutcome> {
		if (this.status !== 'starting') {
			return Promise.resolve(
				this.status === 'failed' ? { ok: false, error: this.failure ?? 'failed' } : { ok: true },
			);
		}
		return new Promise((done) => {
			const timer = setTimeout(() => {
				const i = this.runningWaiters.indexOf(finish);
				if (i >= 0) this.runningWaiters.splice(i, 1);
				done({ ok: false, error: 'match-starting' });
			}, timeoutMs);
			const finish = (outcome: ClientOutcome): void => {
				clearTimeout(timer);
				done(outcome);
			};
			this.runningWaiters.push(finish);
		});
	}

	/** The snapshot for one seat. See `transport.ts` for why `cursor` is the latest of any kind. */
	snapshot(seat: number): MatchSnapshot | { error: string } {
		const s = this.seats[seat];
		if (s === undefined || s.ai) return { error: 'no-such-seat' };
		if (s.playerId === null) return { error: this.status === 'failed' ? (this.failure ?? 'failed') : 'match-starting' };
		return {
			matchId: this.id,
			seat,
			playerId: s.playerId,
			cursor: s.seq === 0 ? null : { epoch: this.epoch, seq: s.seq },
			frames: [...s.history],
		};
	}

	/**
	 * The state this seat should hold right now — its own projected history,
	 * folded. Diagnostic: it is how a live check compares a browser's board with
	 * the server's, and it is only reachable behind the probe flag.
	 */
	seatState(seat: number): { cursor: WireCursor | null; objects: ObjTable } | { error: string } {
		const s = this.seats[seat];
		if (s === undefined || s.ai) return { error: 'no-such-seat' };
		const state = foldFrames(s.history as unknown as StateFrame[]);
		return { cursor: s.seq === 0 ? null : { epoch: this.epoch, seq: s.seq }, objects: Object.fromEntries(state) };
	}

	/**
	 * After a snapshot: what the seat needs that the state channel does not
	 * carry — the prompt and buttons of the moment, and the open ask, if any.
	 * Each is a normal frame with the next cursor.
	 */
	resendAfterSnapshot(seat: number): void {
		const s = this.seats[seat];
		if (s === undefined) return;
		if (s.prompt !== null) this.send(s, s.prompt);
		if (s.buttons !== null) this.send(s, s.buttons);
		for (const ask of s.asks.values()) this.send(s, ask.frame);
		if (s.ended !== null) this.send(s, s.ended);
	}

	/* ── Browser → Forge ────────────────────────────────────────────── */

	fromClient(seat: number, frame: ClientFrame): ClientOutcome {
		const s = this.seats[seat];
		if (s === undefined || s.ai) return { ok: false, error: 'no-such-seat' };
		if (this.status !== 'running') return { ok: false, error: `match is ${this.status}` };
		switch (frame.kind) {
			case 'act':
				this.command({ t: 'act', seat, frame });
				return { ok: true };
			case 'reply': {
				const ask = s.asks.get(frame.callId);
				if (ask === undefined) return { ok: false, error: 'stale-reply' };
				if (ask.method !== frame.method) {
					return { ok: false, error: `reply is for ${frame.method}, the open ask is ${ask.method}` };
				}
				this.closeAsk(s, ask.callId);
				this.deps.log({
					evt: 'ask-answered',
					matchId: this.id,
					seat,
					callId: frame.callId,
					method: frame.method,
					ms: this.now() - ask.sentAt,
				});
				this.command({ t: 'reply', seat, callId: frame.callId, result: frame.result });
				return { ok: true };
			}
			case 'abort': {
				if (!s.asks.has(frame.callId)) return { ok: false, error: 'stale-abort' };
				this.abortAsk(s, frame.callId, frame.reason);
				return { ok: true };
			}
		}
	}

	/**
	 * The seat's last connection is gone. Its asks are aborted as `disconnected`
	 * once it has stayed gone for `disconnectGraceMs` — at once when that is 0.
	 */
	seatDisconnected(seat: number): void {
		const s = this.seats[seat];
		if (s === undefined || s.departure !== null) return;
		const grace = this.deps.disconnectGraceMs ?? 0;
		if (grace <= 0) {
			this.abortAllAsks(s);
			return;
		}
		this.deps.log({ evt: 'seat-departing', matchId: this.id, seat, graceMs: grace, openAsks: s.asks.size });
		s.departure = setTimeout(() => {
			s.departure = null;
			this.abortAllAsks(s);
		}, grace);
		s.departure.unref();
	}

	/** A connection for this seat is back: whatever `seatDisconnected` armed is off. */
	seatConnected(seat: number): void {
		const s = this.seats[seat];
		if (s === undefined || s.departure === null) return;
		clearTimeout(s.departure);
		s.departure = null;
		this.deps.log({ evt: 'seat-returned', matchId: this.id, seat, openAsks: s.asks.size });
	}

	private abortAllAsks(s: SeatState): void {
		for (const callId of [...s.asks.keys()]) this.abortAsk(s, callId, 'disconnected');
	}

	/** A real server-side `showConfirmDialog` to one seat — see `PlayBridge.probe`. */
	probe(seat: number, message: string, timeoutMs: number): Promise<ProbeResult> {
		const probeId = `p-${randomBytes(4).toString('hex')}`;
		return new Promise((done) => {
			const timer = setTimeout(() => {
				this.probes.delete(probeId);
				done({ error: 'probe timed out' });
			}, timeoutMs);
			this.probes.set(probeId, (r) => {
				clearTimeout(timer);
				done(r);
			});
			this.command({ t: 'probe', seat, probeId, message });
		});
	}

	/** Stop on purpose. The JVM's exit that follows is then not a failure. */
	stop(): void {
		if (this.status !== 'starting' && this.status !== 'running' && this.status !== 'over') return;
		this.status = 'stopped';
		for (const done of this.runningWaiters.splice(0)) done({ ok: false, error: 'stopped' });
		this.closeAllAsks();
		this.host?.stop();
	}

	/* ── Forge → browser ────────────────────────────────────────────── */

	private send(s: SeatState, frame: ServerFrame): void {
		s.seq += 1;
		const cursor: WireCursor = { epoch: this.epoch, seq: s.seq };
		this.deps.emit(s.seat, { matchId: this.id, cursor, frame });
	}

	private sendState(s: SeatState, raw: StateFrame): void {
		const projected = s.projector.project(raw) as unknown as ServerFrame;
		s.history.push(projected);
		this.send(s, projected);
	}

	private onLine(line: BridgeLine): void {
		switch (line.t) {
			case 'ready':
				for (const info of line.seats) {
					const s = this.seats[info.seat];
					if (s !== undefined) s.deck = info.deck;
				}
				this.deps.log({ evt: 'forge-ready', matchId: this.id, bootMs: line.bootMs });
				return;
			case 'frame':
				this.onFrame(line.seat, line.frame);
				return;
			case 'probe': {
				const done = this.probes.get(line.probeId);
				this.probes.delete(line.probeId);
				const { t: _t, ...result } = line;
				this.deps.log({ evt: 'probe', matchId: this.id, ...result });
				done?.({ answer: line.answer, ms: line.ms, error: line.error });
				return;
			}
			case 'gameover':
				this.status = 'over';
				this.winner = line.winner;
				this.deps.log({ evt: 'game-over', matchId: this.id, winner: line.winner });
				this.overTimer = setTimeout(() => this.host?.stop(), this.deps.overGraceMs);
				this.overTimer.unref();
				return;
			case 'fatal':
				this.fail(line.message);
				return;
			case 'rejected':
			case 'stale':
			case 'unsupported': {
				const { t, ...detail } = line;
				this.deps.log({ evt: `bridge-${t}`, matchId: this.id, ...detail });
				return;
			}
		}
	}

	private onFrame(seat: number, raw: unknown): void {
		const s = this.seats[seat];
		if (s === undefined || s.ai) {
			this.deps.log({ evt: 'frame-for-unknown-seat', matchId: this.id, seat });
			return;
		}
		const parsed = safeParseServerFrame(raw);
		if (!parsed.ok) {
			this.invalidFrames += 1;
			this.deps.log({
				evt: 'frame-invalid',
				matchId: this.id,
				seat,
				method: (raw as { method?: unknown } | null)?.method,
				errors: parsed.errors.slice(0, 5),
			});
			return;
		}
		const frame = parsed.value;

		if (isTierC(frame.method)) {
			const state = frame as unknown as StateFrame;
			if (state.method === 'openView') {
				this.openView(s, state);
				return;
			}
			if (s.playerId === null) {
				s.early.push(state);
				return;
			}
			this.sendState(s, state);
			return;
		}

		if (frame.kind === 'ask' && isBlocking(frame.method)) {
			const callId = frame.callId;
			const timer = setTimeout(() => this.abortAsk(s, callId, 'timeout'), this.deps.askTimeoutMs);
			timer.unref();
			s.asks.set(callId, { callId, method: frame.method, frame, sentAt: this.now(), timer });
		} else if (frame.method === 'showPromptMessage') {
			s.prompt = frame;
		} else if (frame.method === 'updateButtons') {
			s.buttons = frame;
		}
		this.send(s, frame);
	}

	/**
	 * `openView(myPlayers)` names the viewer. It is sent first, then any state
	 * that arrived before it, projected now that there is someone to project for.
	 */
	private openView(s: SeatState, frame: Extract<StateFrame, { method: 'openView' }>): void {
		const [playerId] = frame.payload.myPlayers;
		if (playerId === undefined) return;
		if (s.playerId !== null && s.playerId !== playerId) {
			// A seat's player cannot change mid-match; if it did, every projection
			// so far was for the wrong person.
			this.fail(`seat ${s.seat} was reopened as player ${playerId}, was ${s.playerId}`);
			return;
		}
		s.playerId = playerId;
		s.projector.setViewer(playerId);
		s.history.push(frame as unknown as ServerFrame);
		this.send(s, frame as unknown as ServerFrame);
		for (const early of s.early.splice(0)) this.sendState(s, early);
		this.deps.log({ evt: 'seat-opened', matchId: this.id, seat: s.seat, playerId });

		if (this.status === 'starting' && this.seats.every((x) => x.ai || x.playerId !== null)) {
			this.status = 'running';
			for (const done of this.runningWaiters.splice(0)) done({ ok: true });
		}
	}

	private closeAsk(s: SeatState, callId: string): void {
		const ask = s.asks.get(callId);
		if (ask !== undefined) clearTimeout(ask.timer);
		s.asks.delete(callId);
	}

	private closeAllAsks(): void {
		for (const s of this.seats) {
			for (const callId of [...s.asks.keys()]) this.closeAsk(s, callId);
			if (s.departure !== null) clearTimeout(s.departure);
			s.departure = null;
		}
	}

	private abortAsk(
		s: SeatState,
		callId: string,
		reason: 'disconnected' | 'timeout' | 'cancelled' | 'unsupported',
	): void {
		const ask = s.asks.get(callId);
		if (ask === undefined) return;
		this.closeAsk(s, callId);
		this.deps.log({ evt: 'ask-aborted', matchId: this.id, seat: s.seat, callId, method: ask.method, reason });
		this.command({ t: 'abort', seat: s.seat, callId, reason });
	}

	private fail(reason: string): void {
		if (this.status === 'failed' || this.status === 'stopped') return;
		this.status = 'failed';
		this.failure = reason;
		this.deps.log({ evt: 'match-failed', matchId: this.id, reason });
		for (const done of this.runningWaiters.splice(0)) done({ ok: false, error: reason });
		this.closeAllAsks();
		this.tellSeatsItEnded(reason);
		this.host?.stop();
	}

	/**
	 * Every seat with a board is told, on its own stream, that this match is
	 * over and why — so a dead JVM reads as an ending, not as a game that went
	 * quiet. The reason's server path (`see …/bridge.stderr.txt`) stays in the
	 * log and the status route; the seat gets the cause.
	 */
	private tellSeatsItEnded(reason: string): void {
		const cause = reason.split('; see ')[0] ?? reason;
		for (const s of this.seats) {
			if (s.ai || s.playerId === null || s.ended !== null) continue;
			s.ended = {
				kind: 'notify',
				method: 'showErrorDialog',
				title: MATCH_ENDED_TITLE,
				message: `Forge stopped, and this match cannot continue: ${cause}.`,
			} as ServerFrame;
			this.send(s, s.ended);
		}
	}

	private onExit(reason: string): void {
		if (this.overTimer !== null) clearTimeout(this.overTimer);
		this.closeAllAsks();
		for (const [, done] of this.probes) done({ error: 'the match ended' });
		this.probes.clear();
		if (this.status === 'starting' || this.status === 'running') {
			this.fail(reason);
			return;
		}
		if (this.status === 'over') this.status = 'stopped';
	}
}

/* ── The registry ────────────────────────────────────────────────────── */

export interface MatchRegistry {
	create(spec: MatchSpec): Match;
	get(id: string): Match | undefined;
	/** Matches that hold a JVM: starting, running, or over-but-not-yet-stopped. */
	active(): Match[];
	stopAll(): void;
}

export type RegistryDeps = Omit<MatchDeps, 'emit'> & {
	emit(match: Match, seat: number, envelope: ServerEnvelope): void;
};

export function createMatchRegistry(deps: RegistryDeps): MatchRegistry {
	const matches = new Map<string, Match>();
	return {
		create(spec) {
			const id = newMatchId();
			const match: Match = new Match(id, spec, {
				...deps,
				emit: (seat, envelope) => deps.emit(match, seat, envelope),
			});
			matches.set(id, match);
			match.start();
			return match;
		},
		get: (id) => matches.get(id),
		active: () => [...matches.values()].filter((m) => m.status === 'starting' || m.status === 'running' || m.status === 'over'),
		stopAll() {
			for (const m of matches.values()) m.stop();
		},
	};
}
