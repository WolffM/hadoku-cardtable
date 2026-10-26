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
 * `host.ts`, "A match outlives its server") and this file is the half that
 * rebuilds the match around it.
 *
 * - **Going down**: `handOver` lets go of the JVM without killing it and emits
 *   NOTHING. A frame sent on the way out would take a `seq` the next server's
 *   replay cannot reproduce. A match that cannot be handed over gets
 *   `serverStopping` instead, which tells its seats in words.
 * - **Coming back**: `resume` is `start`'s twin. The host replays every line
 *   the dead server read — synchronously, before the first live line — so each
 *   seat's projector, history, `seq`, prompt, buttons and open asks rebuild
 *   themselves from exactly the input that built them the first time. Two
 *   things a replay cannot reproduce come off disk instead: the **epoch** (a
 *   new one would make every client's cursor a stranger) and the seats'
 *   **owners** (a re-seated player would be handed the other player's hand).
 * - **Commands are not replayed outward.** `replaying` gags `command`: every
 *   reply, abort, auto-pass and auto-payment in the stream was already sent by
 *   the server that read it. The two that CLOSE an ask are fed back in through
 *   `onReplayedCommand`, because nothing the bridge says records that an ask
 *   was answered — without it a seat would be re-shown a modal it had
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
import { isDurableParticipantId, type ParticipantId } from '@wolffm/rooms-protocol';
import {
	isBlocking,
	isTierC,
	safeParseServerFrame,
	type ChoiceOption,
	type ClientFrame,
	type GameLogLine,
	type PhaseType,
	type ServerFrame,
	type TriggerDecision,
	YIELDING,
	currentFace,
	deltaKey,
	DELTA_TYPE,
	idsOf,
	intOf,
	strOf,
} from '@hadoku/forge-wire';
import {
	selfAnswer,
	stopAt,
	stopCovers,
	type RememberedTrigger,
	type StopPhase,
	type MatchSnapshot,
	type SeatIdentity,
	type ServerEnvelope,
	type TableGameLive,
	type WireCursor,
} from '@hadoku/shared';

import {
	chosenCostConfirm,
	decideCancel,
	decidePay,
	DEFAULT_STOP_POLICY,
	forcedSet,
	freeSearchConfirm,
	FULL_CONTROL_POLICY,
	judgeStop,
	ONLY_SACRIFICE,
	onlyAnswer,
	onlySacrifice,
	owing,
	PAY_MANA,
	paymentCost,
	PRIORITY,
	readPromptFacts,
	repeatedAbilityToPlay,
	type Owed,
	type Payment,
	type PromptFacts,
	type SeatNotes,
	type StopJudgement,
	type StopPolicy,
	type StopWindow,
} from './auto.js';
import { CONFIG } from '../config.js';
import { answerPending, arrangeAsk, digAnswer, digAsk, exileOrder, pendingOrders, restOrder, sameCardsOrder } from './arrange.js';
import { eachTypeAsk, firstEachType, nextEachType } from './each-type.js';
import { firstMode, modesAsk, nextMode } from './modes.js';
import { chosenTargetConfirm, pickedBy, sameTargetAct, targetAbilityOf, type SameTarget } from './trigger-targets.js';
import { artOf } from './art.js';
import { fallbackFor, type Fallback } from './unparsed.js';
import type { BridgeCommand, BridgeLine, HostEvents, JvmRecord, MatchHost, MatchHostFactory, MatchSpec } from './host.js';
import type { StartEvents } from './start-queue.js';
import { faceNames, namesForFormat } from './names.js';
import type { SpellCopy } from './spell-copiers.js';

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
};

/** `MatchSpec`, with both seats widened the same way. */
export type MatchSpecWithIdentity = Omit<MatchSpec, 'seats'> & {
	seats: [SeatSpecWithIdentity, SeatSpecWithIdentity];
};

import {
	createProjector,
	foldFrames,
	type ObjTable,
	type SeatProjector,
	type StateFrame,
	type WireObj,
} from './visibility.js';

/** Trace every stop decision (`stop-decided`) — probe mode only, see `maybeAutoPass`. */
const TRACE_STOPS = CONFIG.playProbe;

/**
 * Trace every frame Forge sends (`forge-frame`), every command sent to Forge (`forge-command`) and
 * every frame put on a seat's wire (`wire-frame`) — probe mode only. Each log line carries the ms
 * `t` of its own write, so a gap between a cast and its landing reads straight off the log
 * (w67-shaman: "2 s of lag" had no row to put a number on).
 */
const TRACE_FRAMES = CONFIG.playProbe;

/** The few fields of a frame that name it in a trace row. */
export function frameGist(frame: unknown): Record<string, unknown> {
	const f = (frame ?? {}) as Record<string, unknown>;
	const gist: Record<string, unknown> = { method: f.method, kind: f.kind };
	if (typeof f.callId === 'string') gist.callId = f.callId;
	if (typeof f.message === 'string') gist.message = f.message.slice(0, 120);
	if (f.method === 'updateButtons') gist.bar = [f.label1, f.enable1, f.label2, f.enable2];
	const card = f.card as { id?: unknown } | null | undefined;
	if (typeof card?.id === 'number') gist.card = card.id;
	return gist;
}

/**
 * What an ask is about, for its `ask-forwarded` and `ask-answered` lines: the card Forge raised it
 * for (`source`, the bridge's `askSource`) and the words it was asked in (`title`, whichever of
 * `title` / `message` / `question` the method has). So "which ask was Cavern's" reads off the log.
 */
function askGist(frame: ServerFrame): { source?: number; title?: string } {
	if (frame.kind !== 'ask') return {};
	const f = frame as unknown as Record<string, unknown>;
	const words = [f.title, f.message, f.question].find((w): w is string => typeof w === 'string' && w !== '');
	return {
		...(frame.source === undefined ? {} : { source: frame.source.card.id }),
		...(words === undefined ? {} : { title: words.slice(0, 120) }),
	};
}

export type MatchStatus = 'starting' | 'running' | 'over' | 'failed' | 'stopped';

/**
 * How a game ended. A game is finished only when Forge called it — a victory
 * and a defeat (an explicit concede is a defeat), or a draw by the rules. A
 * game the server ended any other way (nobody came back, the room closed, the
 * JVM died, the server stopped) has no outcome at all: no report, and no game
 * in its table's series.
 */
export type GameOutcome =
	| { kind: 'won'; winner: 0 | 1; conceded: boolean }
	| { kind: 'drawn' }
	/** Forge named a winner that no seat can be told from. */
	| { kind: 'unplaced' };

/** What {@link gameOutcome} reads off a match. */
export interface OutcomeFacts {
	endedAt: number | null;
	winner: string | null;
	winnerSeat: 0 | 1 | null;
	concededBy: number | null;
	spec: { seats: readonly { name: string }[] };
}

/**
 * The ONE place a game's outcome is classified; every reader of a result (the
 * stats report, the table's series) asks this. Null when the game did not
 * finish. The winner is the seat that did not concede, else the seat Forge's
 * own losers leave standing ({@link winnerSeatFromLosers}), else the seat whose
 * name — the name Forge was given, unique within the match — Forge named.
 */
export function gameOutcome(match: OutcomeFacts): GameOutcome | null {
	if (match.endedAt === null) return null;
	if (match.concededBy === 0 || match.concededBy === 1) return { kind: 'won', winner: match.concededBy === 0 ? 1 : 0, conceded: true };
	// Forge names no winner only for a draw (`GameOutcome.getWinningLobbyPlayer`).
	if (match.winner === null) return { kind: 'drawn' };
	if (match.winnerSeat !== null) return { kind: 'won', winner: match.winnerSeat, conceded: false };
	const named = match.spec.seats.findIndex((s) => s.name === match.winner);
	return named === 0 || named === 1 ? { kind: 'won', winner: named, conceded: false } : { kind: 'unplaced' };
}

export interface OpenAsk {
	callId: string;
	method: string;
	frame: ServerFrame;
	sentAt: number;
}

/**
 * Which of two seats won, from Forge's `losers` (player ids): a seat whose
 * player id is among them lost, so the other won; with only one seat's id
 * known (an AI game — the AI never opens a view), that seat won exactly when
 * somebody lost and it was not that seat. Null for anything else: no losers,
 * both or neither known seat lost, or more than two seats.
 */
export function winnerSeatFromLosers(seats: readonly { seat: number; playerId: number | null }[], losers: readonly number[] | undefined): 0 | 1 | null {
	if (losers === undefined || losers.length === 0 || seats.length !== 2) return null;
	const known = seats.filter((s) => s.playerId !== null);
	const lost = known.filter((s) => losers.includes(s.playerId!));
	const other = (seat: number): 0 | 1 | null => (seat === 0 ? 1 : seat === 1 ? 0 : null);
	if (known.length === 2) return lost.length === 1 ? other(lost[0]!.seat) : null;
	if (known.length === 1) {
		const only = known[0]!.seat;
		return lost.length === 1 ? other(only) : only === 0 || only === 1 ? only : null;
	}
	return null;
}

export interface SeatState {
	seat: number;
	ai: boolean;
	/** Bound on first claim, never changed. */
	owner: ParticipantId | null;
	/** From this seat's `openView`. Null until Forge has opened the game. */
	playerId: number | null;
	/** See {@link SeatSpecWithIdentity.displayName}. */
	displayName?: string;
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
	/**
	 * The prompt frame this seat's stop was last PASSED on — a prompt earns one press.
	 *
	 * Wave 32, Q12. Forge's inputs do not agree on the order they say things in: a
	 * priority window sends the prompt and then its buttons, but `InputBlock` (and
	 * the payment input, which `maybeAutoPay` already knew) sends its BUTTONS first
	 * and its prompt after. A pass decided on the buttons alone therefore read the
	 * PREVIOUS window's prompt — the seat's last `Priority: … Declare Attackers
	 * Step`, which had already been passed — found a phase nobody asked to stop in,
	 * and pressed OK a second time, on the block input that had just opened. The
	 * block input ended in under 10 ms, the seat was never offered its creatures, and
	 * the log said `auto-passed` for a phase it was not in. That is the operator's
	 * *"i was not able to assign blockers at all"*, reproduced against a real Forge in
	 * `blockers.jvm.test.ts`.
	 *
	 * So a prompt that has been passed on is not passed on again: the second press
	 * would answer whatever Forge asks NEXT. Compared by frame identity — Forge
	 * re-sending the same words is a new frame and a new window, and is decided afresh.
	 */
	passedOn: ServerFrame | null;
	deck: string | null;
	/**
	 * Every end-of-game notice this seat has been told, in resend order — the
	 * ONE latch for both kinds: each is sent at most once per seat and resent
	 * after every later snapshot.
	 *
	 *  - `'finished'` is the game being over (`finishGame`, with who lost), told
	 *    to every seat the moment the bridge's `gameover` line arrives
	 *    ({@link Match.finishSeat}). Neither the view's `GameOver` property nor
	 *    Forge's own `finishGame()` call is certain to reach a seat: both need
	 *    Forge to flush to it after the end (2026-10-08, runs 37818461156; and
	 *    2026-10-13, a concede during the deal that sent neither to the winner).
	 *  - `'ended'` is the notice fabricated when the MATCH failed (`endNotice`),
	 *    sent and recorded at most once per seat.
	 *
	 * `resendAfterSnapshot` sends `'finished'` before `'ended'` when both are
	 * present, same order the two separate fields were always sent in.
	 */
	endNotices: { kind: 'finished' | 'ended'; frame: ServerFrame }[];
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

	/* ── Wave 19 lane C: questions with one answer, stops with nothing to do ── */

	/**
	 * The escape hatch, off by default. While it is on, this seat stops at every
	 * window and makes every real choice itself — because the one thing worse
	 * than a stop you did not want is a stop you did not get. A question with one
	 * answer is not a choice, and is answered as it is without it.
	 */
	fullControl: boolean;
	/**
	 * The other seat's-turn twin of {@link fullControl}: while `on` and `turn`
	 * still equals `s.projector.turnNumber()`, `maybeAutoPass` passes every
	 * priority window that is NOT this seat's own turn. Null is "never
	 * toggled"; `setAutoYield(seat, false)` leaves `{ turn, on: false }`
	 * rather than null, which reads the same way. It outranks
	 * {@link fullControl}: pressed, it is the seat's own word for this turn.
	 */
	autoYield: { turn: number; on: boolean } | null;
	/**
	 * The seat's one-shot stop ({@link Match.setPhaseStop}): its priority is held
	 * at the next occurrence of `phase`, on either player's turn, in the step
	 * `stopStep` names for that turn. `skipTurn` is the turn whose occurrence does
	 * not count — the stop was set while the game was already in it, so it is for
	 * the next one. Null is no stop.
	 */
	phaseStop: { phase: StopPhase; skipTurn: number | null } | null;
	/**
	 * The step occurrence a stop fired in: every priority window of the seat in
	 * it is kept, as full control would keep it, until the game leaves it.
	 */
	stopHeld: { turn: number | null; phase: PhaseType } | null;
	/**
	 * The optional triggers this seat told Forge to answer itself ("Always" on
	 * the trigger's confirm), by Forge's storage key, oldest first. Forge holds
	 * the decision; this is the list the seat's settings draw and clear.
	 */
	triggerDecisions: Map<string, RememberedTrigger>;
	/**
	 * This seat's stop preferences — **one policy per seat, not one per server**
	 * (wave 26 §E).
	 *
	 * Every shortcut decision for this seat is asked of THIS value: `onlyAnswer`,
	 * `decideStop`, `decidePay` and `decideCancel` each take a `StopPolicy` and
	 * each got `auto.ts`'s module default until now. It starts as
	 * `DEFAULT_STOP_POLICY` and {@link Match.setStopPolicy} moves it, so one seat
	 * can be strict about payments while the other takes Forge's Auto — which is
	 * what `board-play.jvm.test.ts` needs to prove that clicking a land pays for a
	 * spell, and what a player's own preference screen will set later.
	 *
	 * {@link SeatState.fullControl} is NOT this: it short-circuits ahead of the
	 * policy, so the escape hatch cannot be lost to a policy value.
	 */
	policy: StopPolicy;
	/** Forge's latest actionable set for this seat; null when it has not said (`auto.ts`). */
	actionable: number[] | null;
	/**
	 * The input Forge currently has open for this seat, as Forge last said it —
	 * kept so a reload can be told again (wave 31 §S, P10). The state channel
	 * carries none of these and a reload's snapshot starts from nothing, so a
	 * decision that IS a selection (the London bottom pick, a target, a payment)
	 * was dead after a refresh with Forge still waiting.
	 *
	 *  - `selection`: the last `setSelectables`, until `clearSelectables`.
	 *  - `highlighted`: the folded `setHighlighted` marks (incremental and
	 *    signed on the wire), until `clearSelectables`.
	 *  - `weakly`: the last `setWeaklySelectable`, until `clearWeaklySelectable`.
	 */
	selection: ServerFrame | null;
	highlighted: Map<string, unknown>;
	weakly: ServerFrame | null;
	/**
	 * A `setSelectables` with no choice in it (`auto.ts`'s `forcedSet`), held off the seat's wire
	 * until the prompt after it says whether it is a sacrifice the server takes itself
	 * ({@link Match.maybeOnlySacrifice}), and sent on ahead of that prompt otherwise; null when none is.
	 */
	heldSacrifice: ServerFrame | null;
	/** The server just took a sacrifice for this seat: the bar Forge sends with that pick's prompt is not the seat's. */
	pickedSacrifice: boolean;
	/** The payment being made, while its prompt is up. */
	payment: Payment | null;
	/**
	 * The cost this seat's Auto was already pressed for. Forge re-sends the
	 * payment prompt after every tap, and a second press would answer whatever
	 * it asks next; one press per cost is all `maybeAutoPay` ever earns.
	 */
	autoPaid: string | null;
	/**
	 * The cost this seat's Cancel was already pressed for (item 7). One press per
	 * cost, for the same reason {@link SeatState.autoPaid} exists: Forge answers
	 * the press by ending the input, and a second one would answer the next.
	 */
	autoCancelled: string | null;
	/** How many asks were answered for this seat, and how many stops passed. */
	autoAnswered: number;
	autoPassed: number;
	/**
	 * Why {@link Match.maybeAutoPass} last kept or passed this seat's window: a
	 * `judgeStop` rule, or the gate in front of it (`stop-at` — the seat's own
	 * one-shot stop; `auto-yield`; `passed-on`; `gated` — full control, an AI, a
	 * match not running). The `rule` on the `prompt-forwarded` log line.
	 */
	lastStop: Pick<StopJudgement, 'rule' | 'plays'> | { rule: 'stop-at' | 'auto-yield' | 'passed-on' | 'gated' } | null;
	/** Times this seat pressed Mulligan on the opening Keep/Mulligan bar — read by the match stats. */
	mulligans: number;
	/**
	 * The `message` lines this seat was sent — Forge's game log as this seat may
	 * read it ({@link Match.onGameLog}), and whether full control is on. Re-sent
	 * after a snapshot so a refresh does not lose the game's record.
	 */
	says: ServerFrame[];
	/**
	 * Lines of Forge's game log waiting for this seat's board to show the cards
	 * they name ({@link Match.onGameLog}), oldest first, and the timer that sends
	 * them anyway ({@link LOG_HOLD_MAX_MS}).
	 */
	heldLog: { text: string; log: GameLogLine }[];
	heldLogTimer: NodeJS.Timeout | null;
	/**
	 * Wave 34 §S4 — the host card + ability id of the last `getAbilityToPlay`
	 * this seat was actually given an answer for, whether the browser answered
	 * it or {@link onFrame}'s own repeat-collapse did.
	 *
	 * Forge's own engine asks `getAbilityToPlay` TWICE (sometimes more) for one
	 * real decision: once from whatever `Input` read the click
	 * (`InputPassPriority.onCardSelected`, or `InputPayMana`'s mana-ability
	 * path), and again, unconditionally, from forge-game's `PlaySpellAbility.
	 * chooseOptionalAdditionalCosts` — which calls `getAbilityToPlay` a SECOND
	 * time with a singleton list holding the exact ability already chosen, to
	 * cover an "alternate additional cost" keyword almost no card has. Measured
	 * against a real jar for a spell cast, an AI's own cast, and a land's mana
	 * ability alike — never fewer than two rounds, sometimes three, always with
	 * NO client act in between the rounds. See
	 * `docs/planning/wave34-evidence/s4-repeated-ask.md`.
	 *
	 * Tracked here so a repeat round that offers the SAME single ability this
	 * seat was just given an answer for can be answered the same way without a
	 * second click — regardless of full control, because it is not a second
	 * decision, it is Forge re-asking the first one. `null` until the first
	 * `getAbilityToPlay` of the match is answered, and overwritten by every one
	 * after — a stale match is harmless: the ability id only ever repeats for
	 * the SAME physical card object while it is still being cast, and a
	 * genuinely new ask for that id, later, having survived every other ask and
	 * act in between, offers no different an answer than the one already given.
	 */
	lastAbilityToPlay: { hostCard: number; abilityId: number } | null;
	/**
	 * The ability this seat chose from `getAbilityToPlay` since its last
	 * `Priority:` prompt, or null — the seat's own answer (its browser's), never
	 * one the server gave for it. A cost confirm for exactly this ability is
	 * answered Yes (`auto.ts`'s `chosenCostConfirm`), once per confirm, and a payment for its
	 * card is the seat's own (`Payment.own`) and may be auto-paid; a priority
	 * prompt means the activation is over, so it is cleared there.
	 */
	chosenAbility: { hostCard: number; abilityId: number } | null;
	/**
	 * The cost confirms already answered Yes for {@link chosenAbility}, by their question: a cost
	 * with two parts asks twice (Lion's Eye Diamond: discard your hand, then sacrifice it), and
	 * the same question shown again before Forge took the Yes is that one window, never pressed twice.
	 */
	confirmedCosts: Set<string>;
	/**
	 * The seat's "same target for all" (`./trigger-targets.ts`): the following target
	 * selections of the same trigger are answered with it, until the next `Priority:` prompt.
	 */
	sameTarget: SameTarget | null;
	/** The abilities whose targets this seat chose, so their "Do you want to …?" on resolution is answered Yes, once. */
	chosenTargets: Set<number>;
	/**
	 * The card this seat last clicked (`selectCard`), until the next
	 * `getAbilityToPlay` it receives. A one-ability offer for exactly this card
	 * is the click's own and goes to the browser, which says what was played; any
	 * other (a trigger, an effect casting a card) is answered here
	 * ({@link Match.openAsk}). A click that picks from an open selection is not
	 * kept: Thopter Foundry's sacrifice of Sword of the Meek is a click on the
	 * Sword, and the Sword's own trigger that follows went to the browser, where
	 * it waited behind the pacer's beats, 2.5 s a loop (match m-22c72c4dd6cd).
	 */
	clicked: number | null;
	/**
	 * Wave 35 §S, R4 — a REVEAL ({@link asReveal}) held back to
	 * see whether the very next ask to this seat is the real discard choice it
	 * belongs to (Thoughtseize's "look at hand" step). See
	 * {@link Match.onFrame}'s own header on the fold. Shown as a notice
	 * ({@link Match.showReveal}) if nothing claims it within
	 * {@link PENDING_REVEAL_FOLD_MS}.
	 */
	pendingReveal: { frame: RevealFrame; timer: NodeJS.Timeout } | null;
	/**
	 * Every frame but an ask Forge sent while {@link pendingReveal} was held, raw and in order: what
	 * the reveal's resolution did — its state, its log lines, the next bar — comes AFTER the reveal on
	 * the seat's screen, as it did in Forge. Handled the moment the reveal is shown or folded
	 * ({@link Match.releaseReveal}) — at most `PENDING_REVEAL_FOLD_MS` late. Without it, Sorin, Grim
	 * Nemesis's +1 drew bob's life loss before the card that caused it.
	 */
	behindReveal: unknown[];
	/**
	 * Synthetic asks this seat currently holds, keyed by the SYNTHETIC callId
	 * (`chooseSingleEntityForEffect`'s own) — each maps back to the TWO real
	 * Forge `getChoices` asks (the reveal, always answered `[]`, and the real
	 * choice) a single browser reply must resolve. See {@link Match.onFrame}.
	 */
	mergedChoice: Map<string, { chooseCallId: string; keyByRef: Map<string, string> }>;
	/**
	 * What a one-prompt reply still owes Forge's later questions — a scry's, surveil's or dig's
	 * groups (`./arrange.ts`), a modal spell's modes (`./modes.ts`), a per-type pick's cards (`./each-type.ts`). Cleared by the first ask it does not answer.
	 */
	owed: Owed | null;
	/**
	 * Forge's question behind an ask shown as one `order`, by callId: a `Dig`'s (`./arrange.ts`'s
	 * `digAsk`) or a per-type pick's first type question (`./each-type.ts`'s `eachTypeAsk`).
	 */
	folds: Map<string, Extract<ServerFrame, { kind: 'ask'; method: 'chooseEntitiesForEffect' | 'getChoices' }>>;
	/**
	 * Half of a window a decider can answer, held until the other half
	 * arrives so the window is decided before either reaches the wire. A
	 * `Priority:` prompt waits here for the bar after it; a payment's `Auto`
	 * bar or a confirm's Yes/No bar waits for the prompt after it. See
	 * {@link Match.holdPromptWindow}.
	 */
	pendingPrompt: PromptFrame | null;
	pendingButtons: ButtonsFrame | null;
	pendingTimer: NodeJS.Timeout | null;
	/**
	 * Whether the LAST `updateButtons` actually sent to this seat's wire left
	 * either button enabled — see {@link Match.send}. Read by
	 * {@link Match.decideWindow}: a withheld window whose predecessor
	 * left a live button on the seat's screen gets a disabled correction (the
	 * design the Settled text asked for); one that didn't gets nothing, which
	 * is what the declare-attackers fix needs (a disabled `updateButtons`
	 * still flips the browser's `inputLive` and lights `attackDefenders` for
	 * an instant).
	 */
	wireButtonsLive: boolean;
	/**
	 * The window the server last answered for this seat, until Forge sends
	 * anything but a window's prompt, bar or offered set. Forge can show
	 * the same input twice in a row before the answer reaches it (measured:
	 * "Sacrifice Augur of Skulls?" and its Yes/No bar, twice, 1 ms apart; a
	 * payment's set, Auto bar and prompt 14 ms after its Auto); the second copy
	 * is that same window, withheld without a second press.
	 */
	answeredWindow: string | null;
	/** Unparsed asks shown as a pick of their whole answers, by callId (`unparsed.ts`). */
	unparsed: Map<string, Fallback>;
	/** Every ask callId Forge has sent this seat, so a re-sent ask ({@link Match.armActWatch}) is handled once. */
	seenAsks: Set<string>;
	/** Armed by an input act or an ask answered under a disabled bar, disarmed by any frame for this seat; see {@link Match.armActWatch}. */
	actWatch: NodeJS.Timeout | null;
	/** The card of a `selectCard` the act watch is still out on, and when it went to Forge; logged as `click` when the watch ends ({@link Match.endClick}). */
	click: { card: number; at: number } | null;
	/** The offered set last logged for a forwarded window (`offered`), so an unchanged set is not logged again. */
	offeredLogged: string | null;
	/**
	 * The live bar {@link Match.disableStaleButtons} took off this seat's screen, until Forge
	 * shows the seat anything (`showPromptMessage`, `updateButtons`, `setSelectables`). Forge
	 * does not always answer an act: a "which ability?" picker answered None, or with an ability
	 * Forge then declines to play, leaves the same `InputPassPriority` standing and sends
	 * nothing (`InputPassPriority.onCardSelected` returns without `stop()`). This is that
	 * input's own bar, and {@link Match.resendWindow} puts it back.
	 */
	staleBar: ButtonsFrame | null;
}

/** Who `MatchDeps.seatAvatar` is asked about for Forge's AI seat, which nobody holds. */
export const AI_SEAT_OWNER = 'ai';

export interface MatchDeps {
	host: MatchHostFactory;
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
	log(entry: Record<string, unknown>): void;
	/** How long a finished match keeps its JVM (and answers resyncs) before stopping. */
	overGraceMs: number;
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
	now?: () => number;
}

/**
 * How long an input act may go with nothing at all back for its seat before
 * the server asks the bridge to re-send that seat's pending asks
 * ({@link Match.armActWatch}). Forge's act gate holds a click made between two
 * inputs for 5 s before it lets it go, so a held-then-delivered click answers
 * well inside this; a click that gets nothing in twice that long is a click
 * queued behind a game thread parked on a question.
 */
export const ACT_SILENCE_MS = 10_000;

/**
 * How long an ask answered under a disabled bar ({@link SeatState.staleBar}) may go with no
 * window back before the server re-sends the seat's own live window. Forge answers a picked
 * ability within milliseconds (a payment, a target, the next priority bar); silence this long
 * is Forge keeping the input it already showed.
 */
export const ANSWER_SILENCE_MS = 1_500;

/**
 * The asks an abort may close: for these the bridge answers Forge with the
 * ask's own default, never a null (`PlayBridge.java`'s `showConfirmDialog`
 * :1407, `showOptionDialog` :1421, `confirm` :1448). Every other ask returns
 * null on an abort, and a null is an answer many Forge effects do not check.
 */
const ABORT_SAFE: ReadonlySet<string> = new Set(['showConfirmDialog', 'showOptionDialog', 'confirm']);

/**
 * The acts that are a game input — a click Forge's game thread must take and
 * answer with something. A yield preference, a concede and a resync are not.
 */
/**
 * A bridge frame that tells the seat what it may do next — an ask, a prompt,
 * a bar or a selection — as opposed to state that changed on the way there.
 */
function answersAnInput(frame: unknown): boolean {
	const f = frame as { kind?: unknown; method?: unknown } | null;
	return f?.kind === 'ask' || f?.method === 'showPromptMessage' || f?.method === 'updateButtons' || f?.method === 'setSelectables';
}

/** Forge showing a seat its input — what ends {@link SeatState.staleBar}. An ask does not: answering it can still leave Forge silent. */
function showsAWindow(frame: unknown): boolean {
	const f = frame as { kind?: unknown; method?: unknown } | null;
	return f?.kind === 'notify' && (f.method === 'showPromptMessage' || f.method === 'updateButtons' || f.method === 'setSelectables');
}

type ActFrame = Extract<ClientFrame, { kind: 'act' }>;

const INPUT_ACTS: ReadonlySet<string> = new Set(['selectButtonOk', 'selectButtonCancel', 'selectCard', 'selectPlayer', 'selectAbility', 'useMana']);

/** The act as Forge takes it: `sameTarget` is the server's own (`./trigger-targets.ts`), never Forge's. */
function forgeAct(frame: ActFrame): ActFrame {
	if ((frame.method !== 'selectPlayer' && frame.method !== 'selectCard') || frame.sameTarget === undefined) return frame;
	const { sameTarget: _sameTarget, ...rest } = frame;
	return rest;
}

/** What a seat is shown when its match fails. Title and wording are ours; the frame is forge-wire's. */
export const MATCH_ENDED_TITLE = 'Match ended';

/**
 * The "seat" the watcher channel is emitted on (2026-10-12, the party request
 * in `docs/requests/WATCHPARTY_SEATS_AND_SPECTATORS.md`). Not a seat: nobody
 * holds it, nothing is read from it, and `fromClient` and every other
 * seat-taking method refuse it as `no-such-seat`. It exists so the one
 * `emit(seat, envelope)` dependency can carry the shared public projection to
 * every socket that joined with no seat of its own, and `SKIP` the rest.
 */
export const WATCHER_SEAT = -1;

/**
 * How many `message` lines a seat keeps for a re-send after a snapshot.
 *
 * This used to be 8 — a few turns at most — so a reconnect mid-game refilled
 * only the tail. Raised to the whole game with a generous cap, rather than
 * removed outright, so a pathological match cannot grow this array without
 * bound.
 */
const SAYS_KEPT = 2000;

/**
 * The longest a game log line waits for the delta that shows its cards
 * ({@link Match.onGameLog}). The wait is about order, not secrecy — the bridge
 * already decided the seat may read the line — so a line whose card never
 * becomes visible on this seat's board still goes, this late.
 */
const LOG_HOLD_MAX_MS = 1000;

/**
 * The name this seat is entitled to see for a card, off its own projected
 * state — never off the raw stream. A card the projection hid has no name here,
 * and the id it falls back to is the one the seat already holds.
 */
function cardName(state: ReadonlyMap<string, WireObj>, id: number): string | null {
	const view = state.get(deltaKey(DELTA_TYPE.card, id));
	if (view === undefined) return null;
	for (const obj of [currentFace(state, id), view]) {
		const name = strOf(obj, 'Name');
		if (name !== null && name !== '') return name;
	}
	return null;
}

/**
 * The id of the card at the TOP of `Game.Stack`, or null with nothing on it.
 * {@link Match.waitingOnFor}'s own fallback: a `showPromptMessage`
 * carries no `card` for an ordinary priority prompt — including the one-shot
 * "Priority: … Stack: 1 to Resolve." window Forge gives the CASTER before
 * their own spell resolves — so a selection or an ask that opens mid-resolution
 * (Thirst for Knowledge's own discard, confirmed against the real jar: a
 * `setSelectables`, not an ask with a card) has no fresher signal to read.
 * `Game.Stack` lists top-first (reversing it
 * gives arrival order), so index 0 is the top.
 */
function stackTopHostCardId(state: ReadonlyMap<string, WireObj>): number | null {
	const top = idsOf(state.get(deltaKey(DELTA_TYPE.game, 1)), 'Stack')[0];
	return top === undefined ? null : intOf(state.get(deltaKey(DELTA_TYPE.stackItem, top)), 'SourceCard');
}

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

/* ── Wave 35 §S, R4: "Thoughtseize is one step" ───────────────────────────
 *
 * `DiscardEffect`'s `RevealYouChoose` mode (Thoughtseize, and any card shaped
 * like it) resolves in THREE Forge asks, confirmed against a real jar
 * (`scenario-thoughtseize.jvm.test.ts`, `wave35-evidence/s3-thoughtseize.md`):
 *
 *   1. `getChoices(message, -1, -1, wholeHand)` to the CASTER — a REVEAL
 *      (Forge's own encoding of "nothing to choose, just look": `rules.ts`'s
 *      `choiceBounds` reads the same `max <= 0` convention this file's
 *      `onlyAnswer` already does for the identical case).
 *   2. `getChoices(message, min, max, validOnly)` to the CASTER — the real
 *      choice, already correctly excluding lands (`DiscardValid$ Card.nonLand`
 *      is Forge's own filter, not ours).
 *   3. `getChoices(message, -1, -1, [theOneCardTaken])` to the DISCARDER — a
 *      second REVEAL, this time of just what was chosen, with no decision at
 *      all.
 *
 * The operator's ruling (2026-10-02): fold 1 into 2 — the caster gets ONE
 * choice showing the whole hand with the unchoosable cards greyed, the
 * "Rampant Growth shape" `apps/ui/src/play/prompts/ChoicePrompts.tsx` already
 * draws for `chooseSingleEntityForEffect`'s `delayedReveal` — and drop 3
 * outright, because the opponent learns which card went from the log and
 * their own graveyard.
 *
 * Both are applied here, generically, over the STRUCTURE of the asks —
 * never a card name or a message string as the deciding fact, same rule
 * `auto.ts`'s own header states for its shortcuts:
 *
 *  - "fold": a `getChoices` reveal (`min === max === -1`) immediately
 *    followed (ignoring ordinary state/notify frames) by a `getChoices`
 *    choice for the SAME SEAT whose `choices` are a subset of the reveal's.
 *    `max === 1` only for now (`chooseSingleEntityForEffect` is singular) —
 *    a `RevealYouChoose` with `NumCards` above 1 is left unmerged, a known
 *    gap noted in the evidence doc rather than guessed at.
 *  - "drop": a `getChoices` reveal whose `choices` are EXACTLY the card ids a
 *    fold or an ordinary reply just sent Forge as a discard choice, for
 *    EITHER seat — `Match.noteDiscardChoice` is the one place that sets it,
 *    from every path that can answer a real discard choice.
 */

/**
 * How long a held reveal waits for its matching choice before it is shown on
 * its own, for the case nothing else disqualifies it first (an ask that
 * arrives and does not match releases it at once, regardless of this timer).
 * Short on purpose: every ordinary, non-folding reveal in the game — an
 * opponent's hand shown by a tutor, a library search's "nothing found", any
 * `RevealYouChoose`-shaped card this fold does not recognise — waits this
 * long before it reaches the seat, and a measured real fold answers within
 * 10-30ms of the reveal arriving, so this is generous headroom, not a target.
 */
const PENDING_REVEAL_FOLD_MS = 250;

type PromptFrame = Extract<ServerFrame, { method: 'showPromptMessage' }>;
type ButtonsFrame = Extract<ServerFrame, { method: 'updateButtons' }>;

/**
 * How long a held half waits for the other before it is forwarded undecided.
 * Forge sends the two within a few milliseconds; a payment's bar and its
 * prompt were measured up to 251 ms apart on a loaded jar, so this is
 * headroom, not a target.
 */
const PROMPT_HOLD_FLUSH_MS = 2000;

/**
 * Which decider-readable window a frame belongs to, and so which way it pairs.
 * Forge's inputs send the two halves in a fixed order per input:
 * `InputPassPriority.showNormalPrompt` the prompt and then its OK bar;
 * `InputPayMana.updateMessage` the `Auto` bar and then the prompt (after
 * `showMessage` has already sent a disabled `Auto` bar);
 * `InputConfirm.showMessage` the Yes/No bar and then the prompt;
 * `InputSelectTargets.showMessage` a trigger's target prompt and then its bar.
 * A prompt with no shape here (an attack, a block, a spell's target) is no decider's to answer and
 * is never held, and neither is a bar with none (InputAttack's per-click
 * refresh above all).
 */
type WindowShape = 'priority' | 'payment' | 'confirm' | 'target';

function promptShape(frame: PromptFrame): WindowShape | null {
	if (frame.confirmAbility != null) return 'confirm';
	if (frame.targetAbility !== undefined) return 'target';
	if (PAY_MANA.test(frame.message)) return 'payment';
	if (PRIORITY.test(frame.message)) return 'priority';
	return null;
}

function buttonsShape(frame: ButtonsFrame): WindowShape | null {
	if (frame.label1 === 'Auto') return 'payment';
	if (frame.label1 === 'Yes' && frame.label2 === 'No') return 'confirm';
	return null;
}


/** One decided window, as {@link Match.recordWindow} keeps it for the `match-frames` log event. */
interface FrameLogEntry {
	t: number;
	seat: number;
	kind: StopWindow;
	decision: 'forwarded' | 'withheld';
	why: string;
	message: string | null;
	buttons: { label1: string; enable1: boolean; label2: string; enable2: boolean } | null;
}

/** How many {@link FrameLogEntry} rows one match keeps — a ring, not a log that grows forever. */
const FRAMES_RING_SIZE = 500;

/**
 * `InputPassPriority.showYieldSuggestionPrompt`'s own button labels
 * (`en-US.properties`: `lblAccept`, `lblDecline`) — see
 * {@link Match.maybeDeclineYieldSuggestion}'s own header (wave 35 §S item 2).
 */
const YIELD_ACCEPT_LABEL = 'Accept';
const YIELD_DECLINE_LABEL = 'Decline';

/** A wait that appears is told to the other seat after this long; one that clears, at once — `Match.checkWaitingOn`. */
const WAITING_ON_GRACE_MS = 150;

/** How long a just-sent discard choice stays eligible to silence its own echo. */
const JUST_DISCARDED_TTL_MS = 5_000;

/** The card ids a `getChoices` frame's `choices` name, in order. */
function choiceCardIds(choices: readonly ChoiceOption[]): number[] {
	const ids: number[] = [];
	for (const c of choices) if (c.ref !== null && c.ref.kind === 'card') ids.push(c.ref.id);
	return ids;
}

/** Every id of `small` is also in `big` — true for an empty `small` too, which never merges here (`.length > 0` guards every call site). */
function isCardSubset(small: readonly number[], big: readonly number[]): boolean {
	const set = new Set(big);
	return small.every((id) => set.has(id));
}

function sameCardSet(a: readonly number[], b: ReadonlySet<number>): boolean {
	return a.length === b.size && a.every((id) => b.has(id));
}

type RevealFrame = Extract<ServerFrame, { kind: 'ask'; method: 'getChoices' }>;

/**
 * An ask in which nothing may be chosen (`max <= 0`) is Forge showing cards,
 * not asking about them — `reveal(message, items)` IS `getChoices(message, -1,
 * -1, items)` (`AbstractGuiGame.java:785-788`), and the one legal reply to
 * any such ask is the empty list. A `chooseEntitiesForEffect` of that shape is
 * read as the `getChoices` reveal of every card it names (its options, then
 * its `delayedReveal`), each labelled by `nameOf`, so a reveal reaches the
 * seat in one shape whatever Forge called. Null for an ask with something to
 * choose.
 */
function asReveal(frame: Extract<ServerFrame, { kind: 'ask' }>, nameOf: (ref: NonNullable<ChoiceOption['ref']>) => string): RevealFrame | null {
	if (frame.method === 'getChoices') return frame.max <= 0 ? frame : null;
	if (frame.method !== 'chooseEntitiesForEffect' || frame.max > 0) return null;
	const refs = new Map<string, NonNullable<ChoiceOption['ref']>>();
	for (const ref of [...frame.optionList, ...(frame.delayedReveal?.cards ?? [])]) refs.set(`${ref.kind}:${ref.id}`, ref);
	return {
		kind: 'ask',
		callId: frame.callId,
		method: 'getChoices',
		message: frame.title,
		min: -1,
		max: -1,
		choices: [...refs.values()].map((ref, i) => ({ key: `c${i}`, label: nameOf(ref), ref })),
		selected: [],
	};
}

export class Match {
	readonly id: string;
	/** Minted per match-process start: a restart is a new epoch. */
	readonly epoch: string;
	status: MatchStatus = 'starting';
	failure: string | null = null;
	winner: string | null = null;
	/**
	 * The winning seat, from Forge's own `losers` (player ids) mapped through each
	 * seat's player id — set when the game ends, null when it cannot be told. The
	 * only way an AI game names its winner: the AI seat has no display name for
	 * `winner` to match, and no player id of its own (it never opens a view).
	 */
	winnerSeat: 0 | 1 | null = null;
	/** The seat whose concede Forge was sent, or null — the one end reason the board cannot show. */
	concededBy: number | null = null;
	/**
	 * When the match was started, in ms. A match taken back after a restart
	 * keeps the start its JVM's record has (`JvmRecord.startedAt`), so this is
	 * the same instant whichever process ends it.
	 */
	readonly startedAt: number;
	/** When Forge said the game was over; null until then. */
	endedAt: number | null = null;
	readonly seats: SeatState[];
	/** Frames Forge sent that forge-wire refused. Dropped, counted, logged. */
	invalidFrames = 0;
	/**
	 * The watcher channel: ONE public projection (`createProjector(null)`, so
	 * `cardVisibility` shows the table and no hand) with its own cursor and
	 * history, fed from the FIRST human seat's Tier C stream — Forge sends
	 * every seat the whole state, so one seat's stream is the whole table —
	 * and emitted on {@link WATCHER_SEAT}. State frames, that seat's
	 * `openView` (so a client's "the snapshot seated me as a player openView
	 * names" check holds for the perspective it is handed) and the two end
	 * notices; never a prompt, a bar, an ask or a selection: a watcher is
	 * asked nothing. Everyone who is not playing gets the same bytes, which is
	 * what keeps a crowded room from multiplying the projection work.
	 */
	private readonly watcher: { readonly projector: SeatProjector; seq: number; history: ServerFrame[]; ended: boolean } = {
		projector: createProjector(null),
		seq: 0,
		history: [],
		ended: false,
	};

	private readonly deps: MatchDeps;
	readonly spec: MatchSpec;
	private host: MatchHost | null = null;
	private readonly now: () => number;
	private readonly runningWaiters: ((outcome: ClientOutcome) => void)[] = [];
	/** `whenRunning` timeouts not yet started, because the match is waiting for a boot slot. */
	private readonly bootWaiters: (() => void)[] = [];
	/**
	 * This match's place among the starts waiting for a boot slot (`start-queue.ts`), 1-based, or
	 * null once its JVM is booting — and for a match that never waited.
	 */
	queuePlace: number | null = null;
	private readonly probes = new Map<string, (r: ProbeResult) => void>();
	private overTimer: NodeJS.Timeout | null = null;
	/**
	 * True while `resume` is feeding an earlier server's lines back in. Nothing
	 * may go OUT during that: every command in the stream was already sent by the
	 * server that read it, and sending it twice would act twice in Forge.
	 */
	private replaying = false;
	/** Armed while no seat is here ({@link Match.armRejoinGrace}): a match nobody comes back to is stopped. */
	private rejoinTimer: NodeJS.Timeout | null = null;
	/**
	 * Wave 35 §S, R4 — the card ids a discard choice JUST sent to Forge. The
	 * next `getChoices` REVEAL (`min === max === -1`) whose `choices` are
	 * exactly this set, for EITHER seat, is the discarder's own redundant
	 * "you have been shown what was taken" confirmation (`DiscardEffect.java`'s
	 * second `reveal()` call) — the operator's ruling is that nobody needs it,
	 * because the log and the graveyard already say what went. Cleared on use
	 * and by its own short timer, so a stale set can never survive to answer an
	 * UNRELATED later reveal that happens to name the same cards.
	 */
	private justDiscarded: { ids: ReadonlySet<number>; timer: NodeJS.Timeout } | null = null;
	/**
	 * The last {@link FRAMES_RING_SIZE} decided prompt windows, every seat,
	 * forwarded and withheld alike, logged once as `match-frames` by
	 * {@link logFrames} when the match ends. It goes to the structured log
	 * rather than a file in the run directory because `host.ts` removes that
	 * directory whole on a clean end, and the log is what outlives a match.
	 */
	private readonly framesRing: FrameLogEntry[] = [];
	private framesLogged = false;
	/**
	 * The last `waitingOn` fact (as JSON, seat by seat) `deps.seatsChanged` was
	 * told, so {@link Match.checkWaitingOn} — called from every place
	 * {@link SeatState.asks} or {@link SeatState.payment} can change — sends a
	 * fresh roster only when the fact it carries actually moved, the same
	 * "a change that changes nothing is not re-sent" rule the lobby's
	 * `setAvatar` already follows for {@link Match.seatAvatarChanged}.
	 */
	private lastWaitingOnKey = '';
	/**
	 * A wait that APPEARS is told after {@link WAITING_ON_GRACE_MS}; one that clears
	 * is told at once — see {@link Match.checkWaitingOn}. The pending tell, if any.
	 */
	private waitingOnTimer: ReturnType<typeof setTimeout> | null = null;
	/** The fact set `waitingOnTimer` will tell when it fires — a repeat of it leaves the timer running. */
	private pendingWaitingOnKey: string | null = null;
	/** See {@link SeatIdentity.coinToss}: set and cleared in {@link Match.send}. */
	private coinToss: { winner: number; at: number } | null = null;
	/**
	 * `Match.waitingOnFor`'s own cache: `foldFrames` is linear in a seat's
	 * WHOLE history,
	 * and `waitingOnFor` can run on every ask,
	 * selection and answer-bar open or close over a long game. Re-folding a
	 * seat whose history has not grown since the last call wastes exactly the
	 * work this cache skips; keyed by seat, invalidated the instant that
	 * seat's `history` grows past the cached length.
	 */
	private readonly foldedCache = new Map<number, { len: number; state: ReadonlyMap<string, WireObj> }>();

	/** Every name either seat's deck (or a test scenario) plays — offered by a card-name ask whatever the format. */
	private deckNames: ReadonlySet<string> | null = null;

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
		restore?: { epoch: string | null; owners: (string | null)[]; startedAt: number },
	) {
		this.id = id;
		this.spec = spec;
		this.deps = deps;
		this.now = deps.now ?? Date.now;
		this.startedAt = restore?.startedAt ?? this.now();
		this.epoch = restore?.epoch ?? `${id}:${this.startedAt}`;
		this.seats = spec.seats.map((s, seat) => ({
			seat,
			ai: s.ai,
			owner: null,
			playerId: null,
			displayName: (s as SeatSpecWithIdentity).displayName,
			projector: createProjector(),
			seq: 0,
			history: [],
			early: [],
			asks: new Map(),
			prompt: null,
			buttons: null,
			passedOn: null,
			deck: null,
			endNotices: [],
			departure: null,
			here: false,
			away: false,
			fullControl: false,
			autoYield: null,
			phaseStop: null,
			stopHeld: null,
			triggerDecisions: new Map(),
			// The starting value only — `setStopPolicy` still moves one seat at a
			// time. Absent is production (`MatchDeps.stopPolicy`).
			policy: deps.stopPolicy ?? DEFAULT_STOP_POLICY,
			actionable: null,
			selection: null,
			highlighted: new Map(),
			weakly: null,
			heldSacrifice: null,
			pickedSacrifice: false,
			payment: null,
			autoPaid: null,
			autoCancelled: null,
			autoAnswered: 0,
			autoPassed: 0,
			lastStop: null,
			mulligans: 0,
			says: [],
			heldLog: [],
			heldLogTimer: null,
			lastAbilityToPlay: null,
			chosenAbility: null,
			confirmedCosts: new Set(),
			sameTarget: null,
			chosenTargets: new Set(),
			clicked: null,
			pendingReveal: null,
			behindReveal: [],
			mergedChoice: new Map(),
			owed: null,
			folds: new Map(),
			pendingPrompt: null,
			pendingButtons: null,
			pendingTimer: null,
			wireButtonsLive: false,
			answeredWindow: null,
			unparsed: new Map(),
			seenAsks: new Set(),
			actWatch: null,
			click: null,
			offeredLogged: null,
			staleBar: null,
		}));
		for (const [seat, owner] of (restore?.owners ?? []).entries()) {
			const s = this.seats[seat];
			if (s !== undefined && owner !== null) s.owner = owner as ParticipantId;
		}
	}

	/**
	 * Why this server could not give the match a Forge at all (the host threw: a full
	 * disk, a JVM that could not be spawned), or null. The match is `failed` with it;
	 * `POST /play/matches` answers it as 503, since it says nothing about the match.
	 */
	unstartable: string | null = null;

	/**
	 * Start Forge. Separate from the constructor so nothing can emit before the match is
	 * registered. A host that throws fails the match here, so a start never leaves one
	 * `starting` for good and never escapes the route as an exception.
	 */
	start(): void {
		if (this.host !== null) return;
		try {
			this.host = this.deps.host(this.id, this.spec, this.hostEvents());
		} catch (err) {
			this.unstartable = `this server could not start a match just now (${(err as Error).message})`;
			this.fail(this.unstartable);
			return;
		}
		this.host.remember?.({ epoch: this.epoch, owners: this.owners() });
	}

	/**
	 * Take over a JVM that is already playing this match, left running by a server
	 * that has exited (Wave 22 §E). `attach` replays that server's whole line
	 * stream into `onLine` before it returns, so by the time this call is done
	 * every seat holds the history, cursor and open asks it held — same epoch,
	 * same `seq`, same owners — and a client resyncs rather than starting over.
	 *
	 * Separate from `start` for the same reason `start` is separate from the
	 * constructor: nothing may emit before the match is in the registry.
	 */
	resume(attach: (events: HostEvents) => MatchHost): void {
		if (this.host !== null) return;
		this.replaying = true;
		try {
			this.host = attach(this.hostEvents());
		} finally {
			this.replaying = false;
		}
		this.host.remember?.({ epoch: this.epoch, owners: this.owners() });
		this.deps.log({
			evt: 'match-resumed',
			matchId: this.id,
			status: this.status,
			epoch: this.epoch,
			seats: this.seats.map((s) => ({ seat: s.seat, playerId: s.playerId, seq: s.seq, asks: s.asks.size })),
		});
		this.armRejoinGrace();
	}

	/**
	 * A match with no seat here is a JVM nobody is using: the seats have
	 * {@link MatchDeps.rejoinGraceMs} to come back before it is stopped for good. Armed when the
	 * match goes running or is taken back (its seats can join from then on, not while Forge boots)
	 * and when the last seat's departure grace runs out; {@link Match.seatConnected} disarms it. Before this covered every match, only a
	 * re-attached one had it, and a match both players had left held one of the server's two slots
	 * for ~2 h (2026-10-11: `seat-departing` for both seats, then nothing, then a refused rematch).
	 */
	private armRejoinGrace(): void {
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
			this.stop();
		}, grace);
		this.rejoinTimer.unref();
	}

	private hostEvents(): StartEvents {
		return {
			line: (line) => this.onLine(line),
			exit: (reason) => this.onExit(reason),
			log: (entry) => this.deps.log(entry),
			replayed: (command) => this.onReplayedCommand(command),
			queued: (place) => {
				this.queuePlace = place;
			},
			booting: () => {
				this.queuePlace = null;
				for (const arm of this.bootWaiters.splice(0)) arm();
			},
		};
	}

	/** seat → owner, for the on-disk record a re-attach reads. */
	private owners(): (string | null)[] {
		return this.seats.map((s) => s.owner);
	}

	/**
	 * A command the EARLIER server had already sent, met during a replay. Only
	 * the two that close an ask matter: without them a seat would be re-shown a
	 * modal it has already answered, because nothing the bridge SAYS records that
	 * an ask was answered.
	 */
	private onReplayedCommand(command: BridgeCommand): void {
		if (command.t !== 'reply' && command.t !== 'abort') return;
		const s = this.seats[command.seat];
		if (s === undefined) return;
		this.closeAsk(s, command.callId);
	}

	private command(command: Parameters<MatchHost['send']>[0]): void {
		// Before the null check, not after: during a replay the answer is already in
		// Forge AND `this.host` does not exist yet, because `attach` replays the
		// stream before it returns the host. A replayed line that provokes an
		// auto-answer used to throw here.
		if (this.replaying) return;
		if (this.host === null) throw new Error(`match ${this.id} was never started`);
		if (TRACE_FRAMES) {
			const { t, seat } = command as { t: string; seat?: number };
			const detail = command as { frame?: unknown; callId?: unknown; result?: unknown };
			this.deps.log({
				evt: 'forge-command',
				matchId: this.id,
				cmd: t,
				seat,
				...(detail.frame !== undefined ? frameGist(detail.frame) : {}),
				...(typeof detail.callId === 'string' ? { callId: detail.callId } : {}),
				...(detail.result !== undefined ? { result: JSON.stringify(detail.result).slice(0, 160) } : {}),
			});
		}
		this.host.send(command);
		if (command.t === 'act' && INPUT_ACTS.has(command.frame.method)) {
			const s = this.seats[command.seat];
			if (s !== undefined) {
				this.endClick(s, 'next-act');
				this.armActWatch(s, 'act');
				if (command.frame.method === 'selectCard') s.click = { card: command.frame.card.id, at: this.now() };
			}
		}
	}

	/**
	 * The lost-ask safety net. An input act went to a live JVM; if nothing at
	 * all comes back for its seat within {@link ACT_SILENCE_MS}, the bridge is
	 * asked to re-send every ask the seat is still parked on, each with its
	 * original callId (`PlayBridge.SeatGui.resendPending`). An ask frame lost
	 * between the bridge and this server leaves Forge's game thread waiting on
	 * a question nobody was shown, and every later click queues behind it on
	 * the fork's act gate — silent, which is exactly what this watches for.
	 *
	 * A frame that shows the seat its next window disarms it ({@link answersAnInput}),
	 * so a click that Forge answered — a priority pass that moves the game on, a
	 * payment that shows a bar — never fires it, and nothing is armed while the
	 * seat is only waiting on the other player. A state delta does not: the
	 * click on a card applies one BEFORE Forge asks which ability (measured on
	 * pin 09aeb164), and the ask after it is the frame that can be lost. A false fire costs one bridge line: a seat
	 * with nothing pending is re-sent nothing, and a callId already seen is
	 * dropped in {@link Match.onFrame}.
	 */
	private armActWatch(s: SeatState, after: 'act' | 'answer'): void {
		if (s.actWatch !== null) clearTimeout(s.actWatch);
		s.actWatch = setTimeout(
			() => {
				s.actWatch = null;
				if (this.status !== 'running') return;
				if (s.staleBar !== null && s.asks.size === 0) this.resendWindow(s, after);
				if (after === 'answer') return;
				this.endClick(s, 'silence');
				this.deps.log({ evt: 'act-unanswered', matchId: this.id, seat: s.seat, openAsks: s.asks.size });
				this.command({ t: 'resend-pending', seat: s.seat });
			},
			after === 'act' ? (this.deps.actSilenceMs ?? ACT_SILENCE_MS) : ANSWER_SILENCE_MS,
		);
		s.actWatch.unref();
	}

	/**
	 * Forge kept the input it last showed this seat and said nothing after the seat's act or
	 * answer ({@link SeatState.staleBar}): that input's prompt and live bar go back on the
	 * seat's screen, as they were. Idempotent — the bar is taken once, and Forge's own next
	 * frame replaces whatever this sent.
	 */
	private resendWindow(s: SeatState, after: 'act' | 'answer'): void {
		const bar = s.staleBar;
		if (bar === null) return;
		s.staleBar = null;
		s.buttons = bar;
		if (s.prompt !== null) this.send(s, s.prompt);
		this.send(s, bar);
		this.deps.log({ evt: 'window-resent', matchId: this.id, seat: s.seat, after, label1: bar.label1, label2: bar.label2 });
		this.checkWaitingOn();
	}

	/**
	 * The `click` record: a `selectCard` this seat sent, and what came of it — `answered` when Forge
	 * showed the seat a window or an ask for it (`ms` after the click, `by` the frame's method),
	 * `silence` when the act watch ran out first, `next-act` when the seat acted again before either.
	 * So "I clicked X and nothing happened" reads straight off the match log.
	 */
	private endClick(s: SeatState, outcome: 'answered' | 'silence' | 'next-act', frame?: unknown): void {
		const click = s.click;
		if (click === null) return;
		s.click = null;
		const by = (frame as { method?: unknown } | undefined)?.method;
		this.deps.log({
			evt: 'click',
			matchId: this.id,
			seat: s.seat,
			card: click.card,
			outcome,
			ms: this.now() - click.at,
			...(typeof by === 'string' ? { by } : {}),
		});
	}

	private disarmActWatch(seat: number): void {
		const s = this.seats[seat];
		if (s === undefined || s.actWatch === null) return;
		clearTimeout(s.actWatch);
		s.actWatch = null;
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
		this.host?.remember?.({ epoch: this.epoch, owners: this.owners() });
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
	 * Every seat's identity — item 4 (wave 29 §B), the server half of *"i
	 * noticed you're still not pulling in the watchparty selected avatars"*.
	 *
	 * **Deliberately NOT folded into {@link Match.snapshot}.** `MatchSnapshot`
	 * is `.strict()` (`transport.ts`'s `MatchSnapshotSchema`, mirrored byte for
	 * byte in `apps/ui/src/play/live/transport.ts`), and neither file is this
	 * lane's to widen this wave — `match.test.ts` and `socket.test.ts` both
	 * validate a live snapshot against that schema, so an extra key there
	 * reds them for a reason that has nothing to do with this feature. This is
	 * sent instead as its own event, `forge:seats` (`socket.ts`'s `answer`), on
	 * the same "a fresh page needs this" list `resendAfterSnapshot`'s header
	 * names for the prompt and the full-control echo.
	 *
	 * Both seats, always — not caller-scoped, the same reasoning `routes.ts`'s
	 * `tableView` gives for `avatarId`: a face is not hidden information. A
	 * seat with none has the key ABSENT rather than `avatarId: undefined`, so
	 * an in-process reader and a JSON reader agree (`D-avatar-field.md` §3).
	 */
	seatIdentities(): SeatIdentity[] {
		return this.seats.map((s) => ({
			seat: s.seat,
			claimed: s.owner !== null,
			playerId: s.playerId,
			...(() => {
				const owner = s.ai ? AI_SEAT_OWNER : s.owner;
				const avatarId = owner === null ? undefined : this.deps.seatAvatar?.(this.id, owner);
				return avatarId === undefined ? {} : { avatarId };
			})(),
			...(s.displayName === undefined ? {} : { name: s.displayName }),
			...(() => {
				const waitingOn = this.waitingOnFor(s);
				return waitingOn === null ? {} : { waitingOn };
			})(),
			...(this.coinToss === null ? {} : { coinToss: this.coinToss }),
			...(s.away ? { away: true } : {}),
		}));
	}

	/**
	 * This seat's own live input, as the fact it is — a
	 * method and (when Forge named one, and the OTHER seat may see it) a
	 * card's name. `null` whenever this seat has nothing open.
	 *
	 * **Payment first, asks second, never both**: `InputPayMana` is not one of
	 * the 15 blocking methods (`payingMana`'s own note, `apps/ui/src/play/live/match.ts`) —
	 * it runs on the ordinary prompt/buttons channel, so `s.payment` and
	 * `s.asks` never hold at once for the same seat.
	 *
	 * **A selection counts too, and comes before a plain ask.** `setSelectables`
	 * is never an {@link OpenAsk} (it carries no `callId`; `InputSelectManyBase`
	 * is not one of the 15 blocking methods) but it is this seat's own live
	 * decision exactly as much as one is — the client's own rule, before this
	 * wave's fix replaced it (`apps/ui/src/play/live/LiveBoard.tsx`'s deleted
	 * `myMoveNow`). Measured against the real jar for Thirst for Knowledge's
	 * discard (`docs/planning/wave60-evidence/B/waiting.md`): the two-of-five
	 * choice reaches the wire as `setSelectables(min:2, max:2, …)`, not a
	 * `getChoices` ask — a bridge `tempShowZones` ask opens ALONGSIDE it, but
	 * that one is pacing machinery with nothing for a seat to decide, so a
	 * selection is checked FIRST and wins. `min === max === 1` reuses
	 * `chooseSingleEntityForEffect`'s own verb ("choose"); anything else reuses
	 * `getChoices`'s ("choose cards") — both real wire methods already in the
	 * client's table, not a label invented for this.
	 *
	 * **Last, {@link SeatState.wireButtonsLive} — ordinary priority included.**
	 * The coin toss's Play/Draw and the opening Keep/Mulligan answer through
	 * `updateButtons` alone, with an `act`, never a `reply`: no ask, no
	 * selection, no payment. So does an ORDINARY priority window with
	 * something castable — `getAbilityToPlay`'s own ask is the thing a seat
	 * answers there, but this server auto-passes it the instant nothing
	 * interesting is on offer, which is the common case and leaves no
	 * `OpenAsk` behind at all. `wireButtonsLive` is the one fact that already
	 * tracks "the browser's current bar has a live button" correctly through
	 * every auto-pass correction (`Match.send`'s own note), which raw
	 * `s.buttons.enable1` does not: `decideWindow` sends a DISABLED bar to the
	 * browser when it auto-answers a window, but never corrects `s.buttons`
	 * itself, so reading that field directly would read the stale, still-
	 * enabled original. Checked last because it is the broadest signal —
	 * true for the two pregame bars above AND for ordinary mid-game priority
	 * — and every more specific branch above already returned first when it
	 * applies.
	 *
	 * The host card comes off `s.prompt`'s own `card` — `showPromptMessage`'s
	 * third argument, which Forge sends fresh with an ask or a payment prompt
	 * alike (`InputPayMana.updateMessage`, `InputConfirm.showMessage`,
	 * `InputPassPriority`'s own prompt ahead of `getAbilityToPlay`) — falling
	 * back to {@link stackTopHostCardId} when the prompt is stale or card-less,
	 * which is exactly `setSelectables`' own case: measured against the real
	 * jar, the one-shot "Priority: … Stack: 1 to Resolve." prompt Forge sends
	 * the caster right before Thirst for Knowledge resolves carries `card:
	 * null` (an ordinary priority prompt, not an announcement), and
	 * {@link SeatState.chosenAbility} is already cleared by then — that exact
	 * prompt's own `startsWith('Priority:')` is what clears it, a few lines
	 * below. The spell is still ON the stack while its own discard resolves
	 * (nothing passes priority to remove it mid-resolution), so the stack's
	 * top is the one fact that survives to read. Resolved through the OTHER
	 * seat's folded history, never this seat's: a card only this seat can see
	 * (its own hand) is absent from that fold and resolves to `null`; the
	 * stack and a battlefield are public either way and resolve to a name.
	 *
	 * **An ask the browser answers on its own is nobody's decision** —
	 * `@hadoku/shared`'s `selfAnswer`, the one rule both sides read.
	 */
	private waitingOnFor(s: SeatState): { method: string; hostCard: string | null } | null {
		// An ask the seat's browser answers by itself (`selfAnswer`, the browser's own rule) is nobody's
		// decision, however long a loaded browser takes to reply — no grace is long enough.
		const decision = [...s.asks.values()].find((ask) => selfAnswer(ask.frame) === null);
		// A live bar on an ORDINARY priority window (Forge's "Priority: …" prompt) is not a decision
		// either: the seat merely holds priority. The operator, 2026-10-08 (AE13), after a bounceland
		// returned itself with no choice to make: *"it still shows 'Waiting for Bella to decide…' as if
		// i needed to make a choice there"* — the bar fallback below read as `confirm` ("decide"). Only
		// the pregame bars (coin toss, keep/mulligan: no "Priority:" prompt) are a decision made through
		// the bar alone.
		const promptMessage = s.prompt !== null && s.prompt.method === 'showPromptMessage' ? s.prompt.message : '';
		const ordinaryPriority = /^Priority:/.test(promptMessage);
		// Nor is a seat's own yield after End Turn (its Cancel live, `YIELDING`): it passed priority and
		// decides nothing. The operator, 2026-10-11, under full control on the other seat: *"i see
		// 'Waiting for Hadoku to decide…' but on Hadoku's side, there is nothing since they clicked end
		// turn"* — while that full-control seat held priority itself.
		const barLive = s.wireButtonsLive && !YIELDING.test(promptMessage);
		const method =
			s.payment !== null
				? 'pay'
				: s.selection !== null
					? s.selection.method === 'setSelectables' && s.selection.min === 1 && s.selection.max === 1
						? 'chooseSingleEntityForEffect'
						: 'getChoices'
					: decision !== undefined
						? decision.method
						: barLive
							? ordinaryPriority
								? 'priority'
								: 'confirm'
							: null;
		if (method === null) return null;
		if (method === 'priority') return { method, hostCard: null };
		const other = this.seats.find((o) => o.seat !== s.seat);
		const otherState = other === undefined ? null : this.foldedStateOf(other);
		const prompt = s.prompt;
		const promptCardId = prompt !== null && prompt.method === 'showPromptMessage' ? prompt.card?.id ?? null : null;
		const cardId = promptCardId ?? (otherState === null ? null : stackTopHostCardId(otherState));
		if (cardId === null || otherState === null) return { method, hostCard: null };
		return { method, hostCard: cardName(otherState, cardId) };
	}

	/** {@link Match.foldedCache}'s own reader — see that field's note. */
	private foldedStateOf(s: SeatState): ReadonlyMap<string, WireObj> {
		const cached = this.foldedCache.get(s.seat);
		if (cached !== undefined && cached.len === s.history.length) return cached.state;
		const state = foldFrames(s.history as unknown as StateFrame[]);
		this.foldedCache.set(s.seat, { len: s.history.length, state });
		return state;
	}

	/**
	 * Re-broadcast the seat roster when, and only when, somebody's
	 * {@link Match.waitingOnFor} actually moved — call from every place
	 * {@link SeatState.asks} or {@link SeatState.payment} changes. Wave 64 §S
	 * (S4) folded the three ask-opening call sites into one
	 * ({@link Match.openAskFrame}'s own tail), so that half of the list is one
	 * call site now, not three to keep in sync by hand; `closeAsk` and
	 * `trackPayment` call it directly, same as before.
	 * Cheap to over-call: the key comparison is the guard, not the call site.
	 */
	private checkWaitingOn(): void {
		const facts = this.seats.map((s) => this.waitingOnFor(s));
		const key = JSON.stringify(facts);
		// The same not-yet-told fact as the timer already pending: let that timer run. Resetting it
		// on every call turned the 150 ms grace into a debounce — an End Turn crawl re-checks on
		// almost every frame, so a wait that appeared mid-crawl was told only when the crawl stopped,
		// ~5 s late (AE16: lags 451, 5045, 837 ms on the CI runners).
		if (this.waitingOnTimer !== null && key === this.pendingWaitingOnKey) return;
		if (this.waitingOnTimer !== null) {
			clearTimeout(this.waitingOnTimer);
			this.waitingOnTimer = null;
		}
		this.pendingWaitingOnKey = null;
		// Back to what was last told — an ask that opened and closed inside the grace: nothing to say.
		if (key === this.lastWaitingOnKey) return;
		const tell = (): void => {
			this.waitingOnTimer = null;
			this.lastWaitingOnKey = JSON.stringify(this.seats.map((s) => this.waitingOnFor(s)));
			this.deps.seatsChanged?.(this.seatIdentities());
		};
		// A wait that CLEARS is told at once (the other seat must not sit on a stale sentence — AD5).
		// A wait that APPEARS is told after a short grace, so a fact that is gone again a few frames
		// later never flashes on the other screen. Nobody reads a 150 ms delay on a real wait. An ask
		// the browser answers on its own is not a wait at all (`selfAnswer`): no grace is long
		// enough for a loaded browser's reply.
		const told = this.lastWaitingOnKey === '' ? [] : (JSON.parse(this.lastWaitingOnKey) as (unknown | null)[]);
		const appears = facts.some((f, i) => f !== null && JSON.stringify(f) !== JSON.stringify(told[i] ?? null));
		if (!appears) {
			tell();
			return;
		}
		this.pendingWaitingOnKey = key;
		this.waitingOnTimer = setTimeout(() => {
			this.pendingWaitingOnKey = null;
			tell();
		}, WAITING_ON_GRACE_MS);
		this.waitingOnTimer.unref();
	}

	/**
	 * The holder of `seat` changed their avatar — wave 32, Q6, the server half of
	 * *"watchparty chat and the game are desynced when i change avatars"*. The
	 * avatar lives with its holder ({@link MatchDeps.seatAvatar}), so all there is
	 * to do is re-send the roster: to EVERY socket in the match through
	 * `deps.seatsChanged` (both seats' avatars, always — a face is not hidden
	 * information), not just the changed seat's, since the opponent is watching
	 * the same board. `routes.ts` calls this from the room's identity route.
	 */
	seatAvatarChanged(seat: number): void {
		const identity = this.seatIdentities()[seat];
		if (identity === undefined) return;
		this.deps.log({ evt: 'seat-avatar', matchId: this.id, seat, avatarId: identity.avatarId ?? null });
		this.deps.seatsChanged?.(this.seatIdentities());
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
	 *
	 * One member of that set is NOT a frame and so is not sent here: the seat's
	 * `fullControl`, which `socket.ts` emits on `forge:full-control` right after
	 * this runs (see `transport.ts`'s header). It is a preference rather than
	 * anything Forge said, it has no cursor, and it must not enter this seat's
	 * history — but it is needed after a snapshot for exactly the same reason
	 * the prompt is.
	 */
	resendAfterSnapshot(seat: number): void {
		const s = this.seats[seat];
		if (s === undefined) return;
		for (const said of s.says) this.send(s, said);
		if (s.prompt !== null && s.buttons !== null) this.sendWindow(s, s.prompt, s.buttons);
		else if (s.prompt !== null) this.send(s, s.prompt);
		else if (s.buttons !== null) this.send(s, s.buttons);
		for (const ask of s.asks.values()) this.send(s, ask.frame);
		/*
		 * The open SELECTION, in the order Forge publishes it: the offer, then the
		 * marks, then the actionable set. Each is the frame Forge sent (the marks
		 * re-folded into one `on: true` frame), so a client that already holds
		 * them simply replaces them with the same values.
		 */
		if (s.selection !== null) this.send(s, s.selection);
		if (s.highlighted.size > 0) {
			this.send(s, { kind: 'notify', method: 'setHighlighted', entities: [...s.highlighted.values()], on: true } as unknown as ServerFrame);
		}
		if (s.weakly !== null) this.send(s, s.weakly);
		// `'finished'` before `'ended'` when both are present — the one order the
		// two separate fields this replaced were always sent in (S7, wave 64).
		for (const kind of ['finished', 'ended'] as const) {
			const notice = s.endNotices.find((n) => n.kind === kind);
			if (notice !== undefined) this.send(s, notice.frame);
		}
	}

	/* ── Browser → Forge ────────────────────────────────────────────── */

	fromClient(seat: number, frame: ClientFrame): ClientOutcome {
		const s = this.seats[seat];
		if (s === undefined || s.ai) return { ok: false, error: 'no-such-seat' };
		// Refused in words of its own, and before the general status check: the
		// game having ended is the one reason a concede can arrive late (the
		// board still shows the button for a moment), and a log that says only
		// "match is over" does not say a player tried to give up a finished game.
		if (frame.kind === 'act' && frame.method === 'concede' && this.status !== 'running') {
			this.deps.log({ evt: 'concede-refused', matchId: this.id, seat, status: this.status, reason: 'the game has already ended' });
			return { ok: false, error: `concede-after-game-over (match is ${this.status})` };
		}
		if (this.status !== 'running') return { ok: false, error: `match is ${this.status}` };
		switch (frame.kind) {
			case 'act':
				// A click inside an open selection (a sacrifice, a target) picks a card; it opens no offer of its own.
				if (frame.method === 'selectCard') s.clicked = s.selection === null ? frame.card.id : null;
				if (frame.method === 'concede') this.concededBy = seat;
				if (frame.method === 'selectButtonCancel' && s.buttons?.method === 'updateButtons' && s.buttons.label2 === 'Mulligan') s.mulligans += 1;
				// The seat's own button press, with the label it pressed: a card click has its `click` record, and
				// without this one a pick that closed with no click in the log could not say who closed it.
				if (frame.method === 'selectButtonOk' || frame.method === 'selectButtonCancel') {
					const label = s.buttons?.method === 'updateButtons' ? (frame.method === 'selectButtonOk' ? s.buttons.label1 : s.buttons.label2) : undefined;
					this.deps.log({ evt: 'button', matchId: this.id, seat, method: frame.method, ...(label !== undefined ? { label } : {}) });
				}
				this.noteTargetPick(s, frame);
				this.disableStaleButtons(s);
				this.command({ t: 'act', seat, frame: forgeAct(frame) });
				return { ok: true };
			case 'reply': {
				const ask = s.asks.get(frame.callId);
				if (ask === undefined) return { ok: false, error: 'stale-reply' };
				if (ask.method !== frame.method) {
					return { ok: false, error: `reply is for ${frame.method}, the open ask is ${ask.method}` };
				}
				const named = ask.frame.method === 'getChoices' ? ask.frame.names : undefined;
				if (named !== undefined && !(frame.result as string[]).every((name) => named.includes(name))) {
					return { ok: false, error: 'reply names a card that was not offered' };
				}
				const fold = s.folds.get(frame.callId);
				const dig = fold?.method === 'chooseEntitiesForEffect' ? fold : undefined;
				const typeFold = fold?.method === 'getChoices' ? fold : undefined;
				// A per-type pick's one sheet: Forge is sent the first type, and its later type and
				// card questions wait for the same reply (`./each-type.ts`).
				const eachType =
					typeFold === undefined || ask.frame.method !== 'order' ? null : firstEachType(typeFold, ask.frame, (frame.result as { ordered: string[] }).ordered);
				if (typeFold !== undefined && eachType === null) return { ok: false, error: 'reply puts in two cards for one type' };
				this.closeAsk(s, ask.callId);
				const about = askGist(ask.frame);
				const fallback = s.unparsed.get(frame.callId);
				if (fallback !== undefined) {
					s.unparsed.delete(frame.callId);
					const result = fallback.answer(frame.result as string[]);
					this.deps.log({ evt: 'ask-answered', matchId: this.id, seat, callId: frame.callId, method: 'getChoices (fallback for an unparsed ask)', ms: this.now() - ask.sentAt, ...about });
					this.command({ t: 'reply', seat, callId: frame.callId, result });
					return { ok: true };
				}
				// Wave 35 §S, R4 — the browser answered a SYNTHETIC ask standing in
				// for the real discard choice (the reveal half was already answered
				// `[]` the moment it arrived — Forge's game thread was parked inside
				// it and would not even construct this choice until it was). Route
				// the ref the browser picked back to the real `getChoices` key.
				const merge = s.mergedChoice.get(frame.callId);
				if (merge !== undefined) {
					s.mergedChoice.delete(frame.callId);
					const ref = frame.result as { kind: string; id: number } | null;
					const key = ref === null ? undefined : merge.keyByRef.get(`${ref.kind}:${ref.id}`);
					this.deps.log({
						evt: 'ask-answered',
						matchId: this.id,
						seat,
						callId: frame.callId,
						method: 'chooseSingleEntityForEffect (R4 fold of a getChoices discard choice)',
						ms: this.now() - ask.sentAt,
						...about,
					});
					const chosenKeys = key === undefined ? [] : [key];
					this.command({ t: 'reply', seat, callId: merge.chooseCallId, result: chosenKeys });
					if (ref !== null && ref.kind === 'card') this.noteJustDiscarded(new Set([ref.id]));
					return { ok: true };
				}
				// Wave 34 §S4 — remember what THIS seat actually chose for a
				// `getAbilityToPlay`, so a repeat of Forge's own asking (see
				// `auto.ts`'s `repeatedAbilityToPlay`) does not need a second click.
				if (frame.method === 'getAbilityToPlay' && frame.result !== null && typeof frame.result === 'object') {
					const hostCard = (ask.frame as unknown as { hostCard: { id: number } }).hostCard.id;
					const abilityId = (frame.result as { id: number }).id;
					s.lastAbilityToPlay = { hostCard, abilityId };
					this.choose(s, s.lastAbilityToPlay);
				}
				if (eachType !== null) {
					s.owed = owing('the cards the one per-type prompt already picked', eachType.left, nextEachType);
					this.deps.log({ evt: 'ask-answered', matchId: this.id, seat, callId: frame.callId, method: 'getChoices (one order for every card type)', ms: this.now() - ask.sentAt, ...about, picked: (frame.result as { ordered: string[] }).ordered });
					this.command({ t: 'reply', seat, callId: frame.callId, result: eachType.result });
					return { ok: true };
				}
				// A scry's, surveil's or dig's one prompt: Forge is sent its first
				// question's answer, and the groups' orders wait for its later ones (`./arrange.ts`).
				if (frame.method === 'order' && ask.frame.kind === 'ask' && ask.frame.method === 'order' && ask.frame.rest !== undefined) {
					const reply = frame.result as { ordered: string[]; rememberDecision: boolean; rest?: string[] };
					const rest = restOrder(ask.frame, reply);
					s.owed = owing('the order the one scry, surveil or dig prompt already gave', pendingOrders(ask.frame, reply, dig !== undefined), answerPending);
					this.deps.log({ evt: 'ask-answered', matchId: this.id, seat, callId: frame.callId, method: dig === undefined ? frame.method : 'chooseEntitiesForEffect (one order with the dig\'s rest)', ms: this.now() - ask.sentAt, ...about, rest });
					const result = dig === undefined ? { ordered: reply.ordered, rememberDecision: reply.rememberDecision } : digAnswer(dig, reply);
					this.command({ t: 'reply', seat, callId: frame.callId, result });
					return { ok: true };
				}
				// A modal spell's one prompt: Forge is sent the first mode, and the rest
				// wait for its later mode questions (`./modes.ts`).
				if (frame.method === 'getChoices' && ask.frame.kind === 'ask' && ask.frame.method === 'getChoices' && ask.frame.modes !== undefined) {
					const first = firstMode(ask.frame, frame.result as string[]);
					s.owed = owing('the modes the modal spell prompt already picked', first.left, nextMode);
					this.deps.log({ evt: 'ask-answered', matchId: this.id, seat, callId: frame.callId, method: frame.method, ms: this.now() - ask.sentAt, ...about, modes: frame.result });
					this.command({ t: 'reply', seat, callId: frame.callId, result: first.result });
					return { ok: true };
				}
				// Wave 35 §S, R4 — a real (unmerged) discard choice answered plainly:
				// its own later echo to the discarder still needs no confirmation.
				if (frame.method === 'getChoices' && ask.frame.kind === 'ask' && ask.frame.method === 'getChoices' && ask.frame.min > 0) {
					this.noteDiscardChoice(ask.frame.choices, frame.result as string[]);
				}
				this.deps.log({
					evt: 'ask-answered',
					matchId: this.id,
					seat,
					callId: frame.callId,
					method: frame.method,
					ms: this.now() - ask.sentAt,
					...about,
				});
				this.command({ t: 'reply', seat, callId: frame.callId, result: frame.result });
				if (s.staleBar !== null) this.armActWatch(s, 'answer');
				return { ok: true };
			}
			case 'abort': {
				const ask = s.asks.get(frame.callId);
				if (ask === undefined) return { ok: false, error: 'stale-abort' };
				// Kept open: the seat's next snapshot shows it again.
				if (!ABORT_SAFE.has(ask.method)) {
					this.deps.log({ evt: 'ask-abort-refused', matchId: this.id, seat, callId: ask.callId, method: ask.method, reason: frame.reason });
					return { ok: false, error: `abort-refused (${ask.method} has no answer but the player's)` };
				}
				this.closeAsk(s, ask.callId);
				this.deps.log({ evt: 'ask-aborted', matchId: this.id, seat, callId: ask.callId, method: ask.method, reason: frame.reason });
				this.command({ t: 'abort', seat, callId: ask.callId, reason: frame.reason });
				return { ok: true };
			}
		}
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
		this.deps.log({ evt: 'seat-departing', matchId: this.id, seat, graceMs: grace, openAsks: s.asks.size });
		const gone = (): void => {
			s.here = false;
			s.away = true;
			this.deps.seatsChanged?.(this.seatIdentities());
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
			this.deps.seatsChanged?.(this.seatIdentities());
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
		this.deps.log({ evt: 'seat-returned', matchId: this.id, seat, openAsks: s.asks.size });
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
		this.deps.log({ evt: 'match-handed-over', matchId: this.id, epoch: this.epoch });
		return true;
	}

	/**
	 * This process is stopping and this match cannot outlive it. Every seat with a
	 * board is told so in words, on the stream it already reads, and the notice is
	 * kept so a later snapshot repeats it — the same machinery a crash uses,
	 * because to the player it is the same event.
	 */
	serverStopping(message: string): void {
		this.deps.log({ evt: 'match-ending-with-server', matchId: this.id, status: this.status });
		this.endNotice(message);
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
		this.logFrames();
		for (const done of this.runningWaiters.splice(0)) done({ ok: false, error: 'stopped' });
		this.closeAllAsks();
		this.host?.stop();
	}

	/** See {@link gameOutcome}. */
	outcome(): GameOutcome | null {
		return gameOutcome(this);
	}

	/**
	 * The game under way as the table card draws it (`table-game.ts`), by table seat — off the
	 * watcher's projector, so only what is on the table for everyone. Null before Forge has dealt and
	 * once the game is over.
	 */
	live(): TableGameLive | null {
		if (this.status !== 'running') return null;
		const projector = this.watcher.projector;
		const turn = projector.turnNumber();
		if (turn === null) return null;
		const counts = projector.playerCounts();
		const active = projector.activePlayer();
		const seat = (i: 0 | 1) => {
			const id = this.seats[i]?.playerId ?? null;
			return id === null ? undefined : counts.get(id);
		};
		const at = this.seats.findIndex((s) => s.playerId !== null && s.playerId === active);
		return {
			turn,
			active: at === 0 || at === 1 ? at : null,
			life: [seat(0)?.life ?? null, seat(1)?.life ?? null],
			hand: [seat(0)?.hand ?? 0, seat(1)?.hand ?? 0],
		};
	}

	/** What {@link MatchDeps.liveChanged} is told on: the turn, whose it is, the life totals. */
	private liveKey = '';

	private noteLive(): void {
		const live = this.live();
		const key = live === null ? '' : `${live.turn}|${live.active}|${live.life.join(',')}`;
		if (key === this.liveKey) return;
		this.liveKey = key;
		this.deps.liveChanged?.();
	}

	/* ── Forge → browser ────────────────────────────────────────────── */

	private send(s: SeatState, frame: ServerFrame, mark: 'displayOnly' | 'pairsWithNext' | null = null): void {
		if (frame.method === 'updateButtons') {
			s.wireButtonsLive = frame.enable1 === true || frame.enable2 === true;
			this.noteCoinToss(s, frame);
		}
		s.seq += 1;
		if (TRACE_FRAMES) this.deps.log({ evt: 'wire-frame', matchId: this.id, seat: s.seat, seq: s.seq, ...frameGist(frame) });
		const cursor: WireCursor = { epoch: this.epoch, seq: s.seq };
		this.deps.emit(s.seat, mark === null ? { matchId: this.id, cursor, frame } : { matchId: this.id, cursor, frame, [mark]: true });
	}

	/**
	 * Both halves of one Forge window, back to back, the first marked `pairsWithNext` so the
	 * browser applies them together: drawn as each arrived, a confirm's Yes/No (sent before its
	 * question) showed for a frame under the previous input's line.
	 */
	private sendWindow(s: SeatState, first: ServerFrame, second: ServerFrame): void {
		this.send(s, first, 'pairsWithNext');
		this.send(s, second);
	}

	/**
	 * {@link SeatIdentity.coinToss}'s one writer: the Play/Draw bar going live
	 * for a seat is Forge's own "you have won the coin toss" (the labels are
	 * Forge's `lblPlay`/`lblDraw`, the same pair `ConfirmPrompt.tsx`'s
	 * `isPlayOrDrawPrompt` reads); that seat's next different bar is the
	 * answer. Both seats are told at once, on `forge:seats`, outside
	 * `checkWaitingOn`'s grace — a coin toss is never a flash.
	 */
	private noteCoinToss(s: SeatState, frame: ServerFrame): void {
		if (frame.method !== 'updateButtons') return;
		const playOrDraw = frame.label1 === 'Play' && frame.label2 === 'Draw' && frame.enable1 === true && frame.enable2 === true;
		if (playOrDraw) {
			// A series' next game asks the previous game's loser (`MatchSpec.chooser`):
			// nothing was tossed, so no coin is shown — the operator, 2026-10-19: "it
			// should ask the opponent if they want to go first not flip a coin".
			if (this.coinToss !== null || this.spec.chooser !== undefined) return;
			this.coinToss = { winner: s.seat, at: Date.now() };
			this.deps.log({ evt: 'coin-toss', matchId: this.id, winner: s.seat });
			this.deps.seatsChanged?.(this.seatIdentities());
			return;
		}
		if (this.coinToss === null || this.coinToss.winner !== s.seat) return;
		this.coinToss = null;
		this.deps.seatsChanged?.(this.seatIdentities());
	}

	private sendState(s: SeatState, raw: StateFrame): void {
		const projected = s.projector.project(raw) as unknown as ServerFrame;
		s.history.push(projected);
		this.send(s, projected);
		this.releaseLog(s, false);
		if (s === this.watcherSource()) {
			this.sendWatcher(this.watcher.projector.project(raw) as unknown as ServerFrame);
			this.noteLive();
		}
	}

	/**
	 * Tell every seat's projector that `s` was shown `cardIds` — `s`'s own, so it keeps holding them,
	 * and each other seat's, so the owner of a card `s` now knows is told so (`visibility.ts`, "What
	 * the other seats were shown") — and send each seat whatever that changes for it.
	 */
	private learnShown(s: SeatState, cardIds: readonly number[]): void {
		const learner = s.playerId;
		for (const x of this.seats) {
			if (x !== s && (x.playerId === null || learner === null)) continue;
			const frame = (x === s || learner === null ? x.projector.learn(cardIds) : x.projector.learn(cardIds, learner)) as unknown as ServerFrame | null;
			if (frame === null) continue;
			x.history.push(frame);
			this.send(x, frame);
			this.releaseLog(x, false);
		}
	}

	/** The seat whose raw stream feeds the watcher channel: the first human one. */
	private watcherSource(): SeatState | undefined {
		return this.seats.find((s) => !s.ai);
	}

	/** One frame to every watcher, on the watcher channel's own cursor, and kept for the next watcher's snapshot. */
	private sendWatcher(frame: ServerFrame): void {
		this.watcher.history.push(frame);
		this.watcher.seq += 1;
		const cursor: WireCursor = { epoch: this.epoch, seq: this.watcher.seq };
		this.deps.emit(WATCHER_SEAT, { matchId: this.id, cursor, frame });
	}

	/**
	 * The snapshot for a socket with no seat: the watcher channel so far, oriented
	 * as the source seat (`seat`/`playerId` are that seat's, so the board draws it
	 * at the bottom; the client may flip). `match-starting` until that seat's
	 * `openView` has arrived, exactly as {@link Match.snapshot} says it.
	 */
	watcherSnapshot(): MatchSnapshot | { error: string } {
		const source = this.watcherSource();
		if (source === undefined) return { error: 'no-such-seat' };
		if (source.playerId === null) return { error: this.status === 'failed' ? (this.failure ?? 'failed') : 'match-starting' };
		return {
			matchId: this.id,
			seat: source.seat,
			playerId: source.playerId,
			cursor: this.watcher.seq === 0 ? null : { epoch: this.epoch, seq: this.watcher.seq },
			frames: [...this.watcher.history],
		};
	}

	private onLine(line: BridgeLine): void {
		switch (line.t) {
			case 'ready':
				for (const info of line.seats) {
					const s = this.seats[info.seat];
					if (s !== undefined) s.deck = info.deck;
					if (info.removed !== undefined && info.removed.length > 0) {
						this.deps.log({ evt: 'deck-cards-removed', error: 'Forge has no card for these and removes them from the deck', matchId: this.id, seat: info.seat, cards: info.removed });
					}
				}
				this.deps.log({ evt: 'forge-ready', matchId: this.id, bootMs: line.bootMs });
				return;
			case 'frame':
				if (TRACE_FRAMES) this.deps.log({ evt: 'forge-frame', matchId: this.id, seat: line.seat, ...frameGist(line.frame) });
				if (answersAnInput(line.frame)) {
					const answered = this.seats[line.seat];
					if (answered !== undefined) this.endClick(answered, 'answered', line.frame);
					this.disarmActWatch(line.seat);
				}
				if (showsAWindow(line.frame)) {
					const shown = this.seats[line.seat];
					if (shown !== undefined) shown.staleBar = null;
				}
				this.onFrame(line.seat, line.frame);
				return;
			case 'resent':
				this.deps.log({ evt: 'asks-resent', matchId: this.id, seat: line.seat, callIds: line.callIds });
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
				// A game the server already ended has no result: the line was in the pipe when it stopped or failed.
				if (this.status === 'stopped' || this.status === 'failed') {
					this.deps.log({ evt: 'game-over-ignored', matchId: this.id, status: this.status, winner: line.winner });
					return;
				}
				this.status = 'over';
				this.winner = line.winner;
				this.winnerSeat = winnerSeatFromLosers(this.seats, line.losers);
				this.endedAt = this.now();
				this.deps.log({ evt: 'game-over', matchId: this.id, winner: line.winner, losers: line.losers });
				for (const s of this.seats) {
					if (s.ai || s.playerId === null) continue;
					this.finishSeat(s, { kind: 'notify', method: 'finishGame', ...(line.losers === undefined ? {} : { losers: line.losers }), ...(line.lost === undefined ? {} : { lost: line.lost }) } as ServerFrame);
				}
				this.logFrames();
				if (!this.replaying) this.deps.onGameOver?.();
				this.overTimer = setTimeout(() => this.host?.stop(), this.deps.overGraceMs);
				this.overTimer.unref();
				return;
			case 'fatal':
				this.fail(line.message);
				return;
			case 'log':
				this.onGameLog(line);
				return;
			case 'rejected':
			case 'stale':
			case 'pace':
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
		const head = raw as { kind?: unknown; method?: unknown; callId?: unknown } | null;
		const askId = head?.kind === 'ask' && typeof head.callId === 'string' ? head.callId : null;
		if (askId === null && s.pendingReveal !== null) {
			s.behindReveal.push(raw);
			return;
		}
		if (askId !== null) {
			if (s.seenAsks.has(askId)) {
				this.deps.log({ evt: 'ask-duplicate', matchId: this.id, seat, callId: askId, method: head?.method });
				return;
			}
			s.seenAsks.add(askId);
		}
		const parsed = safeParseServerFrame(raw);
		if (!parsed.ok) {
			this.invalidFrames += 1;
			const errors = parsed.errors.slice(0, 5);
			if (askId === null) {
				this.deps.log({ evt: 'frame-invalid', matchId: this.id, seat, method: head?.method, errors });
				return;
			}
			// Never dropped, never aborted: shown as a pick of its whole answers, or
			// left open (`unparsed.ts`).
			const fallback = fallbackFor(raw, askId, (ref) => (ref.kind === 'card' ? cardName(this.foldedStateOf(s), ref.id) : null) ?? `${ref.kind} #${ref.id}`);
			this.deps.log({ evt: 'ask-unparsed', matchId: this.id, seat, callId: askId, method: head?.method, errors, fallback: fallback !== null });
			if (fallback === null) return;
			this.flushPendingWindow(s);
			s.unparsed.set(askId, fallback);
			this.openAskFrame(s, askId, 'getChoices', fallback.frame);
			return;
		}
		const frame = parsed.value;

		// An ask is a different window altogether, so whatever is held was not
		// going to pair. State and actionable-set frames do not flush: a payment
		// always sends `setWeaklySelectable` between its bar and its prompt.
		if (frame.kind === 'ask') this.flushPendingWindow(s);
		// The offered set is part of the window: Forge re-shows a payment as its set, bar and prompt.
		// Its clear is the input stopping, and ends the window.
		if (!['showPromptMessage', 'updateButtons', 'setWeaklySelectable'].includes(frame.method)) s.answeredWindow = null;

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
			// Wave 35 §S, R4 — "Thoughtseize is one step". Full header above
			// `newMatchId`. A REVEAL ({@link asReveal}) is either the discarder's
			// redundant echo of a choice just answered (dropped, unconditionally),
			// or — same as every OTHER reveal — gets Forge's one legal answer,
			// `[]`, AT ONCE: `DiscardEffect`'s own `reveal()` call PARKS Forge's
			// single game thread right here, and it will not even construct
			// whatever comes next until this is answered, so "hold it and see
			// what follows" is not an option the way it is for an ordinary ask.
			// Its `choices` are kept a moment longer, in case the very next ask
			// is the real discard choice they belong to.
			const reveal = asReveal(frame, (ref) => (ref.kind === 'card' ? cardName(this.foldedStateOf(s), ref.id) : null) ?? `${ref.kind} #${ref.id}`);
			// What Forge shows this seat it keeps knowing (`visibility.ts`, "What a seat was shown").
			const shown = reveal !== null ? choiceCardIds(reveal.choices) : 'delayedReveal' in frame ? (frame.delayedReveal?.cards ?? []).map((c) => c.id) : [];
			if (shown.length > 0) this.learnShown(s, shown);
			if (reveal !== null) {
				const ids = choiceCardIds(reveal.choices);
				if (ids.length > 0 && this.justDiscarded !== null && sameCardSet(ids, this.justDiscarded.ids)) {
					clearTimeout(this.justDiscarded.timer);
					this.justDiscarded = null;
					this.autoReply(s, frame.callId, frame.method, 'reveals exactly what a discard choice just took — no confirmation needed (R4)', []);
					return;
				}
				if (s.pendingReveal !== null) {
					// A second reveal arrived before anything claimed the first: it
					// was never going to merge with this one either. Show it rather
					// than drop it — same rule as every other unmerged reveal.
					clearTimeout(s.pendingReveal.timer);
					const orphaned = s.pendingReveal;
					s.pendingReveal = null;
					this.showReveal(s, orphaned.frame);
					this.releaseReveal(s);
				}
				const timer = setTimeout(() => {
					if (s.pendingReveal?.frame !== reveal) return;
					s.pendingReveal = null;
					this.showReveal(s, reveal);
					this.releaseReveal(s);
				}, PENDING_REVEAL_FOLD_MS);
				timer.unref();
				s.pendingReveal = { frame: reveal, timer };
				this.autoReply(s, frame.callId, frame.method, 'a reveal — its one legal answer, held a moment for a possible R4 fold', []);
				return;
			}
			const pending = s.pendingReveal;
			if (pending !== null) {
				clearTimeout(pending.timer);
				s.pendingReveal = null;
				const chooseIds = frame.method === 'getChoices' ? choiceCardIds(frame.choices) : [];
				if (frame.method === 'getChoices' && frame.max === 1 && chooseIds.length > 0 && isCardSubset(chooseIds, choiceCardIds(pending.frame.choices))) {
					// What Forge sent between the reveal and its choice came before the choice.
					this.releaseReveal(s);
					this.openMergedChoice(s, pending.frame, frame);
					return;
				}
				// Not a match: this ask was never the discard choice the held reveal
				// belongs to. Forge already has the reveal's answer (`[]`, sent the
				// instant it arrived); show it to the seat now, unchanged, rather
				// than let it vanish — then `frame` still needs its own ordinary
				// handling below.
				this.showReveal(s, pending.frame);
				this.releaseReveal(s);
			}
			this.openAsk(s, frame);
			return;
		} else if (frame.method === 'showPromptMessage') {
			s.prompt = frame;
			// A taken sacrifice's bar comes straight after its prompt, never after a later one.
			s.pickedSacrifice = false;
			if (frame.message.startsWith('Priority:')) {
				this.choose(s, null);
				s.sameTarget = null;
			}
			// The payment this prompt opens or closes is on record before anything
			// decides on it (Z4: `maybeCancelUnpayable` must see the payment it is
			// cancelling) — independent of whether this half is held or sent.
			this.trackPayment(s, frame.message, frame.card?.id ?? null);
			if (s.heldSacrifice !== null) {
				if (this.maybeOnlySacrifice(s, frame)) return;
				this.releaseHeldSacrifice(s);
			}
			this.holdPromptWindow(s, frame);
			return;
		} else if (frame.method === 'updateButtons') {
			s.buttons = frame;
			if (s.pickedSacrifice) {
				// The bar of the pick the server just answered: dead on the seat's screen, never live.
				s.pickedSacrifice = false;
				if (s.wireButtonsLive) this.send(s, { ...frame, enable1: false, enable2: false, focus1: false });
				this.checkWaitingOn();
				return;
			}
			this.maybeDeclineYieldSuggestion(s);
			this.holdPromptWindow(s, frame);
			// An answer bar (the coin toss, the opening Keep/Mulligan, any other
			// card-scripted binary question) carries no ask, no selection and no
			// payment — this is the only place its own open/close is ever seen.
			this.checkWaitingOn();
			return;
		} else if (frame.method === 'setWeaklySelectable') {
			// A set — even an empty one — is Forge's answer to "what can this seat
			// do". `clearWeaklySelectable` is the absence of one; see `auto.ts`.
			s.actionable = frame.cards.map((c) => c.id);
		} else if (frame.method === 'clearWeaklySelectable') {
			s.actionable = null;
		}
		if (frame.method === 'setSelectables' || frame.method === 'clearSelectables') s.heldSacrifice = null;
		if (frame.method === 'setSelectables' && !s.ai && this.status === 'running' && forcedSet(frame)) {
			// Its prompt decides whether the seat ever sees it (`maybeOnlySacrifice`). Forge is waiting
			// on the seat all the same, so the other seat is told, and a reload is told the set.
			s.heldSacrifice = frame;
			s.selection = frame;
			this.checkWaitingOn();
			return;
		}
		// Kept for a reload (see `SeatState.selection`). Independent of the
		// actionable bookkeeping above, which has its own reader.
		if (frame.method === 'setSelectables') {
			s.selection = frame;
		} else if (frame.method === 'clearSelectables') {
			s.selection = null;
			s.highlighted.clear();
		} else if (frame.method === 'setHighlighted') {
			for (const entity of frame.entities) {
				const key = `${entity.kind}:${entity.id}`;
				if (frame.on) s.highlighted.set(key, entity);
				else s.highlighted.delete(key);
			}
		} else if (frame.method === 'setWeaklySelectable') {
			s.weakly = frame;
		} else if (frame.method === 'clearWeaklySelectable') {
			s.weakly = null;
		} else if (frame.method === 'finishGame') {
			this.finishSeat(s, frame);
			return;
		}
		this.send(s, frame);
		// `setSelectables`/`clearSelectables` can open or close the
		// other seat's `waitingOn` fact too — a selection is a live decision
		// (`myMoveNow`'s own client-side rule, `apps/ui/src/play/live/
		// LiveBoard.tsx`) but never an `OpenAsk`, so nowhere else in this
		// method's tail would catch it.
		if (frame.method === 'setSelectables' || frame.method === 'clearSelectables') this.checkWaitingOn();
	}

	/**
	 * Decide a window before the seat sees it.
	 *
	 * `showPromptMessage` and `updateButtons` are two halves of one Forge
	 * window. Forwarding each as it arrived and deciding afterwards put every
	 * auto-answered window on the wire for the milliseconds between them: a
	 * "Pay Mana Cost" and a "Stack: 1 to Resolve" pop-up drawn and withdrawn on
	 * every Bitterblossom cast. Now the half a decider can read is held until
	 * its partner arrives, the deciders run once on the pair, and both halves
	 * go out or neither does.
	 *
	 * Pairing follows each input's own order (see {@link WindowShape}): a
	 * `Priority:` prompt pairs with the bar that follows it, a payment or
	 * confirm prompt with the bar that preceded it. A newer bar replaces a held
	 * one, because a bar is state and only the latest is ever shown; a newer
	 * prompt never replaces a held one, it pushes the held one out first,
	 * because a prompt is a question. A held half nothing pairs with goes out
	 * undecided after {@link PROMPT_HOLD_FLUSH_MS}, or when an ask arrives.
	 * Whenever both halves go out, they go out as one ({@link sendWindow}).
	 */
	private holdPromptWindow(s: SeatState, frame: PromptFrame | ButtonsFrame): void {
		if (frame.method === 'showPromptMessage') {
			const shape = promptShape(frame);
			this.flushPendingPrompt(s);
			if (shape === 'priority' || shape === 'target') {
				// Any held bar belonged to the input before this one; this prompt's own bar is next.
				s.pendingButtons = null;
				s.pendingPrompt = frame;
				this.armPendingTimer(s);
				return;
			}
			if (shape !== null) {
				const buttons = s.pendingButtons !== null && buttonsShape(s.pendingButtons) === shape ? s.pendingButtons : null;
				s.pendingButtons = null;
				this.clearPendingTimer(s);
				this.decideWindow(s, frame, buttons, 'buttons-first');
				return;
			}
			// No decider reads this prompt, but a held bar is still its own: only a buttons-first input
			// (a confirm, a payment) leaves one parked, and its prompt is what comes next.
			const held = s.pendingButtons;
			s.pendingButtons = null;
			this.clearPendingTimer(s);
			if (held === null) this.send(s, frame);
			else this.forwardUnpaired(s, frame, held, 'buttons-first');
			return;
		}
		if (s.pendingPrompt !== null) {
			if (buttonsShape(frame) === null) {
				const prompt = s.pendingPrompt;
				s.pendingPrompt = null;
				this.clearPendingTimer(s);
				this.decideWindow(s, prompt, frame, 'prompt-first');
				return;
			}
			this.flushPendingPrompt(s);
		}
		if (buttonsShape(frame) !== null) {
			s.pendingButtons = frame;
			this.armPendingTimer(s);
			return;
		}
		s.pendingButtons = null;
		this.clearPendingTimer(s);
		this.send(s, frame);
	}

	private armPendingTimer(s: SeatState): void {
		this.clearPendingTimer(s);
		const timer = setTimeout(() => this.flushPendingWindow(s), PROMPT_HOLD_FLUSH_MS);
		timer.unref();
		s.pendingTimer = timer;
	}

	private clearPendingTimer(s: SeatState): void {
		if (s.pendingTimer === null) return;
		clearTimeout(s.pendingTimer);
		s.pendingTimer = null;
	}

	/**
	 * Run the deciders once on a whole window and send both halves, or neither.
	 *
	 * An answered window is never shown. Its bar is sent only as a disabled
	 * correction, and only when the seat's screen still shows a live bar
	 * ({@link SeatState.wireButtonsLive}): priority coming back to a seat that
	 * never pressed anything leaves the previous window's OK live, and an old
	 * click must not answer whatever Forge has open by the time it lands. When
	 * the bar is already dead (the seat's own press disabled it), nothing is
	 * sent, because a disabled `updateButtons` still marks the browser's input
	 * live and would light the declare-attackers targets for an instant.
	 *
	 * A window left to the seat goes out in the order Forge sent it.
	 */
	private decideWindow(s: SeatState, prompt: PromptFrame, buttons: ButtonsFrame | null, order: 'prompt-first' | 'buttons-first'): void {
		const identity = JSON.stringify([prompt.message, prompt.confirmAbility ?? null, prompt.targetAbility ?? null, buttons?.label1 ?? null, buttons?.label2 ?? null]);
		// At most one decider answers a window: each one that acts sends Forge a press.
		const why =
			s.answeredWindow === identity
				? 'repeat'
				: this.maybeSameTarget(s)
					? 'same-target'
					: this.maybeAutoPass(s)
						? 'auto-pass'
						: this.maybeConfirmChosenCost(s) || this.maybeConfirmFreeSearch(s)
							? 'auto-confirm'
							: this.maybeConfirmChosenTarget(s)
								? 'target-chosen'
								: this.maybeAutoPay(s)
									? 'auto-pay'
									: this.maybeCancelUnpayable(s)
										? 'auto-cancel'
										: 'kept';
		const answered = why !== 'kept';
		s.answeredWindow = answered ? identity : null;
		const kind = readPromptFacts(this.notesOf(s)).window;
		if (answered) {
			const bar = buttons ?? (s.buttons?.method === 'updateButtons' ? s.buttons : null);
			if (s.wireButtonsLive && bar !== null) this.send(s, { ...bar, enable1: false, enable2: false, focus1: false });
		} else if (buttons === null) {
			this.send(s, prompt);
		} else if (order === 'buttons-first') {
			this.sendWindow(s, buttons, prompt);
		} else {
			this.sendWindow(s, prompt, buttons);
		}
		// A kept window names the rule that kept it (`maybeAutoPass` ran on it: every decider did),
		// and for `has-play` the cards, by the names this seat sees, so the log answers "why here?".
		const plays = answered || s.lastStop === null || !('plays' in s.lastStop) ? undefined : s.lastStop.plays;
		const kept =
			answered || s.lastStop === null
				? {}
				: { rule: s.lastStop.rule, ...(plays === undefined ? {} : { plays: plays.map((id) => ({ id, name: cardName(this.foldedStateOf(s), id) })) }) };
		this.deps.log({ evt: answered ? 'prompt-withheld' : 'prompt-forwarded', matchId: this.id, seat: s.seat, kind, why, ...kept });
		if (!answered) this.logOffered(s, kind);
		this.recordWindow(s, answered ? 'withheld' : 'forwarded', kind, why, prompt, buttons);
		// The one place a HELD buttons-first or prompt-first pair is finally
		// sent (or disabled) — `wireButtonsLive` only reaches its real, final
		// value once this runs, so this is where the other seat's own fact
		// has to be re-checked too.
		this.checkWaitingOn();
	}

	/**
	 * The `offered` record: the cards Forge offers a seat (its last `setWeaklySelectable`, [] after a
	 * clear) at a priority or payment window the seat is shown — logged only when the set differs
	 * from the one last logged for that seat, so a quiet turn costs nothing.
	 */
	private logOffered(s: SeatState, kind: string): void {
		if (kind !== 'priority' && kind !== 'payment') return;
		const cards = [...(s.actionable ?? [])].sort((x, y) => x - y);
		const key = cards.join(',');
		if (key === s.offeredLogged) return;
		s.offeredLogged = key;
		this.deps.log({ evt: 'offered', matchId: this.id, seat: s.seat, kind, cards });
	}

	/** A held prompt pushed out by a newer frame before its bar came: forwarded undecided, never lost. */
	private flushPendingPrompt(s: SeatState): void {
		const prompt = s.pendingPrompt;
		if (prompt === null) return;
		s.pendingPrompt = null;
		this.clearPendingTimer(s);
		this.forwardUnpaired(s, prompt, null);
	}

	/** Whatever is held, forwarded undecided: the safety flush, an ask, or a prompt no decider reads. */
	private flushPendingWindow(s: SeatState): void {
		const prompt = s.pendingPrompt;
		const buttons = s.pendingButtons;
		s.pendingPrompt = null;
		s.pendingButtons = null;
		this.clearPendingTimer(s);
		if (prompt === null && buttons === null) return;
		this.forwardUnpaired(s, prompt, buttons);
	}

	private forwardUnpaired(s: SeatState, prompt: PromptFrame | null, buttons: ButtonsFrame | null, order: 'prompt-first' | 'buttons-first' = 'prompt-first'): void {
		if (prompt !== null && buttons !== null) {
			if (order === 'buttons-first') this.sendWindow(s, buttons, prompt);
			else this.sendWindow(s, prompt, buttons);
		} else if (prompt !== null) this.send(s, prompt);
		else if (buttons !== null) this.send(s, buttons);
		const kind = readPromptFacts(this.notesOf(s)).window;
		this.deps.log({ evt: 'prompt-forwarded', matchId: this.id, seat: s.seat, kind, why: 'unpaired' });
		this.logOffered(s, kind);
		this.recordWindow(s, 'forwarded', kind, 'unpaired', prompt, buttons);
		this.checkWaitingOn();
	}

	/** One row of the ring — see {@link FrameLogEntry}. */
	private recordWindow(
		s: SeatState,
		decision: 'forwarded' | 'withheld',
		kind: StopWindow,
		why: string,
		prompt: PromptFrame | null,
		buttons: ButtonsFrame | null,
	): void {
		const message = prompt?.message ?? null;
		const bar = buttons === null ? null : { label1: buttons.label1, enable1: buttons.enable1, label2: buttons.label2, enable2: buttons.enable2 };
		this.framesRing.push({ t: this.now(), seat: s.seat, kind, decision, why, message, buttons: bar });
		if (this.framesRing.length > FRAMES_RING_SIZE) this.framesRing.shift();
	}

	/**
	 * The telemetry ring, once, on match end. `deps.log` already carries every
	 * decision as it happens; this is the same record with the message and the
	 * bar, kept for the whole match (bounded by {@link FRAMES_RING_SIZE}) so a
	 * report can be replayed without having watched the log at the right second.
	 */
	private logFrames(): void {
		if (this.framesLogged) return;
		this.framesLogged = true;
		if (this.framesRing.length === 0) return;
		this.deps.log({ evt: 'match-frames', matchId: this.id, frames: this.framesRing });
	}

	/* ── Wave 19 lane C ─────────────────────────────────────────────── */

	/**
	 * The escape hatch. Off by default; while it is on this seat passes no stop
	 * for itself, pays nothing for itself, and orders its own simultaneous
	 * triggers. A question with one answer is still answered for it.
	 */
	setFullControl(seat: number, on: boolean): ClientOutcome {
		const s = this.seats[seat];
		if (s === undefined || s.ai) return { ok: false, error: 'no-such-seat' };
		if (s.fullControl === on) return { ok: true };
		s.fullControl = on;
		this.deps.log({ evt: 'full-control', matchId: this.id, seat, on });
		this.say(s, on ? 'full control on' : 'full control off');
		return { ok: true };
	}

	fullControl(seat: number): boolean {
		return this.seats[seat]?.fullControl ?? false;
	}

	/**
	 * Remember (`ACCEPT`/`DECLINE`) or forget (`ASK`) this seat's answer to one
	 * optional trigger, in Forge: the bridge writes it into the seat's
	 * `YieldController`, and `confirmTrigger` answers from it instead of asking.
	 * The key must be one this seat was asked about — the open confirm's own
	 * trigger — or one it already remembers, so a seat cannot plant a key it
	 * was never shown.
	 */
	setTriggerDecision(seat: number, key: string, decision: TriggerDecision): ClientOutcome {
		const s = this.seats[seat];
		if (s === undefined || s.ai) return { ok: false, error: 'no-such-seat' };
		if (this.status !== 'running') return { ok: false, error: `match is ${this.status}` };
		const asked = s.prompt?.method === 'showPromptMessage' ? s.prompt.confirmAbility?.trigger : undefined;
		const name = asked?.key === key ? asked.name : s.triggerDecisions.get(key)?.name;
		if (name === undefined) return { ok: false, error: 'not a trigger this seat was asked about' };
		if (decision === 'ASK') s.triggerDecisions.delete(key);
		else s.triggerDecisions.set(key, { key, name, decision });
		this.deps.log({ evt: 'trigger-decision', matchId: this.id, seat, name, decision });
		this.command({ t: 'act', seat, frame: { kind: 'act', method: 'sendYieldUpdate', update: { update: 'triggerDecision', storageKey: key, decision } } });
		return { ok: true };
	}

	triggerDecisions(seat: number): RememberedTrigger[] {
		return [...(this.seats[seat]?.triggerDecisions.values() ?? [])];
	}

	/**
	 * Sets {@link SeatState.autoYield} to the seat's CURRENT turn number —
	 * `s.projector.turnNumber()`, never this seat's own last prompt text,
	 * which can still be last turn's if the seat has not been prompted yet
	 * this turn. If a window is already open when this turns on, re-judge it
	 * at once rather than waiting for the next one.
	 */
	setAutoYield(seat: number, on: boolean): ClientOutcome {
		const s = this.seats[seat];
		if (s === undefined || s.ai) return { ok: false, error: 'no-such-seat' };
		s.autoYield = { turn: s.projector.turnNumber() ?? 0, on };
		this.deps.log({ evt: 'auto-yield', matchId: this.id, seat, on, turn: s.autoYield.turn });
		const wasLive = s.wireButtonsLive;
		if (on && this.maybeAutoPass(s) && wasLive && s.buttons !== null && s.buttons.method === 'updateButtons') {
			// The seat's own browser still shows the bar this just passed for it —
			// the same disabled correction `decideWindow` sends an answered window.
			this.send(s, { ...s.buttons, enable1: false, enable2: false, focus1: false });
		}
		return { ok: true };
	}

	/**
	 * Hold this seat's priority at the next occurrence of `phase`, on either
	 * player's turn, once — or, with null, drop the stop it has. Set while the game
	 * is in `phase` (any combat step, for `COMBAT`), it is for the next occurrence.
	 * Untap and Cleanup are not stops (`StopPhaseSchema`): Forge opens no window
	 * there to hold.
	 */
	setPhaseStop(seat: number, phase: StopPhase | null): ClientOutcome {
		const s = this.seats[seat];
		if (s === undefined || s.ai) return { ok: false, error: 'no-such-seat' };
		const was = s.phaseStop?.phase ?? null;
		if (phase === was) return { ok: true };
		const turn = s.projector.turnNumber();
		if (phase === null) {
			s.phaseStop = null;
			this.deps.log({ evt: 'stop-cleared', matchId: this.id, seat, phase: was, why: 'player' });
		} else {
			const now = s.projector.phase();
			s.phaseStop = { phase, skipTurn: now !== null && stopCovers(phase, now) ? turn : null };
			this.deps.log({ evt: 'stop-set', matchId: this.id, seat, phase, turn, now, ...(was === null ? {} : { replaced: was }) });
		}
		this.deps.phaseStopChanged?.(seat, phase);
		return { ok: true };
	}

	phaseStop(seat: number): StopPhase | null {
		return this.seats[seat]?.phaseStop?.phase ?? null;
	}

	/**
	 * Whether this seat's stop keeps the priority window in `facts`: the first one
	 * at the stop's step (`stopAt`) spends the stop, and every later one in that
	 * same occurrence of the step is kept too, as full control would keep it. A
	 * window later in the stop's occurrence than its step — a combat nobody
	 * attacked in, on the opponent's turn — spends it unheld.
	 */
	private stopHolds(s: SeatState, facts: PromptFacts): boolean {
		if (facts.window !== 'priority' || !facts.mine || !facts.confirmLive || facts.phase === null) return false;
		const turn = s.projector.turnNumber();
		if (s.stopHeld !== null) {
			if (s.stopHeld.turn === turn && s.stopHeld.phase === facts.phase) return true;
			s.stopHeld = null;
		}
		const stop = s.phaseStop;
		if (stop === null || (stop.skipTurn !== null && stop.skipTurn === turn)) return false;
		const at = stopAt(stop.phase, facts.myTurn, facts.phase);
		if (at === 'wait') return false;
		s.phaseStop = null;
		this.deps.phaseStopChanged?.(s.seat, null);
		if (at === 'missed') {
			this.deps.log({ evt: 'stop-cleared', matchId: this.id, seat: s.seat, phase: stop.phase, why: 'missed', at: facts.phase, turn, myTurn: facts.myTurn });
			return false;
		}
		s.stopHeld = { turn, phase: facts.phase };
		this.deps.log({ evt: 'stop-fired', matchId: this.id, seat: s.seat, phase: stop.phase, at: facts.phase, turn, myTurn: facts.myTurn });
		return true;
	}

	/**
	 * Give ONE seat its own stop preferences (wave 26 §E).
	 *
	 * A policy is a value (`auto.ts`), so this is an assignment and nothing more —
	 * the decisions read {@link SeatState.policy} at the moment the window opens,
	 * so a policy set mid-match applies to the next window and never retracts a
	 * press already made. Nothing is `say`-ed: a preference is not something Forge
	 * told the seat, and the log is where a shortcut nobody expected is diagnosed.
	 *
	 * There is no wire message that carries one yet, so the callers today are
	 * tests. `setFullControl` stays the escape hatch and is deliberately NOT
	 * expressed through this: it short-circuits before the policy is read.
	 */
	setStopPolicy(seat: number, policy: StopPolicy): ClientOutcome {
		const s = this.seats[seat];
		if (s === undefined || s.ai) return { ok: false, error: 'no-such-seat' };
		s.policy = policy;
		this.deps.log({
			evt: 'stop-policy',
			matchId: this.id,
			seat,
			unambiguousPayment: policy.unambiguousPayment,
			unpayableCost: policy.unpayableCost,
			skipNonStopPhases: policy.skipNonStopPhases,
		});
		return { ok: true };
	}

	/** This seat's stop preferences, as the shortcut decisions read them. */
	stopPolicy(seat: number): StopPolicy {
		return this.seats[seat]?.policy ?? DEFAULT_STOP_POLICY;
	}

	/**
	 * One observable line to a seat. **A synthesised Forge frame** — nothing
	 * downstream can tell it from one Forge sent — so a line added here is a line
	 * every client folds. `log` marks a line of Forge's own game log
	 * ({@link Match.onGameLog}); the one line without it is the seat's own
	 * `full control on`/`off`.
	 */
	private say(s: SeatState, message: string, log?: GameLogLine): void {
		const frame = { kind: 'notify', method: 'message', message, title: '', ...(log === undefined ? {} : { log }) } as unknown as ServerFrame;
		s.says.push(frame);
		if (s.says.length > SAYS_KEPT) s.says.shift();
		this.send(s, frame);
	}

	/**
	 * One entry of Forge's own game log, to every seat, in the words the bridge
	 * chose for that seat's player (`PlayBridge.GameLogForward`).
	 *
	 * The operator, 2026-10-12: *"the log still sucks. there are tons of game
	 * actions it still doesn't track."* The log was this repo's own lines — what a
	 * payment tapped, a trigger arriving on the stack, a client-side `played …` —
	 * re-derived from state, and nothing else. Forge already writes the whole
	 * game's log (`GameLog`, the panel of its own desktop client); the bridge
	 * forwards each entry as it is written.
	 *
	 * **Hidden information is settled in the bridge, not here**: it holds the live
	 * game, checks every card a line names against Forge's own `canBeShownTo` for
	 * each player at the moment the line was written, and sends each player their
	 * own wording (`text: null` when a line cannot be worded for them). This only
	 * hands each seat the copy meant for its player.
	 */
	private onGameLog(line: Extract<BridgeLine, { t: 'log' }>): void {
		for (const s of this.seats) {
			if (s.ai || s.playerId === null) continue;
			const mine = line.players.find((p) => p.player === s.playerId);
			if (mine === undefined || mine.text === null || mine.text === '') continue;
			s.heldLog.push({ text: mine.text, log: { type: line.type, cards: mine.cards } });
			this.releaseLog(s, false);
			if (s.heldLog.length > 0 && s.heldLogTimer === null) {
				const timer = setTimeout(() => {
					s.heldLogTimer = null;
					if (this.status === 'running' || this.status === 'over') this.releaseLog(s, true);
				}, LOG_HOLD_MAX_MS);
				timer.unref();
				s.heldLogTimer = timer;
			}
		}
	}

	/**
	 * Send this seat's held log lines, oldest first, up to the first that names a
	 * card its board does not show yet (all of them when `all`).
	 *
	 * Forge writes a log entry while it acts, and the delta that shows the act is
	 * sent after: a cast's `STACK_ADD` is written as the spell joins the stack,
	 * and the delta that puts it there reaches the other seat only once
	 * `playAbility` has committed (`cast-hidden.jvm.test.ts`). Sent as it came,
	 * the line named the card on the opponent's screen before its board did.
	 */
	private releaseLog(s: SeatState, all: boolean): void {
		// What Forge wrote after a held reveal waits for it too, like every frame behind it.
		if (!all && s.pendingReveal !== null) return;
		while (s.heldLog.length > 0) {
			const next = s.heldLog[0]!;
			if (!all && next.log.cards.some((c) => s.projector.visibilityOf(c.id) === 'hidden')) break;
			s.heldLog.shift();
			this.say(s, next.text, next.log);
		}
		if (s.heldLog.length === 0 && s.heldLogTimer !== null) {
			clearTimeout(s.heldLogTimer);
			s.heldLogTimer = null;
		}
	}

	/** What this seat was last told, as the stop decisions read it (`auto.ts`). */
	private notesOf(s: SeatState): SeatNotes {
		const stackTopActivator = s.projector.stackTopActivator();
		const ownSpell = s.playerId !== null && stackTopActivator === s.playerId;
		return {
			playerId: s.playerId,
			prompt: s.prompt,
			buttons: s.buttons,
			actionable: s.actionable,
			openAsks: s.asks.size,
			creatures: s.projector.creatureCount(),
			stackTopActivator,
			// Read only for the seat's own spell (`StopPolicy.holdForSpellCopy`).
			...(ownSpell ? { stackTopTypes: s.projector.stackTopSpellTypes(), spellCopiers: this.spellCopiersOffered(s) } : {}),
			// The bridge's facts about the set `actionable` holds (wave 52 §S).
			...(s.actionable !== null && s.weakly?.method === 'setWeaklySelectable'
				? {
						manaOnlyIds: s.weakly.manaOnly === undefined ? undefined : new Set(s.weakly.manaOnly.map((c) => c.id)),
						phaseRestrictedIds: s.weakly.phaseRestricted?.map((c) => c.id),
						animatesIds: s.weakly.animates?.map((c) => c.id),
						...(s.weakly.attackers === undefined ? {} : { attackers: s.weakly.attackers }),
					}
				: {}),
		};
	}

	/**
	 * The seat's offered cards that copy spells from where each sits: a copy made by
	 * casting counts off the battlefield, one made by activating counts on it, and a
	 * card whose zone is unknown keeps both (a doubt keeps the stop).
	 */
	private spellCopiersOffered(s: SeatState): ReadonlyMap<number, readonly SpellCopy[]> {
		const out = new Map<number, readonly SpellCopy[]>();
		const index = this.deps.spellCopiers;
		if (index === undefined || s.actionable === null) return out;
		for (const id of new Set(s.actionable)) {
			const { name, zone } = s.projector.cardAt(id);
			const copies = name === null ? undefined : index(name)?.filter((c) => zone === null || (c.via === 'activate') === (zone === 'Battlefield'));
			if (copies !== undefined && copies.length > 0) out.set(id, copies);
		}
		return out;
	}

	/**
	 * Wave 64 (S5) — the ONE guard every auto-decision gate used to repeat for
	 * itself: `maybeAutoPass`, `maybeAutoPay`, `maybeCancelUnpayable` and
	 * `maybeConfirmChosenCost` each re-checked `s.fullControl || s.ai ||
	 * this.status !== 'running'` and each turned `this.notesOf(s)` into a fresh
	 * `PromptFacts` through its own call to `readPromptFacts` (two of them by
	 * way of a one-line wrapper in `auto.ts` — `autoPassReason` /
	 * `autoPayReason` / `autoCancelReason`, deleted with this change), so the
	 * same window's prompt and buttons were read and re-parsed once per gate
	 * that happened to run this tick. The guard and the read both belong here
	 * exactly once; every gate below takes the result and asks ONE of
	 * `decideStop`, `decidePay` or `decideCancel` of it.
	 *
	 * Null means "not this gate's seat to decide for" — full control is on, the
	 * seat is an AI, or the match is not running — and every caller's own no-op
	 * is that null.
	 */
	private autoGateFacts(s: SeatState): { notes: SeatNotes; facts: PromptFacts } | null {
		return s.fullControl ? null : this.answerGateFacts(s);
	}

	/**
	 * {@link autoGateFacts} for the confirms that ask nothing the seat has not
	 * already answered — the cost of the ability it chose, its own target's "may",
	 * a search of its own hand — which full control leaves to the server too:
	 * full control is every stop and every real choice, never a question with one
	 * answer (the operator, 2026-10-19). `notes` rides along because those
	 * deciders read it directly rather than through `PromptFacts`.
	 */
	private answerGateFacts(s: SeatState): { notes: SeatNotes; facts: PromptFacts } | null {
		if (s.ai || this.status !== 'running') return null;
		const notes = this.notesOf(s);
		return { notes, facts: readPromptFacts(notes) };
	}

	/**
	 * Wave 35 §S item 2 — the swallowed first OK press, chased to its cause.
	 *
	 * `InputPassPriority.showMessage` (`forge-gui/.../InputPassPriority.java`)
	 * does not always show the normal "Priority: …" prompt: when the seat has
	 * no available action, it can show a YIELD SUGGESTION instead — Forge's
	 * own "You have no available actions. Yield until your turn?" /
	 * "You cannot respond to the stack. Yield until stack clears?" — with
	 * buttons labelled **"Accept"/"Decline"**, not "OK"/"End Turn"
	 * (`en-US.properties`: `lblAccept`, `lblDecline`). Button 1 is still wired
	 * to the SAME `selectButtonOk` act, but `InputPassPriority.onOk()` branches
	 * on its own `pendingSuggestion` field: while a suggestion is pending,
	 * pressing button 1 does not pass priority at all — it records the
	 * suggestion's accept/decline bookkeeping and then calls `showNormalPrompt()`
	 * AGAIN, re-showing the real "Priority: …" / "OK"/"End Turn" prompt without
	 * ever calling `stop()`. A seat that presses "OK" meaning "pass priority" —
	 * because, in every ordinary window, OK always means that — spends that
	 * press on a question it never knew it was being asked, and the window
	 * looks exactly as it did: `scenario-ability-repeat.jvm.test.ts`'s Ponder
	 * case measured this directly (5 of 10 runs stuck at "Stack: 1 to Resolve"
	 * after one press, every one unstuck by a second). `maybeAutoPass`'s own
	 * window classification cannot catch this upstream: the suggestion's
	 * prompt text never matches `^Priority: ` (`auto.ts`'s `PRIORITY` regex),
	 * so `readPromptFacts` already calls it `'other'` and refuses to press
	 * anything there — this is a DIFFERENT button bar, not a misclassified one.
	 *
	 * The fix: decline it, unconditionally and the instant it appears, before
	 * either a human or a script can ever see it. **Not gated on
	 * `s.fullControl`** — unlike every other shortcut in this file, this one
	 * is not "an answer with fewer than two options" or "a stop with nothing to
	 * do"; it is Forge SILENTLY reinterpreting the next ordinary press as an
	 * answer to a question nobody asked for. Declining is the policy-neutral
	 * choice regardless: it leaves the seat exactly where "ask me every time"
	 * (full control's own default) already puts it — Forge's own
	 * `onCancel()` branch for a pending suggestion calls `declineSuggestion`
	 * and then `showNormalPrompt()`, the SAME re-show `onOk()`'s accept branch
	 * reaches — so nothing about the real decision changes, only the
	 * confusing extra button bar never reaches the wire's `updateButtons`
	 * consumer disguised as an ordinary one.
	 */
	private maybeDeclineYieldSuggestion(s: SeatState): void {
		if (s.ai || this.status !== 'running') return;
		const buttons = s.buttons;
		if (buttons === null || buttons.method !== 'updateButtons') return;
		if (buttons.label1 !== YIELD_ACCEPT_LABEL || buttons.label2 !== YIELD_DECLINE_LABEL) return;
		if (!buttons.enable2) return;
		this.deps.log({ evt: 'yield-suggestion-declined', matchId: this.id, seat: s.seat });
		this.command({ t: 'act', seat: s.seat, frame: { kind: 'act', method: 'selectButtonCancel' } });
	}

	/**
	 * Wave 35 §S follow-up, item 3 — Q17's "transient-stack race"
	 * (`w33.spec.ts`), diagnosed past the `maybeAutoPass` ordering fix above
	 * (which closes a DIFFERENT gap and was not, on its own, enough — measured
	 * directly: the race still reproduced 1/1 with only that fix in place).
	 *
	 * The actual mechanism: Forge tells the client the STACK changed (an
	 * `applyDelta` carrying the new zone) before it tells the client anything
	 * about the NEXT priority window's buttons — that only arrives once
	 * `InputPassPriority` runs again, a separate, later step. So the instant a
	 * seat plays a card, the board can already show it on the stack while the
	 * buttons still read whatever `updateButtons` last said — which, for an
	 * `own main phase` stop, is a REAL, correctly-enabled OK (wave 20 #7's
	 * carve-out: that phase is always a stop). Nothing was wrong with that
	 * frame when it arrived; it is just stale the moment this seat acts on it.
	 *
	 * The fix: the instant this seat's own act is forwarded, whatever buttons
	 * it was just shown are no longer trustworthy — Forge has not spoken since
	 * — so they are disabled here, locally, before the act even reaches the
	 * bridge. Forge's own next `updateButtons` (whatever it says) overwrites
	 * this the moment it arrives, same as any other frame.
	 */
	private disableStaleButtons(s: SeatState): void {
		const buttons = s.buttons;
		if (buttons === null || buttons.method !== 'updateButtons') return;
		if (!buttons.enable1 && !buttons.enable2) return;
		const disabled = { ...buttons, enable1: false, enable2: false, focus1: false };
		s.staleBar = buttons;
		s.buttons = disabled;
		this.send(s, disabled);
		// An answer bar (the coin toss, the opening Keep/Mulligan, …) is
		// disabled here the instant the seat presses it — the one path that
		// changes `s.buttons` outside `onFrame`'s own tail.
		this.checkWaitingOn();
	}

	/**
	 * Pass a stop the seat cannot act in — **silently**.
	 *
	 * Wave 25 §D, item 3. This used to `say` `auto-passed <phase>`, and the
	 * operator's verdict on the corner box that carried it, 2026-09-27, was *"i
	 * mostly hate all the text in the bottom right it's totally useless"*. The line
	 * was ours, not Forge's — `say` fabricates a Forge frame — and the phase it
	 * named is on the turn bar and the phase rail already, so it told the seat
	 * nothing the board was not showing. The LOG entry stays: that is where a pass
	 * nobody expected gets diagnosed, and it costs the player nothing.
	 *
	 * Returns whether it passed — wave 35 §S follow-up, item 3: the caller uses
	 * this to suppress the `updateButtons` frame that would otherwise show the
	 * player a stop they were never actually given (Q17's transient-stack race).
	 */
	private maybeAutoPass(s: SeatState): boolean {
		// The prompt in hand was already passed on, so these buttons belong to the input
		// AFTER it (see `SeatState.passedOn`): not ours to press for.
		s.lastStop = null;
		if (s.prompt !== null && s.prompt === s.passedOn) {
			s.lastStop = { rule: 'passed-on' };
			return false;
		}
		if (s.ai || this.status !== 'running') {
			s.lastStop = { rule: 'gated' };
			return false;
		}
		const facts = readPromptFacts(this.notesOf(s));
		/*
		 * The auto-yield override: every priority window on the OTHER seat's turn
		 * is passed — a stack with their spell on it included, the window already
		 * open when it was pressed included — on `decideStop`'s own entry guards.
		 * Declare Blockers' block-assignment ask is never `window === 'priority'`,
		 * so it is untouched regardless.
		 *
		 * It outranks full control: pressing Auto Yield is the seat saying so for
		 * this turn, and full control is a standing "ask me". The operator,
		 * 2026-10-14, in full control with a stack item held: *"auto-yield should
		 * work even for things already on the stack."*
		 */
		const yieldsNow =
			s.autoYield !== null &&
			s.autoYield.on &&
			s.autoYield.turn === s.projector.turnNumber() &&
			facts.window === 'priority' &&
			facts.mine &&
			facts.confirmLive &&
			facts.openAsks === 0 &&
			!facts.myTurn;
		if (s.fullControl && !yieldsNow) {
			s.lastStop = { rule: 'gated' };
			return false;
		}
		// The seat's own stop outranks every shortcut below, the yield included.
		if (this.stopHolds(s, facts)) {
			s.lastStop = { rule: 'stop-at' };
			return false;
		}
		const judged = yieldsNow ? null : judgeStop(facts, s.policy);
		const phase = judged === null ? (facts.phaseLabel ?? 'priority') : judged.pass;
		s.lastStop = judged === null ? { rule: 'auto-yield' } : { rule: judged.rule, ...(judged.plays === undefined ? {} : { plays: judged.plays }) };
		/*
		 * Behind `CARDTABLE_PLAY_PROBE=1` (the e2e harness's servers): every
		 * decision, kept or passed, with the facts it was made on. 2026-10-03's
		 * three CI-only reds each ended on a first priority prompt the server
		 * never answered, and the log had only the passes — a stop that was
		 * KEPT left no line, so which fact kept it could not be read.
		 */
		if (TRACE_STOPS) {
			this.deps.log({
				evt: 'stop-decided',
				matchId: this.id,
				seat: s.seat,
				decision: phase ?? 'kept',
				rule: s.lastStop.rule,
				window: facts.window,
				phase: facts.phase,
				myTurn: facts.myTurn,
				stackEmpty: facts.stackEmpty,
				mine: facts.mine,
				sources: facts.sources?.length ?? null,
				nonManaSources: facts.nonManaSources?.length ?? null,
				phaseRestricted: facts.phaseRestricted.length,
				animates: facts.animates.length,
				attackers: facts.attackers,
				openAsks: facts.openAsks,
				buttons: s.buttons !== null && s.buttons.method === 'updateButtons' ? [s.buttons.enable1, s.buttons.enable2] : null,
			});
		}
		if (phase === null) return false;
		s.passedOn = s.prompt;
		s.autoPassed += 1;
		// Forge clears the set as the input stops; drop ours with it so the next
		// stop is judged on the next answer rather than on this one.
		s.actionable = null;
		this.deps.log({ evt: 'auto-passed', matchId: this.id, seat: s.seat, phase, rule: s.lastStop.rule, ...(yieldsNow ? { why: 'auto-yield' } : {}) });
		this.command({ t: 'act', seat: s.seat, frame: { kind: 'act', method: 'selectButtonOk' } });
		return true;
	}

	/**
	 * Press Forge's own Auto for a payment with one source — and say nothing
	 * extra: `trackPayment` already says what was paid and what tapped, which is
	 * the whole record either way (#8).
	 *
	 * Only for a payment that follows this seat's own cast or activation
	 * (`Payment.own`): an "unless pays" cost another player's spell puts on it, a
	 * trigger's "you may pay" or a ward cost is shown to the seat with Forge's own
	 * pay and Cancel, never paid for it (`auto.ts`'s `decidePay`).
	 *
	 * The payment that CANNOT be made is the same shape and is answered here too,
	 * with the other button (item 7).
	 */
	/** Returns whether it pressed Auto for this cost just now, so the caller can withhold the prompt (Z4). */
	private maybeAutoPay(s: SeatState): boolean {
		const gate = this.autoGateFacts(s);
		if (gate === null) return false;
		const cost = s.payment?.own === true ? decidePay(gate.facts, s.policy) : null;
		if (cost === null) {
			// The payment ended (or never started); the next one earns its press.
			if (s.payment === null) s.autoPaid = null;
			return false;
		}
		if (s.autoPaid === cost) return false;
		s.autoPaid = cost;
		this.deps.log({ evt: 'auto-paid', matchId: this.id, seat: s.seat, cost });
		this.command({ t: 'act', seat: s.seat, frame: { kind: 'act', method: 'selectButtonOk' } });
		return true;
	}

	/**
	 * Take the only legal sacrifice for the seat ({@link onlySacrifice}): the held set and its
	 * prompt never reach the seat's screen, and the bar Forge sends with them goes out dead.
	 * Under full control too: full control is every real choice, never a question with one answer.
	 * Returns whether it picked.
	 */
	private maybeOnlySacrifice(s: SeatState, prompt: PromptFrame): boolean {
		const gate = this.answerGateFacts(s);
		// Forge asks to show the selection's zones (`tempShowZones`) alongside it, and the seat's
		// screen answers that whenever it gets to it: it is part of this pick, not another question.
		const others = [...s.asks.values()].filter((a) => a.method !== 'tempShowZones').length;
		const act = gate === null ? null : onlySacrifice({ ...gate.notes, openAsks: others }, s.heldSacrifice);
		if (act === null || act.method !== 'selectCard') return false;
		s.heldSacrifice = null;
		s.pickedSacrifice = true;
		// A held half from the input before this one is not this pick's.
		this.flushPendingWindow(s);
		const cards = [act.card, ...act.otherCardViewsToSelect].map((c) => ({ id: c.id, name: cardName(this.foldedStateOf(s), c.id) }));
		this.deps.log({ evt: 'auto-picked', matchId: this.id, seat: s.seat, why: ONLY_SACRIFICE, cards });
		this.recordWindow(s, 'withheld', 'other', 'only-sacrifice', prompt, null);
		this.command({ t: 'act', seat: s.seat, frame: act });
		return true;
	}

	/** The held set, on the seat's wire after all: its prompt left the pick to the seat. */
	private releaseHeldSacrifice(s: SeatState): void {
		const held = s.heldSacrifice;
		if (held === null) return;
		s.heldSacrifice = null;
		this.send(s, held);
		this.checkWaitingOn();
	}

	/**
	 * A seat's pick on a trigger's target selection: the ability's target is chosen (its "may" is
	 * answered by that), and with `sameTarget` the identical triggers still waiting take it too.
	 */
	private noteTargetPick(s: SeatState, frame: ClientFrame): void {
		const picked = pickedBy(frame);
		const asked = targetAbilityOf(s.prompt);
		if (picked === null || asked === null) return;
		s.chosenTargets.add(asked.abilityId);
		const same = frame.kind === 'act' && (frame.method === 'selectPlayer' || frame.method === 'selectCard') && frame.sameTarget === true;
		s.sameTarget = same && asked.more > 0 ? { trigger: asked.trigger, target: picked } : null;
	}

	/**
	 * The next identical trigger's target, answered from the seat's "same target for all" — under
	 * Full Control too: the seat said so for exactly these. Returns whether it answered.
	 */
	private maybeSameTarget(s: SeatState): boolean {
		if (s.ai || this.status !== 'running') return false;
		const act = sameTargetAct(s.prompt, s.selection, s.sameTarget);
		const asked = targetAbilityOf(s.prompt);
		if (act === null || asked === null) return false;
		s.chosenTargets.add(asked.abilityId);
		this.deps.log({ evt: 'same-target', matchId: this.id, seat: s.seat, trigger: asked.trigger, target: s.sameTarget?.target, more: asked.more });
		this.command({ t: 'act', seat: s.seat, frame: act });
		return true;
	}

	/** Yes to "Do you want to …?" for an ability whose target this seat chose. Returns whether it answered. */
	/** The ability the seat chose (or none), with no cost confirm of it answered yet. */
	private choose(s: SeatState, ability: { hostCard: number; abilityId: number } | null): void {
		s.chosenAbility = ability;
		s.confirmedCosts = new Set();
	}

	private maybeConfirmChosenTarget(s: SeatState): boolean {
		const gate = this.answerGateFacts(s);
		if (gate === null) return false;
		const abilityId = chosenTargetConfirm(gate.notes, s.chosenTargets);
		if (abilityId === null) return false;
		s.chosenTargets.delete(abilityId);
		this.deps.log({ evt: 'auto-confirmed', matchId: this.id, seat: s.seat, why: 'the seat chose its target' });
		this.command({ t: 'act', seat: s.seat, frame: { kind: 'act', method: 'selectButtonOk' } });
		return true;
	}

	/**
	 * Wave 52 §S B — answer Yes to a cost confirm for the ability this seat just
	 * chose (*"it AGAIN asks me if i want to sacrifice the augur of skulls. thats a
	 * redundant ask."*). Once per question of that choice ({@link SeatState.confirmedCosts}).
	 * Returns whether it answered, so the caller withholds the prompt.
	 */
	private maybeConfirmChosenCost(s: SeatState): boolean {
		const gate = this.answerGateFacts(s);
		if (gate === null) return false;
		const why = chosenCostConfirm(gate.notes, s.chosenAbility);
		const question = gate.notes.prompt?.method === 'showPromptMessage' ? gate.notes.prompt.message : null;
		if (why === null || question === null || s.confirmedCosts.has(question)) return false;
		s.confirmedCosts.add(question);
		this.deps.log({ evt: 'auto-confirmed', matchId: this.id, seat: s.seat, why });
		this.command({ t: 'act', seat: s.seat, frame: { kind: 'act', method: 'selectButtonOk' } });
		return true;
	}

	/**
	 * Yes to an optional search of the seat's own hand ({@link freeSearchConfirm}): the card
	 * choice that follows is where the seat says yes or no. Returns whether it answered, so the
	 * caller withholds the prompt.
	 */
	private maybeConfirmFreeSearch(s: SeatState): boolean {
		const gate = this.answerGateFacts(s);
		if (gate === null) return false;
		const why = freeSearchConfirm(gate.notes);
		if (why === null) return false;
		this.deps.log({ evt: 'auto-confirmed', matchId: this.id, seat: s.seat, why });
		this.command({ t: 'act', seat: s.seat, frame: { kind: 'act', method: 'selectButtonOk' } });
		return true;
	}

	/**
	 * Press Forge's own Cancel for a cost Forge itself says cannot be paid — item
	 * 7, *"it's confusing i have to click 'cancel' to not pay manaleak when i dont
	 * even have enough mana"*.
	 *
	 * Commanded exactly as the Auto press above is, on the act
	 * `packages/forge-wire` has carried since wave 17 (`tier-a.ts:51`, `:196`) and
	 * the browser already sends (`apps/ui/src/play/live/match.ts`). Nothing is
	 * said: the cast never happened, so there is no cost to account for, and the
	 * board returning to priority IS the answer. The window itself is answered,
	 * so it is never shown — the operator, 2026-10-14: *"chain lightning should
	 * not ask me to play red red if i cannot pay."* Forge asks the seat nothing
	 * after the Cancel until its next window, so a forwarded one stayed on screen.
	 * Returns whether it pressed, so the caller withholds the window.
	 */
	private maybeCancelUnpayable(s: SeatState): boolean {
		const gate = this.autoGateFacts(s);
		if (gate === null) return false;
		const cost = decideCancel(gate.facts, s.policy);
		if (cost === null) {
			if (s.payment === null) s.autoCancelled = null;
			return false;
		}
		if (s.autoCancelled === cost) return false;
		s.autoCancelled = cost;
		this.deps.log({ evt: 'auto-cancelled', matchId: this.id, seat: s.seat, cost });
		// Scoped to the payment: Forge may finish it (Auto already paying) before a plain Cancel
		// lands, which then ends the turn at the next priority window (af57, run 39163377412).
		this.command({ t: 'cancel-payment', seat: s.seat });
		// The seat did not cancel it: a refusal it sees, as Forge's own turned-away click is.
		this.send(s, { kind: 'notify', method: 'flashIncorrectAction' });
		return true;
	}

	/**
	 * The payment prompt this seat is shown, opened and closed: what the auto-pay and
	 * auto-cancel decisions read. What a cast paid is in Forge's own game log (its
	 * `MANA` entries, one per mana ability), which {@link Match.onGameLog} forwards.
	 */
	private trackPayment(s: SeatState, message: string, card: number | null): void {
		const cost = paymentCost(message);
		if (cost !== null) {
			if (s.payment === null || s.payment.cost !== cost) {
				// Whose decision the payment is, settled once as it opens: the seat's own when it pays
				// for the card whose ability this seat chose (`Payment.own`).
				const own = s.payment?.own ?? (s.chosenAbility !== null && s.chosenAbility.hostCard === card);
				s.payment = { cost, own };
				this.checkWaitingOn();
			}
			return;
		}
		if (s.payment === null) return;
		s.payment = null;
		this.checkWaitingOn();
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
		if (s === this.watcherSource()) this.sendWatcher(frame as unknown as ServerFrame);
		for (const early of s.early.splice(0)) this.sendState(s, early);
		this.deps.log({ evt: 'seat-opened', matchId: this.id, seat: s.seat, playerId });

		if (this.status === 'starting' && this.seats.every((x) => x.ai || x.playerId !== null)) {
			this.status = 'running';
			for (const done of this.runningWaiters.splice(0)) done({ ok: true });
			this.armRejoinGrace();
		}
	}

	private closeAsk(s: SeatState, callId: string): void {
		s.asks.delete(callId);
		s.folds.delete(callId);
		this.checkWaitingOn();
	}

	/** `noteDiscardChoice`'s common tail: see the module header above {@link newMatchId}. */
	private noteJustDiscarded(ids: ReadonlySet<number>): void {
		if (ids.size === 0) return;
		if (this.justDiscarded !== null) clearTimeout(this.justDiscarded.timer);
		const timer = setTimeout(() => {
			this.justDiscarded = null;
		}, JUST_DISCARDED_TTL_MS);
		timer.unref();
		this.justDiscarded = { ids, timer };
	}

	/** {@link Match.noteJustDiscarded}, from a `getChoices` reply's chosen KEYS. */
	private noteDiscardChoice(choices: readonly ChoiceOption[], keys: readonly string[]): void {
		const ids = new Set<number>();
		for (const k of keys) {
			const c = choices.find((c) => c.key === k);
			if (c !== undefined && c.ref !== null && c.ref.kind === 'card') ids.add(c.ref.id);
		}
		this.noteJustDiscarded(ids);
	}

	/**
	 * The five-line tail every ask-opening path ends in (S4, wave 64 — folded
	 * from three copies that had drifted into "the same lines", not three
	 * genuinely different endings): register the open ask,
	 * send the frame, and let `checkWaitingOn` re-read what this seat is
	 * waiting on. `callId` and `method` travel separately from `frame` because
	 * {@link Match.openMergedChoice}'s frame is a SYNTHESIZED one — its own
	 * `callId`/`method` are `choose`'s, not Forge's merged ask's.
	 *
	 * `checkWaitingOn`'s own doc used to keep a hand-written list of every
	 * caller "cheap to over-call" from; now there is exactly one call site for
	 * the ask-opening half of that list, and this comment is it.
	 */
	private openAskFrame(s: SeatState, callId: string, method: string, frame: ServerFrame): void {
		s.asks.set(callId, { callId, method, frame, sentAt: this.now() });
		this.deps.log({ evt: 'ask-forwarded', matchId: this.id, seat: s.seat, callId, method, ...askGist(frame) });
		this.send(s, frame);
		this.checkWaitingOn();
	}

	/** Answer an ask the seat is never shown, and log why. */
	private autoReply(s: SeatState, callId: string, method: string, why: string, result: unknown): void {
		s.autoAnswered += 1;
		this.deps.log({ evt: 'ask-auto-answered', matchId: this.id, seat: s.seat, callId, method, why });
		this.command({ t: 'reply', seat: s.seat, callId, result });
	}

	/**
	 * Register and show one ask, after Forge's own re-ask shortcut and "one
	 * legal reply is not a question" have each had a chance to answer it first
	 * — the ask-opening half of `onFrame`'s generic tail, factored out so a
	 * reveal buffered for R4's fold (see the module header above
	 * {@link newMatchId}) can be released exactly as if it had arrived on its
	 * own. Nothing else in that tail applies to an ask frame (every other
	 * branch there gates on a notify method an ask never carries), so sending
	 * it here is complete, not a partial duplicate.
	 */
	private openAsk(s: SeatState, offered: Extract<ServerFrame, { kind: 'ask' }>): void {
		const owed = s.owed;
		s.owed = null;
		const paid = owed?.answer(offered) ?? null;
		if (paid !== null) {
			s.owed = paid.owed;
			this.autoReply(s, offered.callId, offered.method, owed!.why, paid.result);
			return;
		}
		const sheet = eachTypeAsk(offered);
		if (sheet !== null && offered.method === 'getChoices') {
			s.folds.set(offered.callId, offered);
			this.openAskFrame(s, offered.callId, sheet.method, sheet);
			return;
		}
		const frame = arrangeAsk(offered) ?? modesAsk(offered) ?? this.narrowNames(s, offered);
		const clicked = frame.method === 'getAbilityToPlay' && frame.hostCard.id === s.clicked;
		if (frame.method === 'getAbilityToPlay') s.clicked = null;
		// One legal reply is no question in any mode; full control keeps only the order of simultaneous triggers.
		const policy = s.fullControl ? FULL_CONTROL_POLICY : s.policy;
		const auto = repeatedAbilityToPlay(frame, s.lastAbilityToPlay) ?? (clicked ? null : (onlyAnswer(frame, policy) ?? sameCardsOrder(frame) ?? exileOrder(frame)));
		if (auto !== null) {
			// `chosenAbility` only for an offer the seat's own click opened (the same ability it chose
			// on its last click of this card): an ability the server played (a trigger, an effect's
			// cast) is not one the seat chose, and Forge's re-ask inside one activation is that choice already.
			if (frame.method === 'getAbilityToPlay') {
				s.lastAbilityToPlay = { hostCard: frame.hostCard.id, abilityId: (auto.result as { id: number }).id };
				if (clicked) this.choose(s, s.lastAbilityToPlay);
			}
			// Wave 35 §S, R4 — a discard choice Forge left only one legal reply for
			// (`onlyAnswer`'s own "one option") still owes its later echo nothing.
			if (frame.method === 'getChoices' && frame.min > 0) this.noteDiscardChoice(frame.choices, auto.result as string[]);
			this.autoReply(s, auto.callId, auto.method, auto.why, auto.result);
			return;
		}
		const folded = digAsk(frame);
		if (folded !== null && frame.method === 'chooseEntitiesForEffect') {
			s.folds.set(frame.callId, frame);
			this.openAskFrame(s, frame.callId, folded.method, folded);
			return;
		}
		this.openAskFrame(s, frame.callId, frame.method, frame);
	}

	/** A card-name ask offers what the match's format allows and the decks play (`names.ts`). */
	private narrowNames(s: SeatState, frame: Extract<ServerFrame, { kind: 'ask' }>): Extract<ServerFrame, { kind: 'ask' }> {
		if (frame.method !== 'getChoices' || frame.names === undefined) return frame;
		const format = this.spec.format ?? null;
		const legal = format === null ? null : (this.deps.formatNames?.(format) ?? null);
		this.deckNames ??= faceNames(artOf(this.spec).map((card) => card.name));
		const names = namesForFormat(frame.names, legal, this.deckNames);
		this.deps.log({ evt: 'name-ask', matchId: this.id, seat: s.seat, callId: frame.callId, format, offered: frame.names.length, shown: names.length });
		return names === frame.names ? frame : { ...frame, names: [...names] };
	}

	/**
	 * Fold the just-answered `getChoices` reveal (`reveal`, held in
	 * `s.pendingReveal` — already replied to `[]`, since Forge's game thread
	 * would not construct the real choice until it was; see `onFrame`'s own
	 * header) and the real discard choice right behind it (`choose`, still a
	 * live, unanswered ask) into ONE ask the browser actually answers —
	 * `chooseSingleEntityForEffect`, reusing its existing `delayedReveal`
	 * (already drawn by `apps/ui/src/play/prompts/ChoicePrompts.tsx`'s
	 * `DelayedRevealNote`, the "Rampant Growth shape"): the whole revealed hand
	 * stays visible, only the valid cards are clickable. See the module header
	 * above {@link newMatchId} for the ruling and the structural match that
	 * gets here.
	 *
	 * `owner` is the match's OTHER seat — correct for the 2-seat games this
	 * engine plays; a `DelayedReveal` naming the wrong of several opponents
	 * would need more than this to pick the right one, and nothing here claims
	 * to.
	 */
	private openMergedChoice(
		s: SeatState,
		reveal: Extract<ServerFrame, { kind: 'ask'; method: 'getChoices' }>,
		choose: Extract<ServerFrame, { kind: 'ask'; method: 'getChoices' }>,
	): void {
		const other = this.seats.find((o) => o !== s);
		const optionRefs = choose.choices.filter((c): c is ChoiceOption & { ref: NonNullable<ChoiceOption['ref']> } => c.ref !== null);
		const revealCards = reveal.choices
			.map((c) => c.ref)
			.filter((r): r is Extract<NonNullable<ChoiceOption['ref']>, { kind: 'card' }> => r !== null && r.kind === 'card');
		const merged = {
			kind: 'ask',
			callId: choose.callId,
			method: 'chooseSingleEntityForEffect',
			...(choose.source === undefined ? {} : { source: choose.source }),
			title: choose.message,
			optionList: optionRefs.map((c) => c.ref),
			delayedReveal: {
				cards: revealCards,
				zones: ['Hand'],
				owner: { kind: 'player', id: other?.playerId ?? -1 },
				messagePrefix: reveal.message,
			},
			isOptional: choose.min === 0,
		} as unknown as Extract<ServerFrame, { kind: 'ask'; method: 'chooseSingleEntityForEffect' }>;
		s.mergedChoice.set(choose.callId, {
			chooseCallId: choose.callId,
			keyByRef: new Map(optionRefs.map((c) => [`${c.ref.kind}:${c.ref.id}`, c.key])),
		});
		this.openAskFrame(s, choose.callId, 'chooseSingleEntityForEffect', merged);
	}

	/**
	 * Show a reveal Forge has ALREADY been answered for (its `[]`, sent the
	 * instant it arrived — see `onFrame`'s header). Every reveal
	 * the R4 fold does NOT claim as the front half of a discard choice (Dark
	 * Confidant's top card, an opponent's hand shown by a tutor, Secluded
	 * Glen's reveal to the other seat, …) still reaches the seat, because
	 * answering it must not take the information away. It reaches it as what
	 * it is: a `getChoices` reveal ({@link asReveal}), marked
	 * `displayOnly` on the envelope, never registered as an ask — nothing waits
	 * on it, nothing replies to it, and the browser draws it as a notice the
	 * seat closes with its own OK, which sends nothing. The operator,
	 * 2026-10-09: *"why is it necessary for this to require an 'ok' press at
	 * all?"* — the game never waits on that OK.
	 */
	/** The frames held behind a reveal ({@link SeatState.behindReveal}), handled in Forge's order now that it is out. */
	private releaseReveal(s: SeatState): void {
		const held = s.behindReveal;
		s.behindReveal = [];
		for (const raw of held) this.onFrame(s.seat, raw);
		this.releaseLog(s, false);
	}

	private showReveal(s: SeatState, frame: RevealFrame): void {
		const named = frame.choices.filter((c) => c.ref === null).map((c) => c.label);
		this.deps.log({ evt: 'reveal-shown', matchId: this.id, seat: s.seat, callId: frame.callId, cards: choiceCardIds(frame.choices), ...(named.length > 0 ? { named } : {}) });
		this.send(s, frame, 'displayOnly');
	}

	private closeAllAsks(): void {
		if (this.waitingOnTimer !== null) {
			clearTimeout(this.waitingOnTimer);
			this.waitingOnTimer = null;
		}
		for (const s of this.seats) {
			for (const callId of [...s.asks.keys()]) this.closeAsk(s, callId);
			this.disarmActWatch(s.seat);
			s.click = null;
			if (s.departure !== null) clearTimeout(s.departure);
			s.departure = null;
		}
	}

	private fail(reason: string): void {
		if (this.status === 'failed' || this.status === 'stopped') return;
		this.status = 'failed';
		this.failure = reason;
		this.deps.log({ evt: 'match-failed', matchId: this.id, reason });
		this.logFrames();
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
		this.endNotice(`Forge stopped, and this match cannot continue: ${cause}.`);
	}

	/**
	 * The game is over for this seat: told once, and kept for every snapshot after it.
	 *
	 * The bridge's `gameover` line tells every seat with a board at once, with who lost. Forge's own
	 * `finishGame()` and the view's `GameOver` property are not enough on their own: both travel only
	 * if Forge happens to flush to that seat after the end, and a game that ends before Forge has
	 * started it (a concede during the deal) gets no `finishGame` at all and a final delta to one seat
	 * only — the other screen kept a live board with nothing to say the game was over. Forge's own
	 * call arrives after the line (`PlayBridge.SeatGui.finishGame` emits the line first), so it is
	 * the same news and is not sent twice.
	 */
	private finishSeat(s: SeatState, frame: ServerFrame): void {
		if (s.endNotices.some((n) => n.kind === 'finished')) return;
		s.endNotices.push({ kind: 'finished', frame });
		this.send(s, frame);
		// Who won is on the table: the watchers hear it from the source seat's copy, after it.
		if (s === this.watcherSource()) this.sendWatcher(frame);
	}

	/** One ending, told once per seat and kept for every snapshot after it. */
	private endNotice(message: string): void {
		for (const s of this.seats) {
			if (s.ai || s.playerId === null || s.endNotices.some((n) => n.kind === 'ended')) continue;
			const frame = {
				kind: 'notify',
				method: 'showErrorDialog',
				title: MATCH_ENDED_TITLE,
				message,
				matchEnded: true,
			} as ServerFrame;
			s.endNotices.push({ kind: 'ended', frame });
			this.send(s, frame);
		}
		const source = this.watcherSource();
		if (!this.watcher.ended && source !== undefined && source.playerId !== null) {
			this.watcher.ended = true;
			this.sendWatcher({ kind: 'notify', method: 'showErrorDialog', title: MATCH_ENDED_TITLE, message, matchEnded: true } as ServerFrame);
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
	/**
	 * Take back a match an earlier server left running (Wave 22 §E). Its JVM is
	 * still playing; the host replays its stream into the new `Match` before this
	 * returns, so the match comes back with its epoch, its seats' owners and every
	 * seat's history and cursor. Returns null when the record cannot be resumed.
	 */
	adopt(record: JvmRecord): Match | null;
	/**
	 * SIGTERM: leave every match that holds a JVM (`active`: starting, running,
	 * or finished and inside its grace) running for the next process. Returns
	 * the matches that were handed over and the ones that could NOT be, which
	 * the caller owes an explanation (`Match.serverStopping`) and a stop.
	 */
	handOver(): { handed: Match[]; ending: Match[] };
}

export type RegistryDeps = Omit<MatchDeps, 'emit' | 'seatsChanged' | 'phaseStopChanged' | 'onGameOver' | 'liveChanged'> & {
	emit(match: Match, seat: number, envelope: ServerEnvelope): void;
	/** See {@link MatchDeps.seatsChanged}. */
	seatsChanged?(match: Match, seats: SeatIdentity[]): void;
	/** See {@link MatchDeps.phaseStopChanged}. */
	phaseStopChanged?(match: Match, seat: number, phase: StopPhase | null): void;
	/** See {@link MatchDeps.onGameOver}. */
	onGameOver?(match: Match): void;
	liveChanged?(match: Match): void;
	/** The re-attach half of the host. Absent on a host whose JVMs die with us. */
	attach?(record: JvmRecord, events: HostEvents): MatchHost;
};

export function createMatchRegistry(deps: RegistryDeps): MatchRegistry {
	const matches = new Map<string, Match>();
	const active = (): Match[] => [...matches.values()].filter((m) => m.status === 'starting' || m.status === 'running' || m.status === 'over');
	return {
		create(spec) {
			const id = newMatchId();
			const match: Match = new Match(id, spec, {
				...deps,
				emit: (seat, envelope) => deps.emit(match, seat, envelope),
				seatsChanged: (seats) => deps.seatsChanged?.(match, seats),
				phaseStopChanged: (seat, phase) => deps.phaseStopChanged?.(match, seat, phase),
				onGameOver: () => deps.onGameOver?.(match),
				liveChanged: () => deps.liveChanged?.(match),
			});
			matches.set(id, match);
			match.start();
			return match;
		},
		get: (id) => matches.get(id),
		active,
		stopAll() {
			for (const m of matches.values()) m.stop();
		},
		adopt(record) {
			const attach = deps.attach;
			if (attach === undefined || record.spec === null) return null;
			const match: Match = new Match(
				record.matchId,
				record.spec,
				{
					...deps,
					emit: (seat, envelope) => deps.emit(match, seat, envelope),
					seatsChanged: (seats) => deps.seatsChanged?.(match, seats),
					phaseStopChanged: (seat, phase) => deps.phaseStopChanged?.(match, seat, phase),
					onGameOver: () => deps.onGameOver?.(match),
				liveChanged: () => deps.liveChanged?.(match),
				},
				{ epoch: record.epoch, owners: record.owners, startedAt: Date.parse(record.startedAt) },
			);
			matches.set(record.matchId, match);
			match.resume((events) => attach(record, events));
			return match;
		},
		handOver() {
			const handed: Match[] = [];
			const ending: Match[] = [];
			for (const m of active()) (m.handOver() ? handed : ending).push(m);
			return { handed, ending };
		},
	};
}
