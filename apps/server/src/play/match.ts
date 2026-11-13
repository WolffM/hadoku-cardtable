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
 * second, so asks are held by `callId` and each is answered on its own.
 *
 * **An ask stays open for as long as the match lives.** Nothing here aborts
 * one for a seat that went away or took too long: an abort hands Forge a null
 * where most effects expect an answer, and many do not check
 * (`ChooseCardNameEffect.resolve` threw on one on the game thread, prod
 * m-dd37bda1c441, and the game loop died with it). A seat that comes back is
 * re-sent every open ask after its snapshot. The browser's own `abort` reaches
 * Forge only for the asks whose aborted answer is Forge's own default, never a
 * null ({@link ABORT_SAFE}); an ask the server cannot parse is shown as a
 * plain pick of its whole answers instead (`unparsed.ts`). An ask goes away
 * unanswered only with its match.
 *
 * ## Reconnect: a refresh is not a departure (Wave 10)
 *
 * A browser refresh closes the old socket BEFORE the new page connects. The
 * open ask, still parked in Forge, is re-sent after the new page's snapshot
 * with its original `callId`, however long the seat was gone. The rest was already the draft's
 * machinery: the seat is bound to the participant permanently (the
 * reservation, never released), and the snapshot's cursor is on the same
 * epoch, so the client's `classifySeq` continues from it rather than seeing a
 * new match.
 *
 * ## Restart: a deploy is a reconnect, not an ending (Wave 22 §E)
 *
 * A `pm2 restart` used to end every live game: the process exited and
 * `host.ts`'s exit hook SIGKILLed every JVM, so the client's next `forge:join`
 * was answered `unknown-match`. The JVM now outlives the server (see
 * `host.ts`, "A match outlives its server") and `MatchShell`'s `handOver` plus `HostedMatch`'s
 * `resume` (`match/shell.ts`, `match/hosted.ts` — both generic over any engine) are the half that
 * rebuilds a match around one; this file adds Forge's own `serverStopping`.
 *
 * - **Going down**: `handOver` lets go of the JVM without killing it and emits
 *   NOTHING. A frame sent on the way out would take a `seq` the next server's
 *   replay cannot reproduce. A match that cannot be handed over gets
 *   `serverStopping` instead, which tells its seats in words.
 * - **Coming back**: `HostedMatch`'s `resume` is `start`'s twin. The host replays every line
 *   the dead server read — synchronously, before the first live line — so each
 *   seat's projector, history, `seq`, prompt, buttons and open asks rebuild
 *   themselves from exactly the input that built them the first time. Two
 *   things a replay cannot reproduce come off disk instead: the **epoch** (a
 *   new one would make every client's cursor a stranger) and the seats'
 *   **owners** (a re-seated player would be handed the other player's hand).
 * - **Commands are not replayed outward.** `replaying` gags `command`: every
 *   reply, abort, auto-pass and auto-payment in the stream was already sent by
 *   the server that read it. The two that CLOSE an ask are fed back in through
 *   `GameSession.replayed` (`ForgeSession.replayed`), because nothing the bridge says records
 *   that an ask was answered — without it a seat would be re-shown a modal it had
 *   already dismissed.
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
import { type ParticipantId } from '@wolffm/rooms-protocol';
import { type ClientFrame, type EndedBy, type ServerFrame, type TriggerDecision } from '@hadoku/forge-wire';
import {
	type RememberedTrigger,
	type RestartState,
	type StopPhase,
	type MatchSnapshot,
	type SeatIdentity,
	type Look,
	type ServerEnvelope,
	type TableGameLive,
	type WireCursor,
} from '@hadoku/shared';

import { type StopPolicy } from './auto.js';
import { type ArtCatalog, type ArtIds } from './art-ids.js';
import { MAX_CONCURRENT_MATCHES, type MatchRecord, type MatchSpec, type TurnSnapshot } from '@hadoku/game-server/play/host';
import type { BridgeCommand, BridgeLine } from './bridge-protocol.js';
import { runBotGame, type BotGameInput, type BotGameOutcome } from './botgames.js';
import type { SpellCopy } from './spell-copiers.js';
import { type OutcomeFacts, winnerSeatFromLosers } from '@hadoku/game-server/play/match/outcome';
import { ForgeSession, type SeatState } from './match/forge-session.js';
import { type ClientOutcome } from '@hadoku/game-server/play/match/shell';
import { HostedMatch, type HostedMatchDeps } from '@hadoku/game-server/play/match/hosted';
import { ENDED_KEPT, EndedMatch, restoredSpec, type RegistryDeps, type Restored, type ResumeFrom } from './match/registry.js';
import { newMatchId, type ProbeResult } from './match/forge-frames.js';

/**
 * `host.ts`'s `SeatSpec`, widened with the name the caller gave the seat. The
 * seat's avatar is not here: it is its holder's, asked on every roster
 * ({@link MatchDeps.seatAvatar}).
 *
 * Declared here rather than on `SeatSpec` itself: `host.ts` is owned by
 * neither wave-29 lane, and it does not need to change to carry this. Read
 * `apps/server/src/play/bridge/PlayBridge.java`'s `configFrom` to confirm —
 * it pulls `name`/`ai`/`deck` off each seat's JSON object by key and ignores
 * anything else, so the extra property `bridgeConfig`'s `...spec` spread
 * carries into `config.json` is inert there: Forge never reads it and never
 * shows it.
 */
export type SeatSpecWithIdentity = MatchSpec['seats'][number] & {
	/**
	 * The name the caller GAVE this seat (wave 31 §S, `socket.ts`'s `names`),
	 * sanitised and unique within the match — and the same string as `name`,
	 * which is what Forge shows. Absent when none was given, so `name` is then
	 * only a fallback (`Seat 1`) and {@link SeatIdentity.name} says nothing.
	 */
	displayName?: string;
	/** A probe-only portrait for a match no room started (`socket.ts`'s `avatars`); a room's own avatar wins. */
	avatarId?: string;
};

/** `MatchSpec`, with both seats widened the same way. */
export type MatchSpecWithIdentity = Omit<MatchSpec, 'seats'> & {
	seats: [SeatSpecWithIdentity & { ai: false }, SeatSpecWithIdentity];
};

import { type ObjTable } from './visibility.js';


/** Why the server called a game a draw ({@link Match.forceDraw}): it ran `GAME_DRAWN_AFTER_MS`. */
export type DrawReason = EndedBy;

/**
 * How a game ended. A game is finished only when Forge called it — a victory
 * and a defeat (an explicit concede is a defeat), or a draw by the rules. A
 * game the server ended any other way (nobody came back, the room closed, the
 * JVM died, the server stopped) has no outcome at all: no report, and no game
 * in its table's series.
 */
export type GameOutcome =
	/** `timedOut`: the loser's chess clock ran out. It loses this game, as any loss does; the log and the result screen say why. */
	| { kind: 'won'; winner: 0 | 1; conceded: boolean; timedOut?: true }
	| { kind: 'drawn' }
	/** Forge named a winner that no seat can be told from. */
	| { kind: 'unplaced' };

/**
 * The ONE place a game's outcome is classified; every reader of a result (the
 * stats report, the table's series) asks this. Null when the game did not
 * finish. The winner is the seat that did not concede, else the seat Forge's
 * own losers leave standing ({@link winnerSeatFromLosers}), else the seat whose
 * name — the name Forge was given, unique within the match — Forge named.
 */
export function gameOutcome(match: OutcomeFacts): GameOutcome | null {
	if (match.endedAt === null) return null;
	if (match.concededBy === 0 || match.concededBy === 1) {
		return { kind: 'won', winner: match.concededBy === 0 ? 1 : 0, conceded: true, ...(match.timedOut === match.concededBy ? { timedOut: true as const } : {}) };
	}
	// Forge names no winner only for a draw (`GameOutcome.getWinningLobbyPlayer`).
	if (match.winner === null) return { kind: 'drawn' };
	if (match.winnerSeat !== null) return { kind: 'won', winner: match.winnerSeat, conceded: false };
	const named = match.spec.seats.findIndex((s) => s.name === match.winner);
	return named === 0 || named === 1 ? { kind: 'won', winner: named, conceded: false } : { kind: 'unplaced' };
}

export interface MatchDeps extends HostedMatchDeps<BridgeLine, BridgeCommand> {
	/** The card catalog every face's art id is decided from (`art-ids.ts`). Absent: the committed art table alone. */
	catalog?: ArtCatalog | null;
	/**
	 * The card names legal in a format id (`names.ts`'s `formatNameSets`), or null
	 * when the format has no list. Absent: every card-name ask offers Forge's whole list.
	 */
	formatNames?(format: string): ReadonlySet<string> | null;
	/**
	 * A card name's spell-copying abilities, off Forge's own scripts (`spell-copiers.ts`),
	 * or undefined for a card that copies none. Absent: nothing copies, and a seat's own
	 * spell is passed as `own-spell` always (`auto.ts`'s `holdForSpellCopy`).
	 */
	spellCopiers?(name: string): readonly SpellCopy[] | undefined;
	/** Deliver one envelope to every connection bound to this seat. */
	emit(seat: number, envelope: ServerEnvelope): void;
	/** How long a finished match keeps its JVM (and answers resyncs) before stopping. */
	overGraceMs: number;
	/**
	 * The {@link StopPolicy} a NEW match's seats start on. Absent — which is
	 * production — means {@link DEFAULT_STOP_POLICY}, and `socket.test.ts` holds
	 * that assertion.
	 *
	 * This is the SELECTOR half of wave 26 §E's per-seat policy, and it is
	 * deliberately a starting value rather than a second mechanism: a seat still
	 * owns its own policy and {@link Match.setStopPolicy} still moves one seat
	 * without touching the other. What this changes is only where seat 0 and
	 * seat 1 begin.
	 *
	 * `attachPlay` fills it from `CARDTABLE_PLAY_STOP_POLICY`
	 * (`socket.ts`'s `parseStopPolicyEnv`) — the hatch that lets a spec, or a
	 * screenshot, catch a payment the default would have had Forge answer.
	 */
	stopPolicy?: StopPolicy;
	/**
	 * The avatar the holder of a seat wears, asked on every roster
	 * ({@link Match.seatIdentities}) — never copied into the match, so a face
	 * cannot go stale across an avatar change or a restart. `index.ts` answers it
	 * from the room that started the match (`http/routes.ts`'s `seatAvatar`).
	 * Undefined for a holder with none; absent (a unit suite, a match no room
	 * started) means no seat has one. Forge's AI seat is asked as `AI_SEAT_OWNER`:
	 * the room's AI plays as one of its characters.
	 */
	seatAvatar?(matchId: string, owner: ParticipantId): string | undefined;
	/** The holder's picture and cosmetics, asked like {@link seatAvatar}: never copied into the match. */
	seatLook?(matchId: string, owner: ParticipantId): Look | undefined;
	/**
	 * Every seat's identity changed — `Match.seatAvatarChanged` (wave 32, Q6). The
	 * socket layer re-sends `forge:seats` to every socket in the match; a deps
	 * with none (a unit suite) simply never tells anyone.
	 */
	seatsChanged?(seats: SeatIdentity[]): void;
	/** A seat's stop ({@link Match.setPhaseStop}) was set, cleared or spent: the socket layer tells that seat's sockets. */
	phaseStopChanged?(seat: number, phase: StopPhase | null): void;
	/**
	 * Where the game stands, as the table card draws it ({@link Match.live}), moved on: a new turn, the
	 * other seat's turn, a life total. The room's screens read the room again; a hand's size alone,
	 * which moves with every draw and cast, is read with them rather than told.
	 */
	liveChanged?(): void;
	/**
	 * Forge said the game is over — `winner` and the seats' histories are final.
	 * Not called for a game-over replayed into a resumed match: the server that
	 * read it live already told whoever was listening.
	 */
	onGameOver?(): void;
	/** {@link Match.armActWatch}'s silence before it asks the bridge to re-send. Absent is {@link ACT_SILENCE_MS}. */
	actSilenceMs?: number;
}

/**
 * Forge's own {@link HostedMatch}: every fact about the game itself is asked of {@link session},
 * a `ForgeSession`. `fixtures/toy-game/match.ts`'s `ToyMatch` and `runtimes/relay-match.ts`'s
 * `RelayMatch` are `HostedMatch` over their own `GameSession`s the same way.
 */
export class Match extends HostedMatch<BridgeLine, BridgeCommand> {
	winner: string | null = null;
	/**
	 * The winning seat, from Forge's own `losers` (player ids) mapped through each
	 * seat's player id — set when the game ends, null when it cannot be told. The
	 * only way an AI game names its winner: the AI seat has no display name for
	 * `winner` to match, and no player id of its own (it never opens a view).
	 */
	winnerSeat: 0 | 1 | null = null;
	/** Why the server asked Forge for a draw ({@link forceDraw}), or null: told with the game's end. */
	drawnFor: DrawReason | null = null;
	/** When Forge said the game was over; null until then. */
	endedAt: number | null = null;
	/** The game this match plays: Forge's own half of the match, every seat's asks, windows and wire. */
	readonly session: ForgeSession;
	readonly seats: SeatState[];
	declare protected readonly deps: MatchDeps;

	constructor(
		id: string,
		spec: MatchSpec,
		deps: MatchDeps,
		/**
		 * From `<run>/jvm.json`, when this match is being taken back from an
		 * earlier server. The epoch and the seats' owners are exactly the two
		 * things a replay cannot reproduce and that must not change: a new epoch
		 * would make every client's cursor a stranger, and a re-seated player
		 * would be handed the other player's hand. The start time is the third:
		 * a replay would stamp it with the restart.
		 */
		restore?: { epoch: string | null; owners: (string | null)[]; startedAt: number; snapshot?: TurnSnapshot | null; checkpoint?: unknown; clockMs?: [number, number] },
	) {
		super(id, spec, deps, restore);
		this.session = new ForgeSession(id, this.epoch, spec, deps, this);
		this.seats = this.session.seats;
		this.game = this.session;
		for (const [seat, owner] of (restore?.owners ?? []).entries()) {
			const s = this.seats[seat];
			if (s !== undefined && owner !== null) s.owner = owner as ParticipantId;
		}
	}

	/**
	 * This process is stopping and this match cannot outlive it. Every seat with a
	 * board is told so in words, on the stream it already reads, and the notice is
	 * kept so a later snapshot repeats it — the same machinery a crash uses,
	 * because to the player it is the same event. Behind `GameSession.notice`
	 * (`ForgeSession.notice` is a one-line call to `endNotice`,
	 * unchanged); `RelayMatch.serverStopping` is the same hook on its own session.
	 */
	serverStopping(message: string): void {
		this.deps.log({ evt: 'match-ending-with-server', matchId: this.id, status: this.status });
		this.game.notice('server-stopping', message);
	}

	/**
	 * End the game as a draw, through Forge's own end (`GameEndReason.Draw`): the sweep's call on a
	 * game that has run `GAME_DRAWN_AFTER_MS` (`boot.ts`'s `sweepRooms`). The `gameover` line that
	 * follows ends the match as any game's end does, and tells every seat why ({@link drawnFor}).
	 * False when there is no running game to draw, or Forge was already asked.
	 */
	forceDraw(reason: DrawReason): boolean {
		if (this.status !== 'running' || this.drawnFor !== null) return false;
		this.drawnFor = reason;
		this.deps.log({ evt: 'draw-forced', matchId: this.id, reason, ranMs: this.now() - this.startedAt });
		this.session.command({ t: 'draw' });
		return true;
	}

	/** See {@link gameOutcome}. */
	outcome(): GameOutcome | null {
		return gameOutcome(this);
	}

	/** {@link MatchShell.concedeCommand}: Forge's own concede act, unchanged from before this moved behind the hook. */
	protected concedeCommand(seat: number): BridgeCommand {
		return { t: 'act', seat, frame: { kind: 'act', method: 'concede' } };
	}

	/**
	 * {@link MatchShell.forceConcede}: Forge did not confirm the concede in time, so the server ends
	 * the game itself, through the SAME `gameover` path a real one takes — unchanged from before
	 * this moved behind the hook.
	 */
	protected forceConcede(seat: number): void {
		const loser = this.seats[seat]?.playerId ?? null;
		this.onLine({
			t: 'gameover',
			winner: this.spec.seats[seat === 0 ? 1 : 0]?.name ?? null,
			...(loser === null ? {} : { losers: [loser], lost: [{ player: loser, reason: 'Conceded' }] }),
		});
	}

	protected onLine(line: BridgeLine): void {
		switch (line.t) {
			case 'gameover':
				// A game the server already ended has no result: the line was in the pipe when it stopped or failed.
				if (this.status === 'stopped' || this.status === 'failed') {
					this.deps.log({ evt: 'game-over-ignored', matchId: this.id, status: this.status, winner: line.winner });
					return;
				}
				this.status = 'over';
				this.syncClock();
				this.winner = line.winner;
				this.winnerSeat = winnerSeatFromLosers(this.seats, line.losers);
				this.endedAt = this.now();
				this.deps.log({ evt: 'game-over', matchId: this.id, winner: line.winner, losers: line.losers });
				for (const s of this.seats) {
					if (s.ai || s.playerId === null) continue;
					this.session.finishSeat(s, {
						kind: 'notify',
						method: 'finishGame',
						...(line.losers === undefined ? {} : { losers: line.losers }),
						...(line.lost === undefined ? {} : { lost: line.lost }),
						...(this.drawnFor === null ? {} : { endedBy: this.drawnFor }),
					} as ServerFrame);
				}
				this.session.logFrames();
				if (!this.replaying) this.deps.onGameOver?.();
				this.overTimer = setTimeout(() => this.host?.stop(), this.deps.overGraceMs);
				this.overTimer.unref();
				return;
			case 'fatal':
				this.fail(line.message, line.frames);
				return;
			case 'snapshot': {
				// Forge's own checkpoint, generically: `noteCheckpoint` sets `latestCheckpoint` and
				// calls `remember()` — the same hook `fixtures/toy-game/match.ts`'s `ToyMatch` calls
				// from its own `'checkpoint'` case, so a restore's `HostedMatch.restoreSpec` dispatch
				// (`match/hosted.ts`) reaches Forge too. `latestSnapshot` stays Forge's own, strongly
				// typed field (`restartState`/`restorable` read it directly); both now hold the same value.
				const snapshot: TurnSnapshot = { turn: line.turn, state: line.state, ...(line.lossy === undefined || line.lossy.length === 0 ? {} : { lossy: line.lossy }) };
				this.latestSnapshot = snapshot;
				this.deps.log({ evt: 'turn-snapshot', matchId: this.id, turn: line.turn, bytes: Buffer.byteLength(line.state), ms: line.ms });
				if (line.lossy !== undefined && line.lossy.length > 0) this.deps.log({ evt: 'snapshot-lossy', matchId: this.id, turn: line.turn, kinds: line.lossy });
				if (this.takeBackAsk?.kind === 'restart' && this.takeBackAsk.turn !== line.turn) this.closeTakeBack();
				this.tellRestart();
				this.noteCheckpoint(snapshot);
				return;
			}
			default:
				this.session.onLine(line);
		}
	}


	/* ── The game's own surface, as every importer has always called it ── */

	get art(): ArtIds {
		return this.session.art;
	}

	get invalidFrames(): number {
		return this.session.invalidFrames;
	}

	fromClient(seat: number, frame: ClientFrame, input?: number): ClientOutcome {
		return this.session.fromClient(seat, frame, input);
	}

	seatIdentities(waitingOnTold = false): SeatIdentity[] {
		return this.session.seatIdentities(waitingOnTold);
	}

	setFullControl(seat: number, on: boolean): ClientOutcome {
		return this.session.setFullControl(seat, on);
	}

	stopPolicy(seat: number): StopPolicy {
		return this.session.stopPolicy(seat);
	}

	/** The heap the game's undo history pins, in bytes (capacity's `undoMb`). */
	undoBytes(): number {
		return this.session.undoBytes();
	}

	resendAfterSnapshot(seat: number): void {
		this.session.resendAfterSnapshot(seat);
	}

	snapshot(seat: number): MatchSnapshot | { error: string } {
		return this.session.snapshot(seat);
	}

	setAutoYield(seat: number, on: boolean): ClientOutcome {
		return this.session.setAutoYield(seat, on);
	}

	setStopPolicy(seat: number, policy: StopPolicy): ClientOutcome {
		return this.session.setStopPolicy(seat, policy);
	}

	setPhaseStop(seat: number, phase: StopPhase | null): ClientOutcome {
		return this.session.setPhaseStop(seat, phase);
	}

	phaseStop(seat: number): StopPhase | null {
		return this.session.phaseStop(seat);
	}

	triggerDecisions(seat: number): RememberedTrigger[] {
		return this.session.triggerDecisions(seat);
	}

	setTriggerDecision(seat: number, key: string, decision: TriggerDecision): ClientOutcome {
		return this.session.setTriggerDecision(seat, key, decision);
	}

	fullControl(seat: number): boolean {
		return this.session.fullControl(seat);
	}

	watcherSnapshot(): MatchSnapshot | { error: string } {
		return this.session.watcherSnapshot();
	}

	seatAvatarChanged(seat: number): void {
		this.session.seatAvatarChanged(seat);
	}

	probe(seat: number, message: string, timeoutMs: number): Promise<ProbeResult> {
		return this.session.probe(seat, message, timeoutMs);
	}

	live(): TableGameLive | null {
		return this.session.live();
	}

	activeSeat(): { seat: number; playerId: number } | null {
		return this.session.activeSeat();
	}

	seatState(seat: number): { cursor: WireCursor | null; objects: ObjTable } | { error: string } {
		return this.session.seatState(seat);
	}

	offeredToOthers(seat: number, cardIds: readonly number[]): number[] {
		return this.session.offeredToOthers(seat, cardIds);
	}
}

/* ── The registry ────────────────────────────────────────────────────── */

export interface MatchRegistry {
	/**
	 * A new match, under a new id. `from`: a game resumed from a parked match's turn-start snapshot
	 * (`parked.ts`), opening on that board ({@link restoredSpec}) with its seats already held by
	 * `from.owners` and its clock where it was left.
	 */
	create(spec: MatchSpec, from?: ResumeFrom): Match;
	/** A match the registry holds: from its create until it ends ({@link MatchRegistry.find} has the rest). */
	get(id: string): Match | undefined;
	/**
	 * What the registry still knows of a match: the match while it holds it, and once it has let go of
	 * it, its {@link EndedMatch}. Let go of when it is stopped (by a stop, or past its finished game's
	 * `overGraceMs`), or `overGraceMs` after it failed — the window a failed match is still restorable
	 * in and its seats can still read why it ended. Only the most recent {@link ENDED_KEPT} are kept.
	 */
	find(id: string): Match | EndedMatch | undefined;
	/** Matches that hold a JVM: starting, running, or over-but-not-yet-stopped. */
	active(): Match[];
	stopAll(): void;
	/**
	 * Take back a match an earlier server left running (Wave 22 §E). Its JVM is
	 * still playing; the host replays its stream into the new `Match` before this
	 * returns, so the match comes back with its epoch, its seats' owners and every
	 * seat's history and cursor. Returns null when the record cannot be resumed.
	 */
	adopt(record: MatchRecord): Match | null;
	/**
	 * Start this match again on a new JVM when the one it ran on is lost: from the start of its
	 * latest turn ({@link Match.latestSnapshot}), or, when it has none yet (its JVM died before the
	 * first upkeep), as a fresh game from its own spec. Either way the match keeps its id, its seats'
	 * owners, its room settings and its start time, and gets a new epoch, so every seat's client
	 * discards what it holds and resyncs (card ids change when Forge applies a snapshot). The old
	 * match is stopped and from here on says nothing: only the registry's current match for an id
	 * reaches the seats. Returns which of the two it did, or null when there is no such match. What a
	 * restore loses: `restoredSpec`.
	 */
	restore(id: string): Restored | null;
	/**
	 * Play a bot game (`botgames.ts`) on this registry's host. It holds a place in the ceiling while
	 * it plays, counted with the matches starting or running: past `maxMatches` it is refused at once
	 * (`capacity`), never queued.
	 */
	botGame(input: BotGameInput, timeoutMs: number): Promise<BotGameOutcome>;
	/** Bot games playing now: what they hold of the ceiling. */
	botGamesPlaying(): number;
	/**
	 * SIGTERM: leave every match that holds a JVM (`active`: starting, running,
	 * or finished and inside its grace) running for the next process. Returns
	 * the matches that were handed over and the ones that could NOT be, which
	 * the caller owes an explanation (`Match.serverStopping`) and a stop.
	 */
	handOver(): { handed: Match[]; ending: Match[] };
}

export function createMatchRegistry(deps: RegistryDeps): MatchRegistry {
	const matches = new Map<string, Match>();
	/** Oldest first, so the first key is the one to evict. */
	const ended = new Map<string, EndedMatch>();
	/** Let go of a match the registry holds: it keeps only its {@link EndedMatch}. */
	const free = (m: Match): void => {
		if (matches.get(m.id) !== m) return;
		matches.delete(m.id);
		ended.delete(m.id);
		ended.set(m.id, new EndedMatch(m));
		for (const id of ended.keys()) {
			if (ended.size <= ENDED_KEPT) break;
			ended.delete(id);
		}
		deps.log({ evt: 'match-freed', matchId: m.id, status: m.status });
		deps.freed?.(m);
	};
	const active = (): Match[] => [...matches.values()].filter((m) => m.status === 'starting' || m.status === 'running' || m.status === 'over');
	let botGames = 0;
	/** A match's deps: it reaches the seats only while it is the registry's match for its id, so a restored match's old self falls silent. */
	const depsOf = (id: string, self: () => Match): MatchDeps => {
		const current = (): Match | null => {
			const m = self();
			return matches.get(id) === m ? m : null;
		};
		const when =
			<A extends unknown[]>(f: (m: Match, ...args: A) => void) =>
			(...args: A): void => {
				const m = current();
				if (m !== null) f(m, ...args);
			};
		return {
			...deps,
			// Forge's own `GameAdapter.restoreSpec` (see `restoredSpec`'s own doc): wired in here,
			// the registry's one caller, rather than left to `create`/`restore` to apply themselves.
			restoreSpec: restoredSpec,
			emit: when((m, seat: number, envelope: ServerEnvelope) => deps.emit(m, seat, envelope)),
			seatsChanged: when((m, seats: SeatIdentity[]) => deps.seatsChanged?.(m, seats)),
			phaseStopChanged: when((m, seat: number, phase: StopPhase | null) => deps.phaseStopChanged?.(m, seat, phase)),
			restartChanged: when((m, state: RestartState) => deps.restartChanged?.(m, state)),
			restartTurn: when(() => {
				registry.restore(id);
			}),
			onGameOver: when((m) => deps.onGameOver?.(m)),
			liveChanged: when((m) => deps.liveChanged?.(m)),
			abandoned: when((m) => deps.abandoned?.(m)),
			// A failed match stays restorable, and its seats can still read why, for the grace a finished one keeps its board.
			ended: when((m) => {
				if (m.status !== 'failed') {
					free(m);
					return;
				}
				setTimeout(() => free(m), deps.overGraceMs).unref();
			}),
		};
	};
	const registry: MatchRegistry = {
		create(spec, from) {
			const id = newMatchId();
			// `spec` goes through UNCHANGED: with `from` given, `restore.checkpoint` below is `HostedMatch`'s
			// own constructor's cue to run it through `deps.restoreSpec` (`restoredSpec`, wired in above) —
			// the one path `restoredSpec`'s own doc describes, not a second transform made here.
			const match: Match = new Match(
				id,
				spec,
				depsOf(id, () => match),
				from === undefined
					? undefined
					: { epoch: null, owners: [...from.owners], startedAt: (deps.now ?? Date.now)(), snapshot: from.snapshot, checkpoint: from.snapshot, ...(from.clockMs === undefined ? {} : { clockMs: from.clockMs }) },
			);
			matches.set(id, match);
			ended.delete(id);
			match.start();
			return match;
		},
		get: (id) => matches.get(id),
		find: (id) => matches.get(id) ?? ended.get(id),
		active,
		stopAll() {
			for (const m of matches.values()) m.stop();
		},
		botGame(input, timeoutMs) {
			const max = deps.maxMatches ?? MAX_CONCURRENT_MATCHES;
			const playing = active().filter((m) => m.status === 'starting' || m.status === 'running').length + botGames;
			if (playing >= max) return Promise.resolve({ ok: false, why: 'capacity', error: `the server is already running ${max} matches` });
			botGames += 1;
			return runBotGame(deps.host, `b-${randomBytes(6).toString('hex')}`, input, { timeoutMs, log: deps.log }).finally(() => {
				botGames -= 1;
			});
		},
		botGamesPlaying: () => botGames,
		adopt(record) {
			const attach = deps.attach;
			// A bot game is never a match (`play/botgames.ts`): left for the host to stop, and played again by its room.
			if (attach === undefined || record.spec.headless !== undefined) return null;
			const match: Match = new Match(record.matchId, record.spec, depsOf(record.matchId, () => match), {
				epoch: record.epoch,
				owners: record.owners,
				startedAt: Date.parse(record.startedAt),
				snapshot: record.snapshot ?? null,
				...(record.clockMs === undefined ? {} : { clockMs: record.clockMs }),
			});
			matches.set(record.matchId, match);
			ended.delete(record.matchId);
			match.resume((events) => attach(record, events));
			return match;
		},
		restore(id) {
			const old = matches.get(id);
			if (old === undefined) return null;
			const snapshot = old.latestSnapshot;
			const now = (deps.now ?? Date.now)();
			// `old.spec` goes through UNCHANGED, same as `create` above: `checkpoint` (when there is a
			// snapshot to restore from) is `HostedMatch`'s own cue to run it through `restoredSpec` itself.
			const match: Match = new Match(id, old.spec, depsOf(id, () => match), {
				// Never the old epoch's spelling, `${id}:${startedAt}`, even within its millisecond.
				epoch: `${id}:${now}:${randomBytes(4).toString('hex')}`,
				owners: old.owners(),
				startedAt: old.startedAt,
				snapshot,
				...(snapshot === null ? {} : { checkpoint: snapshot }),
				...(() => {
					const clockMs = old.clockLeft();
					return clockMs === null ? {} : { clockMs };
				})(),
			});
			matches.set(id, match);
			if (snapshot !== null) match.session.inheritKnowledge(old.session);
			old.stop();
			for (const s of old.seats) {
				const to = match.seats[s.seat];
				if (to === undefined) continue;
				to.fullControl = s.fullControl;
				to.policy = s.policy;
				// Both name turns: they mean the same turns only in a game that resumes at one.
				if (snapshot !== null) {
					to.autoYield = s.autoYield;
					to.phaseStop = s.phaseStop;
				} else if (s.phaseStop?.skipTurn === null) {
					to.phaseStop = s.phaseStop;
				}
				if (s.here) match.seatConnected(s.seat);
			}
			deps.log({
				evt: 'match-restored',
				matchId: id,
				from: snapshot === null ? 'spec' : 'snapshot',
				...(snapshot === null ? {} : { turn: snapshot.turn }),
				fromEpoch: old.epoch,
				epoch: match.epoch,
				oldStatus: old.status,
			});
			match.start();
			return snapshot === null ? { match, from: 'spec' } : { match, from: 'snapshot', turn: snapshot.turn };
		},
		handOver() {
			const handed: Match[] = [];
			const ending: Match[] = [];
			for (const m of active()) (m.handOver() ? handed : ending).push(m);
			return { handed, ending };
		},
	};
	return registry;
}

