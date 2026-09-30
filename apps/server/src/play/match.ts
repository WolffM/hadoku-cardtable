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
	type ClientFrame,
	type ServerFrame,
} from '@hadoku/forge-wire';

import {
	autoCancelReason,
	autoPassReason,
	autoPayReason,
	DEFAULT_STOP_POLICY,
	onlyAnswer,
	paymentCost,
	paymentLine,
	type Payment,
	type SeatNotes,
	type StopPolicy,
} from './auto.js';
import type { BridgeCommand, BridgeLine, HostEvents, JvmRecord, MatchHost, MatchHostFactory, MatchSpec } from './host.js';
import type { MatchSnapshot, ServerEnvelope, WireCursor } from './transport.js';

/**
 * `host.ts`'s `SeatSpec`, widened with the per-seat identity item 4 (wave 29
 * §B) carries beside `deck` and `ai` — never on `name`, which is what Forge
 * renders to both seats (`socket.ts`'s `parseStartBody`, "Forge shows these
 * names to both seats; they are never an identity").
 *
 * Declared here rather than on `SeatSpec` itself: `host.ts` is owned by
 * neither wave-29 lane, and it does not need to change to carry this. Read
 * `apps/server/src/play/bridge/PlayBridge.java`'s `configFrom` to confirm —
 * it pulls `name`/`ai`/`deck` off each seat's JSON object by key and ignores
 * anything else, so the extra property `bridgeConfig`'s `...spec` spread
 * carries into `config.json` is inert there: Forge never reads it and never
 * shows it.
 */
export type SeatSpecWithIdentity = MatchSpec['seats'][number] & { avatarId?: string };

/** `MatchSpec`, with both seats widened the same way. */
export type MatchSpecWithIdentity = Omit<MatchSpec, 'seats'> & {
	seats: [SeatSpecWithIdentity, SeatSpecWithIdentity];
};

/** One seat, as {@link Match.seatIdentities} reports it — see that method's header. */
export interface SeatIdentity {
	seat: number;
	claimed: boolean;
	playerId: number | null;
	avatarId?: string;
}
import {
	createProjector,
	foldFrames,
	keyOf,
	TYPE,
	type ObjTable,
	type SeatProjector,
	type StateFrame,
	type WireObj,
} from './visibility.js';

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
	/**
	 * The per-seat identity item 4 (wave 29 §B) carries — from
	 * `MatchSpec.seats[i].avatarId` (via {@link SeatSpecWithIdentity}), never
	 * from Forge's own state. Absent for a seat with none: two states, not
	 * three, matching `D-avatar-field.md` §3 — a room member who never picked
	 * one and a room member whose choice was explicitly cleared both mean the
	 * same thing to whatever draws a face, so both collapse before they reach
	 * here (`socket.ts`'s `normalizeAvatarId`).
	 */
	avatarId?: string;
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

	/* ── Wave 19 lane C: questions with one answer, stops with nothing to do ── */

	/**
	 * The escape hatch, off by default. While it is on, this seat is asked
	 * everything and passes nothing for itself — because the one thing worse
	 * than a stop you did not want is a stop you did not get.
	 */
	fullControl: boolean;
	/**
	 * This seat's stop preferences — **one policy per seat, not one per server**
	 * (wave 26 §E).
	 *
	 * Every shortcut decision for this seat is asked of THIS value: `onlyAnswer`,
	 * `autoPassReason`, `autoPayReason` and `autoCancelReason` each take a
	 * `StopPolicy` and each got `auto.ts`'s module default until now. It starts as
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
	/** The payment being made, while its prompt is up. */
	payment: Payment | null;
	/**
	 * The cost this seat's Auto was already pressed for. Forge re-sends the
	 * payment prompt after every tap, and a second press would answer whatever
	 * it asks next; one press per cost is all `autoPayReason` ever earns.
	 */
	autoPaid: string | null;
	/**
	 * The cost this seat's Cancel was already pressed for (item 7). One press per
	 * cost, for the same reason {@link SeatState.autoPaid} exists: Forge answers
	 * the press by ending the input, and a second one would answer the next.
	 */
	autoCancelled: string | null;
	/**
	 * This seat's open payment was CANCELLED rather than paid — by the player's own
	 * press or by {@link Match.maybeCancelUnpayable}'s. A cancelled cast paid
	 * nothing, so `trackPayment` owes it no `paid …` line (item 7).
	 */
	paymentCancelled: boolean;
	/** How many asks were answered for this seat, and how many stops passed. */
	autoAnswered: number;
	autoPassed: number;
	/**
	 * The last few `message` lines this seat was sent — what a cast paid, and
	 * whether full control is on. Re-sent after a snapshot so a refresh does not
	 * lose the only record that a cost was paid.
	 *
	 * An auto-pass is NOT one of them any more (wave 25 §D, item 3): the phase it
	 * named is on the turn bar and the phase rail already, and the line was ours
	 * rather than Forge's.
	 */
	says: ServerFrame[];
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
	now?: () => number;
}

/** What a seat is shown when its match fails. Title and wording are ours; the frame is forge-wire's. */
export const MATCH_ENDED_TITLE = 'Match ended';

/** How many `message` lines a seat keeps for a re-send after a snapshot. */
const SAYS_KEPT = 8;

/**
 * The name this seat is entitled to see for a card, off its own projected
 * state — never off the raw stream. A card the projection hid has no name here,
 * and the id it falls back to is the one the seat already holds.
 */
function cardName(state: ReadonlyMap<string, WireObj>, id: number): string | null {
	const view = state.get(keyOf(TYPE.card, id));
	if (view === undefined) return null;
	const current = view.CurrentState as { t?: string; v?: unknown } | undefined;
	const ordinal = current?.t === 'int' && typeof current.v === 'number' ? current.v : 0;
	const face = state.get(keyOf(TYPE.cardState, id * 16 + ordinal));
	for (const obj of [face, view]) {
		const name = obj?.Name as { t?: string; v?: unknown } | undefined;
		if (name?.t === 'str' && typeof name.v === 'string' && name.v !== '') return name.v;
	}
	return null;
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
	/**
	 * True while `resume` is feeding an earlier server's lines back in. Nothing
	 * may go OUT during that: every command in the stream was already sent by the
	 * server that read it, and sending it twice would act twice in Forge.
	 */
	private replaying = false;
	/** Somebody has joined a seat since this match existed in this process. */
	private rejoined = false;
	/** Armed by `resume`: a re-attached match nobody comes back to is stopped. */
	private rejoinTimer: NodeJS.Timeout | null = null;

	constructor(
		id: string,
		spec: MatchSpec,
		deps: MatchDeps,
		/**
		 * From `<run>/jvm.json`, when this match is being taken back from an
		 * earlier server. The epoch and the seats' owners are exactly the two
		 * things a replay cannot reproduce and that must not change: a new epoch
		 * would make every client's cursor a stranger, and a re-seated player
		 * would be handed the other player's hand.
		 */
		restore?: { epoch: string | null; owners: (string | null)[] },
	) {
		this.id = id;
		this.spec = spec;
		this.deps = deps;
		this.now = deps.now ?? Date.now;
		this.epoch = restore?.epoch ?? `${id}:${this.now()}`;
		this.seats = spec.seats.map((s, seat) => ({
			seat,
			ai: s.ai,
			owner: null,
			playerId: null,
			// Present at runtime whenever the caller built the spec through
			// `SeatSpecWithIdentity` (`socket.ts`'s `parseStartBody`); absent
			// otherwise, including for the AI seat, which has no room member.
			avatarId: (s as SeatSpecWithIdentity).avatarId,
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
			fullControl: false,
			// The starting value only — `setStopPolicy` still moves one seat at a
			// time. Absent is production (`MatchDeps.stopPolicy`).
			policy: deps.stopPolicy ?? DEFAULT_STOP_POLICY,
			actionable: null,
			payment: null,
			autoPaid: null,
			autoCancelled: null,
			paymentCancelled: false,
			autoAnswered: 0,
			autoPassed: 0,
			says: [],
		}));
		for (const [seat, owner] of (restore?.owners ?? []).entries()) {
			const s = this.seats[seat];
			if (s !== undefined && owner !== null) s.owner = owner as ParticipantId;
		}
	}

	/** Start Forge. Separate from the constructor so nothing can emit before the match is registered. */
	start(): void {
		if (this.host !== null) return;
		this.host = this.deps.host(this.id, this.spec, this.hostEvents());
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
	resume(attach: (events: HostEvents) => MatchHost, rejoinGraceMs: number): void {
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
		// A resumed match with nobody in it is a JVM nobody wants. The seats have
		// this long to come back before it is stopped for good.
		if (rejoinGraceMs > 0) {
			const timer = setTimeout(() => {
				this.rejoinTimer = null;
				if (this.rejoined) return;
				this.deps.log({ evt: 'match-not-rejoined', matchId: this.id, afterMs: rejoinGraceMs });
				this.stop();
			}, rejoinGraceMs);
			timer.unref();
			this.rejoinTimer = timer;
		}
	}

	private hostEvents(): HostEvents {
		return {
			line: (line) => this.onLine(line),
			exit: (reason) => this.onExit(reason),
			log: (entry) => this.deps.log(entry),
			replayed: (command) => this.onReplayedCommand(command),
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
		// Written down beside the JVM: if this server is replaced mid-match, the
		// next one must seat this person at THIS seat and no other.
		this.host?.remember?.({ epoch: this.epoch, owners: this.owners() });
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
			...(s.avatarId === undefined ? {} : { avatarId: s.avatarId }),
		}));
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
				// A Cancel under an open payment ABANDONS it, so the cost was never
				// paid and `trackPayment` must not report one (item 7). The same note
				// covers the player's own press and `maybeCancelUnpayable`'s.
				if (frame.method === 'selectButtonCancel' && s.payment !== null) s.paymentCancelled = true;
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
		if (s === undefined) return;
		// Before the departure check, and not inside it: this is also how a resumed
		// match learns that somebody came back at all (see `resume`).
		this.rejoined = true;
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
	 * **Nothing is emitted here, on purpose.** A frame sent now would take a `seq`
	 * that the next server's replay cannot reproduce, and the seat's cursor would
	 * be one ahead of a stream that then reuses the number. The seats learn what
	 * happened from the reconnect, which is what the client is already built for.
	 */
	handOver(): boolean {
		if (this.status !== 'starting' && this.status !== 'running') return false;
		if (this.host?.handOver === undefined) return false;
		if (!this.host.handOver()) return false;
		if (this.rejoinTimer !== null) clearTimeout(this.rejoinTimer);
		this.rejoinTimer = null;
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
		this.notePaymentTaps(s, projected);
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
			// A question with one answer is not a question (`auto.ts`). Answered
			// here, the browser never sees the ask at all — no modal to dismiss.
			const auto = s.fullControl ? null : onlyAnswer(frame, s.policy);
			if (auto !== null) {
				s.autoAnswered += 1;
				this.deps.log({
					evt: 'ask-auto-answered',
					matchId: this.id,
					seat: s.seat,
					callId: auto.callId,
					method: auto.method,
					why: auto.why,
				});
				this.command({ t: 'reply', seat: s.seat, callId: auto.callId, result: auto.result });
				return;
			}
			const callId = frame.callId;
			const timer = setTimeout(() => this.abortAsk(s, callId, 'timeout'), this.deps.askTimeoutMs);
			timer.unref();
			s.asks.set(callId, { callId, method: frame.method, frame, sentAt: this.now(), timer });
		} else if (frame.method === 'showPromptMessage') {
			s.prompt = frame;
		} else if (frame.method === 'updateButtons') {
			s.buttons = frame;
		} else if (frame.method === 'setWeaklySelectable') {
			// A set — even an empty one — is Forge's answer to "what can this seat
			// do". `clearWeaklySelectable` is the absence of one; see `auto.ts`.
			s.actionable = frame.cards.map((c) => c.id);
		} else if (frame.method === 'clearWeaklySelectable') {
			s.actionable = null;
		}
		this.send(s, frame);
		if (frame.method === 'showPromptMessage') this.trackPayment(s, frame.message);
		if (frame.method === 'updateButtons') this.maybeAutoPass(s);
		/*
		 * The payment input enables Auto (`updateButtons`) BEFORE it says what it
		 * is paying for (`showPromptMessage`) — `InputPayMana.updateMessage` sets
		 * the buttons, pushes the actionable set, then shows the message — so
		 * both frames have to look.
		 */
		if (frame.method === 'showPromptMessage' || frame.method === 'updateButtons') this.maybeAutoPay(s);
	}

	/* ── Wave 19 lane C ─────────────────────────────────────────────── */

	/**
	 * The escape hatch. Off by default; while it is on this seat is asked every
	 * question and passes no stop for itself.
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
	 * One observable line to a seat: what a cast paid, and whether full control is
	 * on. **A synthesised Forge frame** — nothing downstream can tell it from one
	 * Forge sent — so a line added here is a line every client folds. Wave 25 §D,
	 * item 3 removed the only caller that did not earn that.
	 */
	private say(s: SeatState, message: string): void {
		const frame = { kind: 'notify', method: 'message', message, title: '' } as unknown as ServerFrame;
		s.says.push(frame);
		if (s.says.length > SAYS_KEPT) s.says.shift();
		this.send(s, frame);
	}

	/**
	 * One observable line to **every** seat — the table's log rather than a seat's.
	 *
	 * Wave 28, item 11: *"log should show the whole game log not just what i've
	 * done."* {@link Match.say} sends to one seat, and that is exactly why the
	 * operator only ever saw their own actions. What a seat is TOLD is still
	 * per-seat, and that is the point of the callback rather than a string: the
	 * line is composed once per recipient, from **that recipient's own projected
	 * history**, so a name the recipient may not know cannot ride along in it. A
	 * broadcast built from the ACTOR's history would be a leak with a plausible
	 * excuse, and `match.test.ts`'s `leaked(secrets, emitted)` is the oracle that
	 * would catch it.
	 *
	 * Not every line earns this. A seat's own preference (`full control on`) is
	 * still {@link Match.say}: it is not something that happened in the game, and
	 * telling the opponent when you switch it on is information about you that the
	 * game did not create.
	 *
	 * ## Why this is our `say` channel and not Forge's own log
	 *
	 * Item 11 asks for "the whole game log", and Forge has one: `GameEventAddLog`,
	 * which `packages/forge-wire/src/events/modelled.ts:66-71` already models with
	 * its `GameLogEntryType` and its `sourceCard`. It does not reach us.
	 * `bridge/PlayBridge.java:538` sends `"events": []` on **every** `applyDelta`,
	 * deliberately — its own class comment (`:147-149`): *"events carry card names,
	 * including the card an opponent just drew, and the Node side has no per-event
	 * visibility rule yet."*
	 *
	 * So carrying Forge's log is a BRIDGE change plus a per-event visibility rule,
	 * and neither is this lane's file. Ours is the half that can ship without one:
	 * the events this repo synthesises itself, broadcast, with every name resolved
	 * against the recipient. When the bridge does forward the events arm, an
	 * `AddLog` line must be filtered by the same rule this method embodies — the
	 * recipient's own view decides what a line may name — and `sourceCard` is
	 * exactly the field that makes that filterable rather than a string scan.
	 */
	private sayToTable(line: (recipient: SeatState) => string | null): void {
		for (const s of this.seats) {
			if (s.ai) continue;
			const message = line(s);
			if (message !== null) this.say(s, message);
		}
	}

	/** This seat's Forge player name — shown to both seats, so never an identity. */
	private seatName(seat: number): string {
		return this.spec.seats[seat]?.name ?? `Seat ${seat + 1}`;
	}

	/** What this seat was last told, as the stop decisions read it (`auto.ts`). */
	private notesOf(s: SeatState): SeatNotes {
		return {
			playerId: s.playerId,
			prompt: s.prompt,
			buttons: s.buttons,
			actionable: s.actionable,
			openAsks: s.asks.size,
		};
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
	 */
	private maybeAutoPass(s: SeatState): void {
		if (s.fullControl || s.ai || this.status !== 'running') return;
		const phase = autoPassReason(this.notesOf(s), s.policy);
		if (phase === null) return;
		s.autoPassed += 1;
		// Forge clears the set as the input stops; drop ours with it so the next
		// stop is judged on the next answer rather than on this one.
		s.actionable = null;
		this.deps.log({ evt: 'auto-passed', matchId: this.id, seat: s.seat, phase });
		this.command({ t: 'act', seat: s.seat, frame: { kind: 'act', method: 'selectButtonOk' } });
	}

	/**
	 * Press Forge's own Auto for a payment with one source — and say nothing
	 * extra: `trackPayment` already says what was paid and what tapped, which is
	 * the whole record either way (#8).
	 *
	 * The payment that CANNOT be made is the same shape and is answered here too,
	 * with the other button (item 7).
	 */
	private maybeAutoPay(s: SeatState): void {
		if (s.fullControl || s.ai || this.status !== 'running') return;
		const notes = this.notesOf(s);
		const cost = autoPayReason(notes, s.policy);
		if (cost === null) {
			this.maybeCancelUnpayable(s, notes);
			// The payment ended (or never started); the next one earns its press.
			if (s.payment === null) s.autoPaid = null;
			return;
		}
		if (s.autoPaid === cost) return;
		s.autoPaid = cost;
		this.deps.log({ evt: 'auto-paid', matchId: this.id, seat: s.seat, cost });
		this.command({ t: 'act', seat: s.seat, frame: { kind: 'act', method: 'selectButtonOk' } });
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
	 * board returning to priority IS the answer.
	 */
	private maybeCancelUnpayable(s: SeatState, notes: SeatNotes): void {
		const cost = autoCancelReason(notes, s.policy);
		if (cost === null) {
			if (s.payment === null) s.autoCancelled = null;
			return;
		}
		if (s.autoCancelled === cost) return;
		s.autoCancelled = cost;
		s.paymentCancelled = true;
		this.deps.log({ evt: 'auto-cancelled', matchId: this.id, seat: s.seat, cost });
		this.command({ t: 'act', seat: s.seat, frame: { kind: 'act', method: 'selectButtonCancel' } });
	}

	/**
	 * A cast must never look free (#8). Forge's payment prompt names the cost
	 * (`Pay Mana Cost: {U}`) and the lands tap under it; both vanish the moment
	 * the spell is on the stack, so the pair is kept and said once.
	 *
	 * The one payment that leaves no line is one that was CANCELLED: the cast was
	 * rolled back, nothing was paid, and the rule is "a cast must never look free",
	 * not "every prompt must leave a line".
	 *
	 * **The line goes to the whole table since wave 28 (item 11).** What a
	 * payment tapped is public: the cards are on the battlefield and their
	 * `Tapped` flip is already in every seat's own projected delta, so the
	 * opponent can watch the lands turn sideways whether or not a line says so.
	 * What was NOT public before this is the pairing — which lands paid for which
	 * cast — and that is the half the log exists to carry. Each recipient's copy
	 * resolves the card names from **their own** folded history, so a card they
	 * cannot name reads as `card #<id>` to them and as its name to the payer; and
	 * the opponent's copy is attributed, because an unattributed line in a table's
	 * log reads as your own.
	 */
	private trackPayment(s: SeatState, message: string): void {
		const cost = paymentCost(message);
		if (cost !== null) {
			if (s.payment === null || s.payment.cost !== cost) {
				s.payment = { cost, tapped: [] };
				s.paymentCancelled = false;
			}
			return;
		}
		const payment = s.payment;
		s.payment = null;
		if (payment === null) return;
		// A cast that was CANCELLED paid nothing (item 7). Saying `paid 1U` for it
		// would be the opposite of the rule this line exists for: it would make a
		// cost that was never paid look like one that was.
		if (s.paymentCancelled) {
			s.paymentCancelled = false;
			return;
		}
		this.sayToTable((recipient) => {
			// The recipient's OWN state names the cards. Nothing the payer can see
			// and the recipient cannot gets to cross over inside a string.
			const state = foldFrames(recipient.history as unknown as StateFrame[]);
			const tapped = payment.tapped.map((c) => ({ id: c.id, name: cardName(state, c.id) ?? c.name }));
			return paymentLine({ cost: payment.cost, tapped }, recipient === s ? undefined : this.seatName(s.seat));
		});
	}

	/** Cards that tapped under an open payment prompt, from this seat's own projected delta. */
	private notePaymentTaps(s: SeatState, projected: ServerFrame): void {
		const payment = s.payment;
		if (payment === null || projected.method !== 'applyDelta') return;
		const packet = (projected as unknown as Extract<StateFrame, { method: 'applyDelta' }>).payload.packet;
		for (const table of [packet.newObjects, packet.objectDeltas]) {
			for (const obj of Object.values(table)) {
				if (obj._type !== 0) continue;
				const tapped = obj.Tapped as { t?: string; v?: unknown } | undefined;
				if (tapped?.t !== 'bool' || tapped.v !== true) continue;
				if (payment.tapped.some((c) => c.id === obj._id)) continue;
				payment.tapped.push({ id: obj._id, name: `card #${obj._id}` });
			}
		}
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
		this.endNotice(`Forge stopped, and this match cannot continue: ${cause}.`);
	}

	/** One ending, told once per seat and kept for every snapshot after it. */
	private endNotice(message: string): void {
		for (const s of this.seats) {
			if (s.ai || s.playerId === null || s.ended !== null) continue;
			s.ended = {
				kind: 'notify',
				method: 'showErrorDialog',
				title: MATCH_ENDED_TITLE,
				message,
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
	/**
	 * Take back a match an earlier server left running (Wave 22 §E). Its JVM is
	 * still playing; the host replays its stream into the new `Match` before this
	 * returns, so the match comes back with its epoch, its seats' owners and every
	 * seat's history and cursor. Returns null when the record cannot be resumed.
	 */
	adopt(record: JvmRecord): Match | null;
	/**
	 * SIGTERM: leave every live match running for the next process. Returns the
	 * matches that were handed over and the ones that could NOT be, which the
	 * caller owes an explanation (`Match.serverStopping`).
	 */
	handOver(): { handed: Match[]; ending: Match[] };
}

export type RegistryDeps = Omit<MatchDeps, 'emit'> & {
	emit(match: Match, seat: number, envelope: ServerEnvelope): void;
	/** The re-attach half of the host. Absent on a host whose JVMs die with us. */
	attach?(record: JvmRecord, events: HostEvents): MatchHost;
	/**
	 * How long a resumed match waits for somebody to rejoin before it stops. It is
	 * a JVM and ~700 MB of RSS; nobody coming back means nobody wants it.
	 * Default 5 minutes.
	 */
	rejoinGraceMs?: number;
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
		adopt(record) {
			const attach = deps.attach;
			if (attach === undefined || record.spec === null) return null;
			const match: Match = new Match(
				record.matchId,
				record.spec,
				{ ...deps, emit: (seat, envelope) => deps.emit(match, seat, envelope) },
				{ epoch: record.epoch, owners: record.owners },
			);
			matches.set(record.matchId, match);
			match.resume((events) => attach(record, events), deps.rejoinGraceMs ?? 5 * 60_000);
			return match;
		},
		handOver() {
			const handed: Match[] = [];
			const ending: Match[] = [];
			for (const m of matches.values()) {
				if (m.status !== 'starting' && m.status !== 'running') continue;
				(m.handOver() ? handed : ending).push(m);
			}
			return { handed, ending };
		},
	};
}
