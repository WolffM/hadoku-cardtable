/**
 * Where a match's Forge runs: matches placed into shared `--host` bridge JVMs.
 *
 * ## Many matches per JVM
 *
 * Every bridge JVM is a `PlayBridge --host <hostId>` (`docs/spikes/multi-match-jvm.md`): it boots
 * Forge's model once, says `warm`, and then takes any number of
 * `{"t":"start","match":<hostId>,"config":{…}}` lines, each starting one match on a Forge server
 * of its own. Every line it prints carries its match's id, commands are routed by it, and a
 * match's `stop` ends that match alone, answered by `{"t":"stopped"}`. A `stop` addressed to the
 * host id ends the JVM.
 *
 * This file is the coordinator. `jvmHostFactory` places each match into a JVM with room — the
 * fullest warm one first, so idle JVMs empty out and retire — up to `perJvm` matches each
 * (`MATCHES_PER_JVM`, 25), and opens a new JVM when every one is full. Where a JVM runs and how
 * its line stream is reached is a `JvmLauncher`'s (`jvm-transport.ts`): this machine's (`local-jvm.ts`), by
 * default; a claw's, through a remote agent.
 *
 * - **A match's exit is its `stopped`.** A match asked to stop whose `stopped` never comes is let
 *   go after `MATCH_STOP_MS` and logged (`match-stop-unanswered`); its JVM keeps the others.
 * - **A JVM's death fails EVERY match on it**, with the JVM's reason (`jvm-lost`). Nothing on
 *   that JVM retries in place: a failed claw always fails over (the hosting rulings), and the
 *   failover acts on this signal.
 * - **A JVM with no matches for `IDLE_JVM_MS` is retired**, unless it is the one JVM left with
 *   room (the warm one).
 *
 * ## The warm JVM
 *
 * One JVM with room is kept booted ahead of the next match (unless `warmJvm` is off): when the
 * last JVM with room fills, another is launched behind it. A match placed into a warm JVM starts
 * at once; one placed into a JVM still booting starts the moment it is warm (its `start` waits in
 * the fifo). A JVM that dies before `warm` is a failed boot: the next is tried after
 * `WARM_RETRY_MS`, and after `WARM_MAX_FAILURES` in a row no JVM is kept warm — a match still
 * launches one when it needs one — which is logged.
 *
 * ## The ceiling: at most `MAX_CONCURRENT_MATCHES` matches being played
 *
 * **50** since 2026-10-28 (the operator: "if we hit just 50 concurrent matches that'd be fine"):
 * two claws at `MATCHES_PER_JVM` each. It was 10 while every match was its own ~0.7–1 GB JVM.
 * Counted over the matches still `starting` or `running` (a finished match keeps its slot in its
 * JVM for `overGraceMs`, not a place in the ceiling). `socket.ts` refuses one more with a 503
 * before any JVM is spent. Each person may play at most 5 at once
 * (`http/routes.ts`). The JVM count is bounded separately (`JvmPoolOptions.maxJvms`). A JVM's
 * heap is capped (`JVM_HEAP_MB` for `MATCHES_PER_JVM` matches, `local-jvm.ts`) so a runaway
 * cannot take the box.
 *
 * Nothing outside this file knows a JVM exists: `match.ts` sees a `MatchHost` — send a command,
 * get lines back, stop — and a `MatchHostFactory` makes one.
 *
 * ## A match outlives its server (Wave 22, §E)
 *
 * A deploy must not end live games. The JVM survives the server (`local-jvm.ts`, "A JVM
 * outlives its server"), and the next server has to be able to rebuild each match on it: a
 * re-attached JVM keeps Forge's games, but `Match`'s per-seat projectors, histories, cursors and
 * parked asks lived in the process that died. So:
 *
 * - **Every protocol line and every command of a match is appended to its own stream**,
 *   `<dir>/<matchId>.jsonl`, as it is read or sent; a re-attach replays that file into the new
 *   `Match` before a single live line reaches it. Replay is deterministic, so each seat's `seq`
 *   comes back identical.
 * - **One record per JVM**, `<dir>/jvm.json` (`JvmRecord`): its host id, when it started, when it
 *   was handed over, and every match on it with its epoch, its seats' owners and its spec. A
 *   client therefore resyncs on the cursor it already held, and seat 2 cannot come back as seat 1.
 * - **At boot** the launcher offers back every JVM still running (`running()`); each is attached
 *   at once, and every match its record lists is offered through `orphans()`. Lines arriving for
 *   a match not yet claimed are kept in its stream and replayed when `attach` claims it.
 * - **A degraded match is never handed over** (hosting-test-plan H4): one whose stream could not
 *   be written has a hole a replay would turn into a board Forge does not have. Its stream is
 *   renamed out of the way (a rename needs no space on a disk that just filled), `handOver` refuses
 *   in words, and a later boot stops it instead of offering it.
 *
 * **Nothing keeps an orphan for ever**: a JVM `ORPHAN_MAX_MS` past its `orphanedAt` is retired,
 * not re-attached; a match nobody claims within `ORPHAN_CLAIM_MS` of boot is stopped; and a
 * re-attached match whose seats never come back is stopped by `Match.armRejoinGrace`.
 *
 * ## Going down: what must die before we do (Wave 22, lane U)
 *
 * A JVM with a match that was handed over outlives us on purpose; every other must not. Measured
 * against a real match JVM (lane U): `{"t":"stop"}` → gone 9355 ms, SIGTERM 4322 ms, SIGKILL
 * 0 ms; an idle JVM's host stop 314 ms. pm2 SIGKILLs us after 1.6 s, so there is no budget for a
 * polite end, and `reapOnExit()` is the last word, **synchronous and immediate**: every JVM with
 * no handed-over match is asked to go and killed now (confirmed gone, so its run directory is
 * settled), and every JVM with one is let go with its `orphanedAt` stamped.
 *
 * ## Liveness
 *
 * A JVM's pid says it exists, not that it runs: a SIGSTOPped bridge kept its match `running` for
 * good (hosting-test-plan C2). So the bridge says `alive` every 2 s (`PlayBridge.ALIVE_MS`) from a
 * thread of its own, and a JVM this file has heard nothing from for `UNRESPONSIVE_MS` is killed
 * and every match on it failed through the exit path, exactly as a crash.
 *
 * Why 40 s: a 30 s stop-the-world pause must not end a match, and the silence a pause of P makes
 * is at most P + one interval (2 s), so 32 s; 40 s leaves 8 s for scheduling on a loaded host.
 * Forge's own client timeout is raised far past this (`FORGE_HEARTBEAT_TIMEOUT_S`). A JVM
 * re-attached from an earlier server is watched only from its first line.
 *
 * **Per match, there is no watchdog**, because the bridge reports nothing a watchdog could read:
 * `alive` is one line per JVM from a thread of its own (`PlayBridge.startAlive`), and a match's
 * own lines stop for as long as a player thinks, which is not a fault. A game thread that dies is
 * already the bridge's to report (`MatchContext.fail` → `fatal`, then `stopped`). What a per-match
 * watchdog would need is in "What remains" of `docs/spikes/multi-match-jvm.md`.
 *
 * ## The line protocol
 *
 * `bridge/PlayBridge.java` writes one JSON object per line on stdout and reads one per line on
 * stdin. Its class comment has the list. Stdout carries nothing else, so a line that is not JSON
 * is a bug and is logged, not parsed.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { AbortReasonSchema, ClientAction, GameLogLine, Loss, SendYieldUpdate } from '@hadoku/forge-wire';

import { jsonLogger } from '../log.js';
export { bridgeDiagnostics } from './diagnostics.js';
import type { JvmLauncher, JvmTransport } from './jvm-transport.js';
import { JVM_HEAP_MB, MATCHES_PER_JVM, localJvmLauncher, writeFileAtomic, type JvmHostConfig } from './local-jvm.js';

export {
	BRIDGE_CACHE_MAX_AGE_MS,
	BRIDGE_JVM_FLAGS,
	CRASH_RECORD_FILES,
	CRASH_RECORD_MAX_AGE_MS,
	CRASH_RECORDS_KEPT,
	FORGE_HEARTBEAT_TIMEOUT_S,
	FORGE_PREFERENCES,
	JVM_HEAP_MB,
	MATCHES_PER_JVM,
	bridgeLaunch,
	bridgeVersion,
	jvmHostConfig,
	liveJvmCount,
	stageRunDir,
	sweepRunDirs,
	writeFileAtomic,
	type JvmAvailability,
	type JvmHostConfig,
} from './local-jvm.js';

/* ── What a host is ──────────────────────────────────────────────────── */

export interface SeatSpec {
	/** Forge's player name. Shown to both seats, so never an identity. */
	name: string;
	ai: boolean;
	/** `.dck` text, or null for a random Forge precon. */
	deck: string | null;
}

export interface MatchSpec {
	/**
	 * Seat 0 is always a human: the bridge refuses a match with no human seat, because Forge
	 * watches an AI-against-AI game through a desktop window a headless JVM cannot open.
	 */
	seats: [SeatSpec & { ai: false }, SeatSpec];
	/** Seeds Forge's shuffles and the precon pick, for a repeatable test run. Omitted in play. */
	seed?: number;
	/**
	 * Wave 33 §S — a TEST-only starting position: the text of a Forge puzzle file's
	 * `[state]` section (`humanlife=`, `humanhand=`, `humanbattlefield=`,
	 * `activephase=`, … — `GameState.parseLine` in the deploy tree's forge-build
	 * cache has the full key list), with `human…` keys applying to seat 0 and
	 * `ai…` keys to seat 1. `bridgeConfig` spreads it onto `config.json` like every
	 * other `MatchSpec` field; `PlayBridge.java`'s `configFrom` reads it and
	 * `BridgeGui.hostMatch` applies it from `HostedMatch`'s own start-game hook —
	 * see that method's doc. Omitted in play: `socket.ts`'s `parseStartBody`
	 * accepts this key only behind `CARDTABLE_PLAY_PROBE=1` and refuses it
	 * otherwise, so production never sends one.
	 */
	scenario?: string;
	/**
	 * Start on {@link scenario}'s board with no coin toss and no mulligan — Forge's
	 * own Puzzle game type, which skips both (`GameAction.startGame`). Set only by
	 * `socket.ts` for a board-state room's own scenario; a test's scenario keeps the
	 * ordinary opening its drivers click through.
	 */
	skipOpening?: boolean;
	/**
	 * The room's format id (`room/lobby.ts`'s `FormatId`): what a card-name ask is
	 * narrowed to (`names.ts`). Inert in the JVM — `configFrom` never reads it — and
	 * kept in `config.json` so a match taken back after a restart still has it.
	 */
	format?: string;
	/**
	 * The room's hand smoothing setting (`room/lobby.ts`'s `RoomSettings`): the
	 * opening hand is the closer of two to the deck's land ratio, and each
	 * mulligan's redraw is weighted toward it. `PlayBridge.java`'s `configFrom`
	 * turns it into Forge's filtered hands. Absent is off, Forge's default — a
	 * spec built directly, as the jvm suites build theirs, deals what it always did.
	 */
	handSmoothing?: boolean;
	/**
	 * Wave 71 §E — names the seat Forge asks to choose play or draw. Every game we
	 * host is a fresh Forge `Match`, so Forge always treats it as the FIRST game of
	 * that match and tosses a coin (`GameAction.determineFirstTurnPlayer`,
	 * `forge/forge-game/src/main/java/forge/game/GameAction.java:2364-2416`) rather
	 * than asking the previous loser — this field is how the room still names that
	 * player. `PlayBridge.java`'s `startMatch` rigs the coin toss so the named seat
	 * is the one Forge asks (`SeatGui`'s `updateButtons` with `label1:'Play',
	 * label2:'Draw'`), which makes the published `coinToss.winner` (`match.ts:1055`)
	 * that seat too — the client's existing flip/notice needs no change. Omitted:
	 * byte-identical to today, an unrigged coin toss. Never set alongside a change
	 * to `forge/` — a fork change is a jar switch, and that switch is the operator's.
	 */
	chooser?: 0 | 1;
}

type AbortReason = (typeof AbortReasonSchema)['_zod']['output'];

/**
 * Node → Forge. On the wire each command also carries `match` — the JVM host adds
 * it and the bridge refuses a command without its own match id.
 */
export type BridgeCommand =
	| { t: 'reply'; seat: number; callId: string; result: unknown }
	| { t: 'abort'; seat: number; callId: string; reason: AbortReason }
	| { t: 'act'; seat: number; frame: ClientAction | SendYieldUpdate }
	/** Re-send every ask the seat is parked on, original callIds (`match.ts`'s `armActWatch`). */
	| { t: 'resend-pending'; seat: number }
	/** Forge's Cancel on the seat's open mana payment only, never on an input opened after it (`PlayBridge.java`'s `cancelPayment`). */
	| { t: 'cancel-payment'; seat: number }
	| { t: 'probe'; seat: number; probeId: string; message: string }
	| { t: 'stop' };

/**
 * Forge → Node. `frame.frame` is unvalidated here; `match.ts` parses it. On the
 * wire every line also carries `match`, checked and dropped by the JVM host.
 */
export type BridgeLine =
	/**
	 * `bootMs` is from the JVM's own start (for a spare, that includes its idle
	 * wait); `startMs` from the moment the match was handed to it (Wave 10).
	 */
	/**
	 * `removed`: the cards of the seat's deck Forge has no card for, which it drops as the game starts
	 * (`PlayBridge.java`'s `unsupportedIn`). Absent from a line an older bridge wrote.
	 */
	| { t: 'ready'; forgePort: number; bootMs: number; startMs?: number; seats: { seat: number; ai: boolean; deck: string; removed?: string[] }[] }
	| { t: 'frame'; seat: number; frame: unknown }
	| { t: 'probe'; probeId: string; seat: number; answer?: boolean; ms?: number; error?: string }
	/**
	 * `losers`: the player ids Forge has lost (`Player.hasLost`), the same ids the views carry.
	 * Absent from a line an older bridge wrote, which a resumed match may replay.
	 * `lost`: why each of them lost, as Forge decided it (`PlayerOutcome.lossState`); absent likewise.
	 */
	| { t: 'gameover'; winner: string | null; losers?: number[]; lost?: Loss[] }
	/**
	 * One entry of Forge's own game log (`PlayBridge.GameLogForward`), worded once
	 * per player: `text` is null when the line names a card that player may not
	 * see in a way the bridge could not reword; `cards` are the ones they may.
	 */
	| { t: 'log'; type: GameLogLine['type']; players: { player: number; text: string | null; cards: GameLogLine['cards'] }[] }
	| { t: 'fatal'; message: string }
	| { t: 'rejected'; message: string; command: string }
	| { t: 'stale'; seat: number; callId: string }
	/** The asks a `resend-pending` sent again, after their frames. */
	| { t: 'resent'; seat: number; callIds: string[] }
	| { t: 'unsupported'; seat: number; method: string }
	/**
	 * Wave 32, Q5 — the bridge switched Forge's phase-pacing sleep for a seat
	 * (`SeatGui.setPhaseDelayOff`). Informational: it exists so a log and a suite
	 * can see that the exemption is armed by an End Turn click and lifted after it.
	 */
	| { t: 'pace'; seat: number; skipPhaseDelay: boolean; at: number }
	/**
	 * Wave 78 §A — Forge actually applied this seat's act to an open input, in
	 * APPLIED order (`seq`, one counter shared by both seats of a match —
	 * `PlayBridge.java`'s `SeatController.applied`). `act` is in the same shape
	 * this file's own `BridgeCommand`'s `act` frame sent it (`kind`/`method` plus
	 * that method's own fields); `input` is the open input's simple class name,
	 * for a log a human can read. An act Forge drops (no input was open, or its
	 * hold past `GameServerHandler`'s `BETWEEN_INPUTS_MS` timed out) is never
	 * echoed — the recorder (`recording/recorder.ts`) must log only this line,
	 * never the `act` command at send time, so a dropped act never enters the log.
	 */
	| { t: 'applied'; seat: number; seq: number; input: string; act: ClientAction }
	/**
	 * Wave 78 §A, second pass — this seat's own `InputQueue` just opened or closed an input
	 * (`PlayBridge.java`'s `SeatController.emitInputState`, a second `Observer` on that queue).
	 * `input` (the open input's simple class name) is present only when `open` is true. Exists so
	 * a rebuild can wait for "this seat HAS an open input" before ever sending an act, rather than
	 * sending into the gap and letting `ActGate`'s own `BETWEEN_INPUTS_MS` hold-or-drop decide —
	 * resending on THAT timeout, tried first, could double-apply an act onto whatever opened right
	 * after the hold gave up on it.
	 */
	| { t: 'input'; seat: number; open: boolean; input?: string }
	/**
	 * The game as its turn's upkeep begins (`PlayBridge.TurnSnapshot`): Forge's `GameState` text, a
	 * scenario that restores the match to the start of that turn (`match.ts`'s `restoredSpec`).
	 * `ms` is how long the bridge took to write it.
	 */
	| { t: 'snapshot'; turn: number; state: string; ms: number };

/** The latest `snapshot` line a match has had: what a restore starts it from. */
export interface TurnSnapshot {
	turn: number;
	state: string;
}

export interface HostEvents {
	line(line: BridgeLine): void;
	/** The host is gone. `reason` says why, for the match's status. */
	exit(reason: string): void;
	log(entry: Record<string, unknown>): void;
	/**
	 * Replay only (`attach`): a command an EARLIER server had already sent to this
	 * JVM. Nothing the bridge says records that an ask was answered, so without
	 * this a resumed match would re-open asks Forge has already returned from.
	 */
	replayed?(command: BridgeCommand): void;
}

export interface MatchHost {
	send(command: BridgeCommand): void;
	/** Ask the match to stop; force it after a grace period. Idempotent. */
	stop(): void;
	/**
	 * Write down what a re-attach or a restore of this match would need that only
	 * the match knows: its epoch, which participant owns each seat, and its latest
	 * turn-start snapshot. Absent on a host that cannot outlive the process (the
	 * replay host in the tests).
	 */
	remember?(state: { epoch: string; owners: (string | null)[]; snapshot?: TurnSnapshot | null }): void;
	/**
	 * The server is going down and this match is being LEFT RUNNING. Let go of
	 * the transport without killing anything and without settling the run
	 * directory, so the next process can `attach` to it. Absent on a host whose
	 * JVM cannot outlive us, and false when there was nothing to hand over — the
	 * caller then owes the seats an explanation instead.
	 */
	handOver?(): boolean;
}


/**
 * A match an earlier server left running, as `orphans()` offers it: everything a re-attach needs
 * and nothing a seat could not already see (`owners` are participant ids, which never leave this
 * host).
 */
export interface MatchRecord {
	matchId: string;
	/** The JVM it runs in. */
	hostId: string;
	startedAt: string;
	/** The match's epoch, so a re-attached client resyncs on the cursor it holds. */
	epoch: string | null;
	/** seat → participant id, so a re-attach cannot seat someone at the wrong hand. */
	owners: (string | null)[];
	spec: MatchSpec;
	/** The match's latest turn-start snapshot, absent before its first turn. */
	snapshot?: TurnSnapshot | null;
	/** When the server that ran it handed its JVM over. */
	orphanedAt?: string;
}

/** One JVM's record, `<dir>/jvm.json`: what a later server re-attaches it and its matches by. */
export interface JvmRecord {
	hostId: string;
	startedAt: string;
	/** Set when a server handed this JVM over on its way out. */
	orphanedAt?: string;
	matches: Omit<MatchRecord, 'hostId' | 'orphanedAt'>[];
}

/**
 * Makes a host for one match. `close`, when present, releases whatever the factory holds between
 * matches (an idle JVM); `attachPlay`'s `close()` calls it. `orphans`/`attach` are the re-attach
 * seam — a factory whose JVMs cannot outlive the process has neither.
 */
export type MatchHostFactory = ((matchId: string, spec: MatchSpec, events: HostEvents) => MatchHost) & {
	close?(): void;
	/** Matches still running from an earlier server, oldest first. Asked once, at boot. */
	orphans?(): Promise<MatchRecord[]>;
	/** Take one back: replay its stream into `events` before returning, then hand it live lines. */
	attach?(record: MatchRecord, events: HostEvents): MatchHost;
	/** Leave every live match running for the next process (SIGTERM). */
	handOverAll?(): void;
	/**
	 * The last word before `process.exit`: kill every JVM this process still holds with no
	 * handed-over match, and let go of the rest. Synchronous, immediate, and idempotent — see
	 * "Going down" in the module header.
	 */
	reapOnExit?(): ReapResult;
	/**
	 * Where a match placed now would go, for `start-queue.ts`: into a warm JVM with room (it starts
	 * at once), into one still booting, nowhere yet (placing it launches a JVM), or nowhere at all
	 * (`full`: no host may take it now; it waits until `watchRoom` says otherwise).
	 */
	room?(): 'warm' | 'booting' | 'none' | 'full';
	/** JVMs booting now. */
	booting?(): number;
	/** Called whenever `room()` or `booting()` may have changed. */
	watchRoom?(listener: () => void): void;
};

/** What `reapOnExit` did, by JVM host id, for the shutdown log. */
export interface ReapResult {
	/** Confirmed gone because we killed them, and their run directories settled. */
	killed: string[];
	/** Already gone, or handed over. Nothing to do and nothing owed. */
	kept: string[];
	/** Still running after the kill. A leak, said out loud — the boot sweep is the next chance. */
	left: string[];
}

/** See "The ceiling" in the module header. Also `PlayDeps.maxMatches`'s default. */
export const MAX_CONCURRENT_MATCHES = 50;

/** See "Liveness" in the module header. */
export const UNRESPONSIVE_MS = 40_000;
const LIVENESS_CHECK_MS = 1000;

/**
 * A match asked to stop is let go after this long without its `stopped`. The bridge concedes,
 * answers parked asks as aborted until the game is over (up to 10 s), then tears the match down:
 * a real match took ~9.3 s (lane U).
 */
export const MATCH_STOP_MS = 30_000;
/** A JVM with no matches for this long is retired, unless it is the warm one. */
export const IDLE_JVM_MS = 10 * 60 * 1000;
/** After a JVM fails to boot, the next warm one is tried this much later… */
const WARM_RETRY_MS = 5000;
/** …and after this many failed boots in a row, no JVM is kept warm. */
export const WARM_MAX_FAILURES = 3;

/** `JvmRecord`'s file, in each JVM's directory. */
export const JVM_RECORD_FILE = 'jvm.json';
/** A JVM orphaned longer than this is retired, not re-attached. */
export const ORPHAN_MAX_MS = 12 * 60 * 60 * 1000;
/** A match nobody claimed this long after boot is stopped, so ignoring `orphans()` leaks nothing. */
export const ORPHAN_CLAIM_MS = 60_000;

/** A match's stream: every line and command, in order, for a re-attach to replay. */
export function streamFile(dir: string, matchId: string): string {
	return join(dir, `${matchId}.jsonl`);
}
/** Where a degraded match's stream is moved: kept for a reader, never replayed. */
function brokenStreamFile(dir: string, matchId: string): string {
	return join(dir, `${matchId}.broken.jsonl`);
}

const LINE_TYPES = new Set(['ready', 'frame', 'probe', 'gameover', 'log', 'fatal', 'rejected', 'stale', 'unsupported', 'pace', 'resent', 'applied', 'input', 'snapshot']);

/**
 * The `bridge.stderr.txt` of the local JVM that hosts `matchId`, found by the `match-placed`
 * line the coordinator logged to that match's log. A JVM's run directory is named for the JVM,
 * not the match, so this is how a test or a dump reaches a match's stderr. Null before placement.
 */
export function matchStderrPath(workDir: string, log: readonly Record<string, unknown>[], matchId: string): string | null {
	const placed = log.find((l) => l.evt === 'match-placed' && l.matchId === matchId);
	return typeof placed?.hostId === 'string' ? join(workDir, placed.hostId, 'bridge.stderr.txt') : null;
}

/** `<dir>/jvm.json`, or null when it is missing, unreadable or not a record. */
export function readJvmRecord(dir: string): JvmRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(dir, JVM_RECORD_FILE), 'utf8'));
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const r = parsed as Partial<JvmRecord>;
	if (typeof r.hostId !== 'string' || !Array.isArray(r.matches)) return null;
	const matches = r.matches.filter(
		(m) => typeof m === 'object' && m !== null && typeof m.matchId === 'string' && Array.isArray(m.spec?.seats) && m.spec.seats.length === 2,
	);
	return {
		hostId: r.hostId,
		startedAt: typeof r.startedAt === 'string' ? r.startedAt : new Date(0).toISOString(),
		...(typeof r.orphanedAt === 'string' ? { orphanedAt: r.orphanedAt } : {}),
		matches: matches.map((m) => ({
			matchId: m.matchId,
			startedAt: typeof m.startedAt === 'string' ? m.startedAt : new Date(0).toISOString(),
			epoch: typeof m.epoch === 'string' ? m.epoch : null,
			owners: Array.isArray(m.owners) ? m.owners.map((o) => (typeof o === 'string' ? o : null)) : [],
			spec: m.spec,
		})),
	};
}

/** The config object the bridge reads from a `start` line. `matchId` first: a refusal quotes the line's first 200 characters. */
function bridgeConfig(matchId: string, spec: MatchSpec): Record<string, unknown> {
	return { matchId, ...spec };
}

/** The match id a refused `start` named, from the `rejected` line's quote of it. */
function refusedStart(command: unknown): string | null {
	if (typeof command !== 'string' || !command.startsWith('{"t":"start"')) return null;
	return /"matchId":"([^"]+)"/.exec(command)?.[1] ?? null;
}

/* ── The coordinator ─────────────────────────────────────────────────── */

/** One match in a JVM. */
interface Hosted {
	readonly id: string;
	readonly jvm: Jvm;
	/** Null while it is an orphan nobody has claimed: its lines are kept, not delivered. */
	events: HostEvents | null;
	entry: JvmRecord['matches'][number];
	/** The entry as `jvm.json` last held it, so a failed rewrite knows whose change it lost. */
	onDisk: string | null;
	stopping: boolean;
	ended: boolean;
	handed: boolean;
	/** Why its stream has a hole, once it has one. */
	degraded: string | null;
	/** The message of its `fatal`, for its exit. */
	fatal: string | null;
	stopTimer: NodeJS.Timeout | null;
}

/** One `--host` JVM. */
interface Jvm {
	readonly hostId: string;
	/** Where its record and its matches' streams live: `<workDir>/<hostId>`. */
	readonly dir: string;
	readonly transport: JvmTransport;
	readonly startedAt: string;
	orphanedAt: string | null;
	warm: boolean;
	exited: boolean;
	retiring: boolean;
	/** Takes no new match, and retires once its last one ends (`drain`). */
	draining: boolean;
	released: boolean;
	readonly matches: Map<string, Hosted>;
	lastHeard: number;
	lastCheck: number;
	/** Watched for silence from launch; an attached JVM from its first line. */
	livenessArmed: boolean;
	unresponsive: string | null;
	liveness: NodeJS.Timeout | null;
	idle: NodeJS.Timeout | null;
}

export interface JvmPoolOptions {
	/** Keep one JVM with room booted ahead of the next match. Default: `config.warmJvm`. */
	warm?: boolean;
	/** JVMs this pool will run at once. Default `MAX_CONCURRENT_MATCHES`. */
	maxJvms?: number;
	/** Wait before launching a warm JVM again after one failed to boot. Default `WARM_RETRY_MS`. */
	warmRetryMs?: number;
	/** A JVM empty this long is retired, unless it is the warm one. Default `IDLE_JVM_MS`. */
	idleMs?: number;
	/** A match asked to stop is let go this long without its `stopped`. Default `MATCH_STOP_MS`. */
	matchStopMs?: number;
	/** Sweep `workDir` of what an earlier process left before the first JVM. Default true. Ignored with `launcher`. */
	sweep?: boolean;
	/** Where JVMs run. Default: this machine (`localJvmLauncher`). */
	launcher?: JvmLauncher;
	log?: (entry: Record<string, unknown>) => void;
}

/** The JVM factory. `room()` and friends are for `start-queue.ts`, diagnostics and the benchmark. */
export type JvmHostFactory = MatchHostFactory & {
	close(): void;
	room(): 'warm' | 'booting' | 'none';
	booting(): number;
	watchRoom(listener: () => void): void;
	orphans(): Promise<MatchRecord[]>;
	attach(record: MatchRecord, events: HostEvents): MatchHost;
	handOverAll(): string[];
	reapOnExit(): ReapResult;
	/** JVMs this pool holds, with their matches: for diagnostics and tests. */
	jvms(): { hostId: string; warm: boolean; draining: boolean; matches: string[] }[];
	/** Place nothing more into this JVM, and retire it once its matches end (a heap past `recycleWanted`). */
	drain(hostId: string, why: string): void;
	/**
	 * Kill every JVM now and launch none again: the host failed, and its matches were moved. Each
	 * match's exit still reaches its events, with `why`.
	 */
	abandon(why: string): void;
};

/**
 * Matches placed into shared `--host` JVMs. A match's own `HostEvents.log` receives what is about
 * that match; what is about a JVM goes to `options.log`.
 */
export function jvmHostFactory(config: JvmHostConfig, options: JvmPoolOptions = {}): JvmHostFactory {
	const warmWanted = options.warm ?? config.warmJvm;
	const maxJvms = options.maxJvms ?? MAX_CONCURRENT_MATCHES;
	const perJvm = config.perJvm ?? MATCHES_PER_JVM;
	const idleMs = options.idleMs ?? IDLE_JVM_MS;
	const matchStopMs = options.matchStopMs ?? MATCH_STOP_MS;
	const unresponsiveMs = config.unresponsiveMs ?? UNRESPONSIVE_MS;
	const poolLog = options.log ?? jsonLogger('cardtable-play');
	const launcher = options.launcher ?? localJvmLauncher(config, { sweep: options.sweep ?? true, log: poolLog });
	const jvms = new Set<Jvm>();
	/** Orphans from an earlier server, not yet claimed. */
	const pending = new Map<string, Hosted>();
	const roomWatchers: (() => void)[] = [];
	let bootFailures = 0;
	let retry: NodeJS.Timeout | null = null;
	let claimDeadline: NodeJS.Timeout | null = null;
	let closed = false;
	/** `reapOnExit` is running: a JVM's end is not news to a `Match` in a process that is going. */
	let reaping = false;

	const notifyRoom = (): void => {
		for (const listener of roomWatchers) listener();
	};
	const liveJvms = (): Jvm[] => [...jvms].filter((j) => !j.exited && !j.retiring && !j.released);
	const hasRoom = (jvm: Jvm): boolean => jvm.matches.size < perJvm && !jvm.draining;

	/* ── The record and the streams ── */

	function writeRecord(jvm: Jvm): void {
		if (jvm.released || jvm.exited) return;
		// A match being stopped is not one a later server should take back: it would replay into a
		// new `Match` only to meet its `stopped`.
		const hosted = [...jvm.matches.values()].filter((h) => !h.ended && !h.stopping && h.degraded === null);
		const record: JvmRecord = {
			hostId: jvm.hostId,
			startedAt: jvm.startedAt,
			...(jvm.orphanedAt === null ? {} : { orphanedAt: jvm.orphanedAt }),
			matches: hosted.map((h) => h.entry),
		};
		try {
			writeFileAtomic(join(jvm.dir, JVM_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
			for (const h of hosted) h.onDisk = JSON.stringify(h.entry);
		} catch (err) {
			// The old record is whole (`writeFileAtomic`), so it names each match as it was. One whose
			// entry changed since cannot be re-attached as it is now, and must not be handed over.
			poolLog({ evt: 'jvm-record-failed', id: jvm.hostId, error: (err as Error).message });
			for (const h of hosted) if (h.onDisk !== JSON.stringify(h.entry)) degrade(h, `its record could not be written (${(err as Error).message})`);
		}
	}

	/** Keep a line or a command in the match's stream. A line that cannot be kept degrades the match. */
	function persist(h: Hosted, entry: BridgeLine | { c: BridgeCommand }): void {
		if (h.degraded !== null) return;
		try {
			appendFileSync(streamFile(h.jvm.dir, h.id), `${JSON.stringify(entry)}\n`);
		} catch (err) {
			degrade(h, `its stream could not be written (${(err as Error).message})`);
		}
	}

	/** The match has a hole now, so it can never be replayed: it plays on here, but cannot outlive us. */
	function degrade(h: Hosted, cause: string): void {
		if (h.degraded !== null) return;
		h.degraded = `${cause}, so a replay would give the seats a board Forge does not have`;
		const log = h.events?.log ?? poolLog;
		log({ evt: 'match-degraded', level: 'error', matchId: h.id, hostId: h.jvm.hostId, why: h.degraded });
		try {
			renameSync(streamFile(h.jvm.dir, h.id), brokenStreamFile(h.jvm.dir, h.id));
		} catch (err) {
			// No stream yet, or the rename failed: either way no replay will find a whole one.
			log({ evt: 'match-stream-rename-failed', matchId: h.id, error: (err as Error).message });
		}
	}

	/** Feed a match's stream back to it. Returns how many entries it had. */
	function replay(h: Hosted, events: HostEvents): number {
		let text: string;
		try {
			text = readFileSync(streamFile(h.jvm.dir, h.id), 'utf8');
		} catch (err) {
			events.log({ evt: 'replay-unreadable', matchId: h.id, error: (err as Error).message });
			return 0;
		}
		let replayed = 0;
		for (const raw of text.split('\n')) {
			if (raw === '') continue;
			let entry: unknown;
			try {
				entry = JSON.parse(raw);
			} catch {
				// Only ever the last line, and only if the old process died between the write and the
				// newline: the seat is one frame behind, and its next delta will say so.
				events.log({ evt: 'replay-truncated', matchId: h.id, bytes: raw.length });
				continue;
			}
			if (typeof entry !== 'object' || entry === null) continue;
			const sent = (entry as { c?: unknown }).c;
			if (typeof sent === 'object' && sent !== null) {
				events.replayed?.(sent as BridgeCommand);
				replayed += 1;
				continue;
			}
			if (!LINE_TYPES.has(String((entry as { t?: unknown }).t))) continue;
			events.line(entry as BridgeLine);
			replayed += 1;
		}
		return replayed;
	}

	/* ── JVMs ── */

	function track(hostId: string, dir: string, transport: JvmTransport, from: { warm: boolean; startedAt: string; orphanedAt: string | null }): Jvm {
		const jvm: Jvm = {
			hostId,
			dir,
			transport,
			startedAt: from.startedAt,
			orphanedAt: from.orphanedAt,
			warm: from.warm,
			exited: false,
			retiring: false,
			draining: false,
			released: false,
			matches: new Map(),
			lastHeard: Date.now(),
			lastCheck: Date.now(),
			livenessArmed: !from.warm,
			unresponsive: null,
			liveness: null,
			idle: null,
		};
		jvms.add(jvm);
		transport.onLine((text) => onText(jvm, text));
		transport.onExit((reason) => onJvmExit(jvm, reason));
		watchLiveness(jvm);
		return jvm;
	}

	/** Boot a new JVM. Throws what the launcher throws. */
	function launch(): Jvm {
		const hostId = `h-${randomBytes(6).toString('hex')}`;
		const transport = launcher.launch(hostId, { xmxMb: config.xmxMb ?? JVM_HEAP_MB });
		const dir = join(config.workDir, hostId);
		mkdirSync(dir, { recursive: true });
		const jvm = track(hostId, dir, transport, { warm: false, startedAt: new Date().toISOString(), orphanedAt: null });
		writeRecord(jvm);
		poolLog({ evt: 'jvm-launched', id: hostId, jvms: jvms.size });
		notifyRoom();
		return jvm;
	}

	/**
	 * Kill a JVM that has said nothing for `unresponsiveMs`. A check that itself ran late means
	 * THIS process was not reading — its event loop stalled — so the clock restarts rather than
	 * blaming the JVM.
	 */
	function watchLiveness(jvm: Jvm): void {
		const timer = setInterval(() => {
			const now = Date.now();
			if (now - jvm.lastCheck > 3 * LIVENESS_CHECK_MS) jvm.lastHeard = now;
			jvm.lastCheck = now;
			if (!jvm.livenessArmed || jvm.exited || jvm.released) return;
			const silentMs = now - jvm.lastHeard;
			if (silentMs < unresponsiveMs) return;
			clearInterval(timer);
			jvm.liveness = null;
			jvm.unresponsive = `the JVM stopped answering (nothing from it for ${Math.round(silentMs / 1000)} s), so it was killed`;
			poolLog({ evt: 'jvm-unresponsive', id: jvm.hostId, silentMs, matches: [...jvm.matches.keys()] });
			jvm.transport.kill();
		}, LIVENESS_CHECK_MS);
		timer.unref();
		jvm.liveness = timer;
	}

	function onText(jvm: Jvm, text: string): void {
		jvm.lastHeard = Date.now();
		jvm.livenessArmed = true;
		// Liveness only: never kept, never forwarded. The bridge writes `t` first (`PlayBridge.line`).
		if (text.startsWith('{"t":"alive"')) return;
		let value: unknown;
		try {
			value = text.startsWith('{') ? JSON.parse(text) : null;
		} catch {
			value = null;
		}
		if (typeof value !== 'object' || value === null || typeof (value as { t?: unknown }).t !== 'string') {
			poolLog({ evt: 'bridge-noise', id: jvm.hostId, text: text.slice(0, 200) });
			return;
		}
		const { match, ...line } = value as { t: string; match?: unknown } & Record<string, unknown>;
		if (match === jvm.hostId) {
			onHostLine(jvm, line);
			return;
		}
		const h = typeof match === 'string' ? jvm.matches.get(match) : undefined;
		if (h === undefined || h.ended) {
			poolLog({ evt: 'bridge-wrong-match', id: jvm.hostId, got: match, line: line.t });
			return;
		}
		if (line.t === 'stopped') {
			matchEnded(h);
			return;
		}
		if (!LINE_TYPES.has(line.t)) {
			poolLog({ evt: 'bridge-noise', id: jvm.hostId, text: text.slice(0, 200) });
			return;
		}
		if (line.t === 'fatal') h.fatal = String(line.message);
		persist(h, line as BridgeLine);
		if (h.events !== null && !h.handed) h.events.line(line as BridgeLine);
	}

	/** A line about the JVM itself: `warm`, or a `start` it refused. */
	function onHostLine(jvm: Jvm, line: { t: string } & Record<string, unknown>): void {
		if (line.t === 'warm') {
			jvm.warm = true;
			bootFailures = 0;
			poolLog({ evt: 'jvm-warm', id: jvm.hostId, bootMs: line.bootMs, matches: jvm.matches.size });
			notifyRoom();
			replenish();
			return;
		}
		const refused = line.t === 'rejected' ? refusedStart(line.command) : null;
		const h = refused === null ? undefined : jvm.matches.get(refused);
		if (h !== undefined && !h.ended) {
			// A one-match JVM said `fatal` and exited for this; here the JVM goes on and only the match ends.
			const message = `Forge refused the match: ${String(line.message)}`;
			h.fatal = message;
			h.events?.line({ t: 'fatal', message });
			matchEnded(h);
			return;
		}
		poolLog({ evt: 'bridge-host-line', id: jvm.hostId, line });
	}

	/** The match is over in Forge: its `stopped` came, or nobody is waiting for it any more. */
	function matchEnded(h: Hosted): void {
		if (h.ended) return;
		h.ended = true;
		if (h.stopTimer !== null) clearTimeout(h.stopTimer);
		pending.delete(h.id);
		const jvm = h.jvm;
		jvm.matches.delete(h.id);
		writeRecord(jvm);
		if (h.events !== null && !h.handed) {
			h.events.exit(h.stopping ? 'stopped' : h.fatal !== null ? `Forge failed: ${h.fatal}` : 'Forge ended the match without being asked to');
		}
		if (jvm.matches.size === 0) idle(jvm);
		notifyRoom();
		replenish();
	}

	function onJvmExit(jvm: Jvm, reason: string): void {
		if (jvm.exited) return;
		jvm.exited = true;
		jvms.delete(jvm);
		if (jvm.liveness !== null) clearInterval(jvm.liveness);
		if (jvm.idle !== null) clearTimeout(jvm.idle);
		const why = jvm.unresponsive ?? reason;
		const lost = [...jvm.matches.values()].filter((h) => !h.ended);
		for (const h of lost) {
			h.ended = true;
			if (h.stopTimer !== null) clearTimeout(h.stopTimer);
			pending.delete(h.id);
			if (!reaping && h.events !== null && !h.handed) h.events.exit(h.stopping ? 'stopped' : why);
		}
		jvm.matches.clear();
		if (reaping) return;
		if (lost.some((h) => !h.stopping)) {
			poolLog({ evt: 'jvm-lost', level: 'error', id: jvm.hostId, reason: why, matches: lost.map((h) => h.id) });
		} else {
			poolLog({ evt: 'jvm-ended', id: jvm.hostId, reason: why });
		}
		if (!jvm.warm && !jvm.retiring) {
			bootFailures += 1;
			poolLog({ evt: 'jvm-boot-failed', id: jvm.hostId, reason: why, failures: bootFailures });
			if (bootFailures === WARM_MAX_FAILURES) {
				poolLog({ evt: 'warm-disabled', reason: `${bootFailures} JVMs died before warm; a match launches its own` });
			}
			notifyRoom();
			retryLater();
			return;
		}
		notifyRoom();
		replenish();
	}

	/** Ask the JVM to go, and make sure it does. Its exit is not a failure of anything. */
	function retire(jvm: Jvm, why: string): void {
		if (jvm.retiring || jvm.exited || jvm.released) return;
		jvm.retiring = true;
		if (jvm.idle !== null) clearTimeout(jvm.idle);
		poolLog({ evt: 'jvm-retired', id: jvm.hostId, why });
		jvm.transport.send(JSON.stringify({ t: 'stop', match: jvm.hostId }));
		const kill = setTimeout(() => jvm.transport.kill(), config.stopGraceMs);
		kill.unref();
		notifyRoom();
	}

	/** The JVM has no matches: retire it now, or after `idleMs` unless it is the warm one then. */
	function idle(jvm: Jvm): void {
		if (jvm.matches.size > 0 || jvm.exited || jvm.retiring || jvm.released) return;
		if (closed || !warmWanted || jvm.draining) {
			retire(jvm, closed ? 'closing' : jvm.draining ? 'drained' : 'no match left, and no JVM is kept warm');
			return;
		}
		if (jvm.idle !== null) clearTimeout(jvm.idle);
		jvm.idle = setTimeout(() => {
			jvm.idle = null;
			if (jvm.matches.size > 0) return;
			if (liveJvms().some((other) => other !== jvm && hasRoom(other))) retire(jvm, `no match for ${idleMs} ms`);
			else idle(jvm);
		}, idleMs);
		jvm.idle.unref();
	}

	function retryLater(): void {
		if (retry !== null || closed) return;
		retry = setTimeout(() => {
			retry = null;
			replenish();
		}, options.warmRetryMs ?? WARM_RETRY_MS);
		retry.unref();
	}

	/**
	 * Keep one JVM with room — but launch it only while no JVM is booting. Starts fill a booting JVM
	 * as readily as a warm one, so without that bound a burst would launch one warm JVM per
	 * `perJvm` starts, all booting at once, past `start-queue.ts`'s limit (a burst of 8 at 2 per
	 * JVM had 4 booting together on a claw). It is asked again when a JVM turns warm. Never throws: it runs after a placement, on a JVM's exit and from a
	 * timer, and none of those may fail for it (a full disk made staging throw from a timer, which
	 * is the whole server). A launch that throws counts as a failed boot.
	 */
	function replenish(): void {
		if (!warmWanted || closed || retry !== null || bootFailures >= WARM_MAX_FAILURES) return;
		if (liveJvms().some((j) => hasRoom(j) || !j.warm) || jvms.size >= maxJvms) return;
		try {
			launch();
		} catch (err) {
			bootFailures += 1;
			poolLog({ evt: 'jvm-launch-failed', error: (err as Error).message, failures: bootFailures });
			if (bootFailures === WARM_MAX_FAILURES) poolLog({ evt: 'warm-disabled', reason: `${bootFailures} JVMs could not be launched; a match launches its own` });
			retryLater();
		}
	}

	/* ── Matches ── */

	function stopMatch(h: Hosted): void {
		if (h.stopping || h.ended) return;
		h.stopping = true;
		// Out of the record now, not at its `stopped`: a JVM killed before that (remote, unconfirmed)
		// would otherwise offer the match to the next server.
		writeRecord(h.jvm);
		h.jvm.transport.send(JSON.stringify({ t: 'stop', match: h.id }));
		h.stopTimer = setTimeout(() => {
			(h.events?.log ?? poolLog)({ evt: 'match-stop-unanswered', matchId: h.id, hostId: h.jvm.hostId, afterMs: matchStopMs });
			matchEnded(h);
		}, matchStopMs);
		h.stopTimer.unref();
	}

	function hostFace(h: Hosted): MatchHost {
		return {
			send: (command: BridgeCommand) => {
				if (command.t === 'stop') {
					stopMatch(h);
					return;
				}
				if (h.ended || h.jvm.exited) return;
				// Kept in the same stream, in the same order, as the lines that came back: a replay
				// has to know which asks the old server had already answered.
				persist(h, { c: command });
				h.jvm.transport.send(JSON.stringify({ ...command, match: h.id }));
			},
			stop: () => stopMatch(h),
			remember: (state) => {
				h.entry = { ...h.entry, epoch: state.epoch, owners: state.owners, ...(state.snapshot === undefined ? {} : { snapshot: state.snapshot }) };
				writeRecord(h.jvm);
			},
			handOver: () => {
				if (h.degraded !== null && !h.ended && !h.jvm.exited) {
					(h.events?.log ?? poolLog)({
						evt: 'jvm-handover-refused',
						matchId: h.id,
						hostId: h.jvm.hostId,
						why: `this match cannot be kept across a restart: ${h.degraded}`,
					});
					return false;
				}
				if (h.ended || h.stopping || h.jvm.exited || h.jvm.released || h.events === null) return false;
				h.handed = true;
				return true;
			},
		};
	}

	/** Where a new match goes: the fullest warm JVM with room, else one booting, else none. */
	/**
	 * A JVM with room for `matchId`. Never one still holding a match of that id: a restored match
	 * keeps its id (`MatchRegistry.restore`), and a JVM routes its lines by id, so the new game must
	 * not land beside the old one in the moment before the old one is gone.
	 */
	function placeFor(matchId?: string): Jvm | null {
		const open = liveJvms().filter((j) => hasRoom(j) && (matchId === undefined || !j.matches.has(matchId)));
		const warm = open.filter((j) => j.warm).sort((a, b) => b.matches.size - a.matches.size);
		return warm[0] ?? open[0] ?? null;
	}

	/**
	 * Throws when the match cannot be given a JVM (every JVM full at `maxJvms`, or a launch that
	 * throws), and leaves nothing behind. The caller fails the match (`Match.start`).
	 */
	const factory = ((matchId: string, spec: MatchSpec, events: HostEvents): MatchHost => {
		let jvm = placeFor(matchId);
		if (jvm === null) {
			if (jvms.size >= maxJvms) throw new Error(`every Forge JVM is full (${jvms.size} of ${maxJvms}, ${perJvm} matches each)`);
			jvm = launch();
		}
		if (jvm.idle !== null) clearTimeout(jvm.idle);
		jvm.idle = null;
		const h: Hosted = {
			id: matchId,
			jvm,
			events,
			entry: { matchId, startedAt: new Date().toISOString(), epoch: null, owners: [], spec },
			onDisk: null,
			stopping: false,
			ended: false,
			handed: false,
			degraded: null,
			fatal: null,
			stopTimer: null,
		};
		jvm.matches.set(matchId, h);
		writeRecord(jvm);
		events.log({ evt: 'match-placed', matchId, hostId: jvm.hostId, warm: jvm.warm, matches: jvm.matches.size });
		jvm.transport.send(JSON.stringify({ t: 'start', config: bridgeConfig(matchId, spec), match: jvm.hostId }));
		notifyRoom();
		replenish();
		return hostFace(h);
	}) as JvmHostFactory;

	factory.room = () => {
		const at = placeFor();
		return at === null ? 'none' : at.warm ? 'warm' : 'booting';
	};
	factory.booting = () => liveJvms().filter((j) => !j.warm).length;
	factory.watchRoom = (listener) => {
		roomWatchers.push(listener);
	};
	factory.jvms = () => [...jvms].map((j) => ({ hostId: j.hostId, warm: j.warm, draining: j.draining, matches: [...j.matches.keys()] }));

	factory.drain = (hostId: string, why: string) => {
		const jvm = [...jvms].find((j) => j.hostId === hostId);
		if (jvm === undefined || jvm.draining || jvm.exited || jvm.released) return;
		jvm.draining = true;
		poolLog({ evt: 'jvm-draining', id: hostId, why, matches: [...jvm.matches.keys()] });
		idle(jvm);
		notifyRoom();
		replenish();
	};

	factory.abandon = (why: string) => {
		closed = true;
		if (retry !== null) clearTimeout(retry);
		for (const jvm of [...jvms]) {
			poolLog({ evt: 'jvm-abandoned', id: jvm.hostId, why, matches: [...jvm.matches.keys()] });
			jvm.unresponsive = why;
			jvm.transport.kill();
		}
	};

	factory.close = () => {
		closed = true;
		if (retry !== null) clearTimeout(retry);
		if (claimDeadline !== null) clearTimeout(claimDeadline);
		for (const jvm of [...jvms]) if (jvm.matches.size === 0) retire(jvm, 'closing');
	};

	/* ── Re-attach ── */

	/** Take back a JVM an earlier server left running, and every match its record names. */
	function adopt(hostId: string): void {
		const dir = join(config.workDir, hostId);
		const record = readJvmRecord(dir);
		const transport = launcher.attach(hostId);
		const jvm = track(hostId, dir, transport, { warm: true, startedAt: record?.startedAt ?? new Date().toISOString(), orphanedAt: null });
		const age = record === null ? 0 : Date.now() - Date.parse(record.orphanedAt ?? record.startedAt);
		if (record === null || !(age < ORPHAN_MAX_MS)) {
			retire(jvm, record === null ? 'no readable record: its matches cannot be named' : `orphaned ${age} ms ago, past ORPHAN_MAX_MS`);
			return;
		}
		jvm.orphanedAt = record.orphanedAt ?? null;
		for (const entry of record.matches) {
			const h: Hosted = {
				id: entry.matchId,
				jvm,
				events: null,
				entry,
				onDisk: JSON.stringify(entry),
				stopping: false,
				ended: false,
				handed: false,
				degraded: null,
				fatal: null,
				stopTimer: null,
			};
			jvm.matches.set(h.id, h);
			if (existsSync(streamFile(dir, h.id))) {
				pending.set(h.id, h);
			} else {
				// Its stream broke under the server before: a replay would be wrong, so it ends here.
				poolLog({ evt: 'match-not-resumable', matchId: h.id, hostId, why: 'its stream is not whole' });
				stopMatch(h);
			}
		}
		poolLog({ evt: 'jvm-adopted', id: hostId, matches: [...jvm.matches.keys()], orphanedAt: jvm.orphanedAt });
		if (jvm.matches.size === 0) idle(jvm);
	}

	/** Nobody came back for these. See "A match outlives its server". */
	function dropUnclaimed(): void {
		for (const h of [...pending.values()]) {
			poolLog({ evt: 'orphan-unclaimed', matchId: h.id, hostId: h.jvm.hostId, afterMs: ORPHAN_CLAIM_MS });
			pending.delete(h.id);
			stopMatch(h);
		}
	}

	// The warm JVM is launched once discovery has answered, not before: a JVM taken back with room
	// IS the warm one, and a fresh boot beside it after every deploy only spent a boot's CPU while
	// the matches were resuming (Forge run 40566453363: each e2e restart booted a second JVM, 30 s+
	// on a loaded claw).
	const found: Promise<void> = launcher
		.running()
		.then((hostIds) => {
			for (const hostId of hostIds) {
				try {
					adopt(hostId);
				} catch (err) {
					poolLog({ evt: 'jvm-adopt-failed', id: hostId, error: (err as Error).message });
				}
			}
			if (pending.size > 0) {
				claimDeadline = setTimeout(dropUnclaimed, ORPHAN_CLAIM_MS);
				claimDeadline.unref();
			}
			replenish();
		})
		.catch((err: unknown) => {
			poolLog({ evt: 'jvm-running-failed', error: (err as Error).message });
			replenish();
		});

	factory.orphans = async () => {
		await found;
		return [...pending.values()]
			.map((h) => ({ ...h.entry, hostId: h.jvm.hostId, ...(h.jvm.orphanedAt === null ? {} : { orphanedAt: h.jvm.orphanedAt }) }))
			.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
	};

	factory.attach = (record: MatchRecord, events: HostEvents): MatchHost => {
		const h = pending.get(record.matchId);
		if (h === undefined) throw new Error(`there is no orphan match ${record.matchId} to attach to`);
		pending.delete(record.matchId);
		// Replay, THEN deliver live lines. A live delta applied before the `setGameView` it follows
		// would give the seat a board Forge does not have; the order holds because the replay is
		// synchronous and Node is single-threaded.
		const replayed = replay(h, events);
		h.events = events;
		events.log({ evt: 'match-resumed', matchId: h.id, hostId: h.jvm.hostId, replayed });
		return hostFace(h);
	};

	/* ── Going down ── */

	/** Let go of a JVM with a handed-over match: stamped, released, its matches left to the next server. */
	function release(jvm: Jvm): void {
		jvm.orphanedAt = new Date().toISOString();
		writeRecord(jvm);
		jvm.released = true;
		if (jvm.liveness !== null) clearInterval(jvm.liveness);
		if (jvm.idle !== null) clearTimeout(jvm.idle);
		for (const h of jvm.matches.values()) if (h.stopTimer !== null) clearTimeout(h.stopTimer);
		jvms.delete(jvm);
		jvm.transport.release();
	}

	/** SIGTERM: every live match is left running for the next process. Returns the matches handed over. */
	factory.handOverAll = (): string[] => {
		const handed: string[] = [];
		for (const jvm of [...jvms]) {
			for (const h of jvm.matches.values()) if (hostFace(h).handOver!()) handed.push(h.id);
		}
		factory.close();
		for (const jvm of [...jvms]) if ([...jvm.matches.values()].some((h) => h.handed)) release(jvm);
		return handed;
	};

	/**
	 * The last word before `process.exit`. It asks the pool, not the match statuses: the only
	 * question is whether a JVM holds a match that was handed over. Orphans from an EARLIER server
	 * that nobody claimed are among the JVMs and are let go again if a match of theirs was handed
	 * over, else ended — a match nobody claimed was stopped.
	 */
	factory.reapOnExit = (): ReapResult => {
		closed = true;
		reaping = true;
		if (retry !== null) clearTimeout(retry);
		if (claimDeadline !== null) clearTimeout(claimDeadline);
		const result: ReapResult = { killed: [], kept: [], left: [] };
		for (const jvm of [...jvms]) {
			if ([...jvm.matches.values()].some((h) => h.handed || (pending.has(h.id) && h.degraded === null))) {
				release(jvm);
				result.kept.push(jvm.hostId);
				continue;
			}
			jvm.transport.send(JSON.stringify({ t: 'stop', match: jvm.hostId }));
			jvm.transport.kill();
			(jvm.exited ? result.killed : result.left).push(jvm.hostId);
		}
		poolLog({ evt: 'jvms-reaped', ...result });
		return result;
	};

	return factory;
}
