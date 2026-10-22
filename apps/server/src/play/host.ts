/**
 * Where a match's Forge runs — the seam lane D's O3 answer plugs into.
 *
 * ## The decision: one child JVM per match, behind an interface
 *
 * Node cannot host a JVM in-process, so "in-process" was never on the table;
 * the real question is one child JVM per match, or one long-lived JVM hosting
 * many. This lane runs **one child JVM per match**, for a reason that is not a
 * preference: `FServerManager.getInstance()` is a process-wide singleton that
 * holds ONE lobby (`FServerManager.java:212`), and the bridge drives the match
 * through that server — so one JVM can host exactly one match through it. A JVM
 * hosting many would need a second server per match, which the singleton does
 * not allow without a fork change.
 *
 * Wave 9 lane D measured the same wall from the other side and recommends the
 * same shape (`docs/spikes/jvm-per-match.md`): a second networked match in one
 * JVM fails with `IllegalArgumentException: Hook previously registered` at
 * `FServerManager.java:276`; a JVM is ready in ~3.4 s and costs ~650–730 MB of
 * RSS; killing one leaves the others untouched. Their three asks of this side
 * are all here: a `matchId` on every line in both directions (the bridge
 * stamps and checks it, this file checks and strips it), the process's exit is
 * the match's end (a non-zero or unexpected exit fails that match only), and
 * closing is `stop`, then SIGTERM, then SIGKILL. Their fourth — a warm spare
 * JVM so a new match does not wait for startup — is built (Wave 10): see "The
 * warm spare" below.
 *
 * ## The warm spare
 *
 * `jvmHostFactory` keeps ONE bridge JVM booted with no match (`PlayBridge
 * --spare <spareId>`): Forge's model, card database and network server are up,
 * and it is blocked on stdin. A new match adopts it by sending one `start` line
 * carrying the same config object a cold start reads from its file, and a
 * replacement spare is spawned behind it. It is still one JVM per match — the
 * spare becomes that match's JVM and never hosts a second. A spare that is
 * still booting is adopted anyway (it is never behind a fresh spawn); one that
 * dies idle is replaced after `SPARE_RETRY_MS`, and after
 * `SPARE_MAX_FAILURES` deaths in a row without reaching `warm` the pool stops
 * trying and every match starts cold, which is logged. Measured saving: see
 * `README.md`, "The warm spare, measured".
 *
 * ## The ceiling: at most `MAX_CONCURRENT_MATCHES` matches being played
 *
 * **10** since 2026-10-11 (the operator: *"lol why is there a server-wide cap of
 * 2 concurrent matches? can we really not handle more?"*), counting only the
 * matches still `starting` or `running` — a finished match keeps its JVM for
 * `overGraceMs` but no longer holds a slot (conceding used to block the next
 * game for ten minutes). Measured that day: a live JVM is ~0.65–1 GB RSS and the
 * host had ~13 GB available, so ten is inside it with room for the finished ones
 * still winding down. Each person may play at most 5 at once
 * (`http/routes.ts`'s `MAX_MATCHES_PER_PERSON`). What follows is the original
 * reasoning for 2, kept because its measurements still hold.
 *
 * It was deliberately **2**. Wave 9 lane D measured ~650 MB of RSS for an idle JVM and
 * ~730 MB at peak, and G1 does not hand committed heap back to the OS, so a
 * JVM's RSS only ratchets up for as long as it lives. We therefore budget every
 * JVM at its peak, not its average, and cap the heap so that peak has a bound:
 * each JVM gets `-Xmx1g` unless `CARDTABLE_PLAY_JVM_OPTS` names its own `-Xmx`
 * (live heap is ~172 MB idle and ~10 MB per match, so 1 GB is ~5× headroom).
 * The spare only exists while fewer than `MAX_CONCURRENT_MATCHES` matches do,
 * so the process count — and so the memory bound — is the same with or
 * without it: 2 JVMs, ~1.5 GB expected and ~2.6 GB worst case (2 × (1 GB heap +
 * ~300 MB metaspace, code cache and Netty)). That is two simultaneous games,
 * which is the friend group's actual peak; the host has ~25 GB free, so the
 * number is not memory-bound — it is set so a runaway match cannot take the
 * box, and so raising it is a decision someone makes on purpose. `socket.ts`
 * refuses a third match with a 503 before any JVM is spent; this pool enforces
 * the same number on its own spare. Raise both together (`PlayDeps.maxMatches`
 * and `JvmPoolOptions.maxJvms` both default to this constant). Lane D's
 * "revisit" line is ~8 concurrent matches.
 *
 * Nothing outside this file knows a JVM exists: `match.ts` sees a `MatchHost`
 * — send a command, get lines back, stop — and a `MatchHostFactory` makes one.
 * A pooled or shared host implements the same two types; the `MatchSpec` it
 * receives and the lines it hands back do not change.
 *
 * ## The run directory, and what is left of it (Wave 12)
 *
 * Every JVM gets `<workDir>/<id>` (see `stageRunDir`): Forge's profile, a `res`
 * symlink, empty user and cache dirs, the match's `config.json`, and
 * `bridge.stderr.txt` — ~200 KB a match, nearly all of it stderr. `workDir` is
 * on tmpfs by default, so a directory nobody removes is RAM nobody gets back.
 * What happens to it is decided when the JVM is gone (its stderr closed):
 *
 * - **A clean end is removed whole.** Clean means *we* asked it to stop (the
 *   match's `stop()`, the over-grace, `close()` on the spare) and it exited 0
 *   — the bridge's own `halt(0)`. The match is over and the directory says
 *   nothing its logs did not.
 * - **Anything else is a crash record.** A JVM that exited on its own, by a
 *   signal, non-zero (the bridge's `fatal` is `halt(1)`), one that needed
 *   SIGTERM/SIGKILL to go, or one that never started: `bridge.stderr.txt` is
 *   the only record of *why*, and the exit reason names its path. The
 *   directory is kept at that same path, pruned to `CRASH_RECORD_FILES`
 *   (stderr, `config.json` — the decks, so it can be replayed — and a
 *   `crash.json` saying how it ended). The `res` symlink and Forge's empty dirs
 *   go.
 * - **Crash records are bounded.** The newest `CRASH_RECORDS_KEPT`, none older
 *   than `CRASH_RECORD_MAX_AGE_MS`; the rest are removed each time a new one
 *   is written and at boot. Enough to diagnose last week; not a second leak.
 * - **Boot sweeps what an earlier process left** (`sweepRunDirs`, run when the
 *   factory is made — once, at server start): a server killed mid-match, or
 *   any version before this one, leaves directories nothing will remove. It
 *   touches only `m-…`/`spare-…` directories directly under `workDir`, and
 *   spares a directory some process is standing in (a JVM's cwd is its run
 *   dir; `/proc/<pid>/cwd` — so another server's live match survives even if
 *   it predates this code), one changed in the last `RUN_DIR_FRESH_MS` (being
 *   staged right now by another process), and crash records within the bound.
 *   Where `/proc` cannot be read the sweep does nothing and says so: a live
 *   directory cannot be told from a dead one, and guessing wrong deletes a
 *   running match's files.
 *
 *   Since Wave 22 the sweep also says **whose** each live directory is
 *   (`SweepResult.orphans`): a live dir with a re-attachable `jvm.json` is a
 *   match waiting to be picked back up rather than a stranger's, and that is
 *   the only thing that changed about the guard. A live dir with no readable
 *   `jvm.json` is still spared and still left alone — it may be another
 *   server's.
 *
 * ## A match outlives its server (Wave 22, §E)
 *
 * Until this wave a deploy ended every live game. `pm2 restart` exits this
 * process, and the `process.on('exit')` hook here **SIGKILLed every match JVM**
 * — so two docs-only pushes on 2026-09-26 killed the operator's match four
 * minutes apart and the client saw `forge:join was refused: unknown-match`.
 * The nightly 08:00 UTC restart had been doing the same thing silently since
 * the beginning.
 *
 * A match now survives the server that started it. Three things had to change,
 * and each of them is forced:
 *
 * 1. **The transport cannot be an inherited pipe.** A pipe dies with the
 *    process that created it, so a JVM reached over `stdio: ['pipe','pipe']`
 *    can never be spoken to again. Each run dir therefore carries two named
 *    pipes, `in.fifo` and `out.fifo` (`mkfifo`; there is no `mkfifoSync`), and
 *    the JVM's stdin/stdout are fds on those. Both ends open them **`O_RDWR`**,
 *    which on Linux succeeds without a peer and — the point — means neither
 *    side ever sees EOF because each is its own last writer. The bridge exits
 *    on stdin EOF, so an inherited read-only fd would end the match the moment
 *    the server let go. stderr is an `O_APPEND` fd on `bridge.stderr.txt`, not
 *    a pipe, for the same reason.
 * 2. **The JVM must not be in our process group, and nothing may kill it on
 *    the way out.** `detached: true`, `child.unref()`, and the exit hook no
 *    longer kills anything — it is the whole bug.
 * 3. **The new process has to be able to rebuild the match.** A re-attached
 *    JVM keeps Forge's game, but `Match`'s per-seat projectors, histories,
 *    cursors and parked asks live in the process that died. So every protocol
 *    line is appended to `<run>/stream.jsonl` as it is read, and a re-attach
 *    replays that file into the new `Match` before a single live line reaches
 *    it. Replay is deterministic — same lines, same order, same projector — so
 *    each seat's `seq` comes back identical, and `jvm.json` carries the match's
 *    **epoch** and its seats' owners. A client therefore resyncs on the cursor
 *    it already held, and seat 2 cannot come back as seat 1 (which would hand
 *    them the other player's hand).
 *
 * `jvm.json` is the handle: `{matchId, pid, run, epoch, owners, spec, …}`,
 * written when a JVM is adopted by a match and rewritten when a seat is
 * claimed. At boot `orphans()` offers back every run dir whose recorded pid is
 * still the pid of a process whose cwd is that dir — the `/proc/<pid>/cwd`
 * check the boot sweep already used to spare a live directory, now asked
 * whose it is. `attach()` then re-opens the fifos and replays the stream.
 *
 * **Nothing keeps an orphan for ever.** A JVM with no server to talk to is
 * pure cost: `ORPHAN_MAX_MS` past its `orphanedAt` it is not re-attached at
 * all but killed and swept; one nobody claims within `ORPHAN_CLAIM_MS` of boot
 * is killed too (so a caller that ignores `orphans()` cannot leak a JVM); and
 * a re-attached match whose seats never come back is stopped by the
 * rejoin grace every match with no seat here arms (`Match.armRejoinGrace`,
 * bound `MatchDeps.rejoinGraceMs`, 5 minutes from `attachPlay`), whose callback
 * `stop()`s the match unless a seat has come back first.
 * **There is no `Match.expectRejoin`**: this comment named one for a wave and
 * the method has never existed — `grep -rn expectRejoin apps packages` finds
 * prose only. Do not reintroduce the name.
 * A `--spare` JVM is never re-attached — it holds no game — and is killed at
 * boot from its own `jvm.json`.
 *
 * ## Going down: what must die before we do (Wave 22, lane U)
 *
 * A match that is handed over outlives us on purpose. **Everything else must
 * not**, and until lane U nothing made sure of it. Two holes, both real:
 *
 * 1. **It was never told.** `MatchRegistry.handOver` only considers a match
 *    that is `starting` or `running` (`match.ts`), so a game that FINISHED
 *    during the run — status `over`, and it stays there for `overGraceMs`,
 *    which is **ten minutes** (`socket.ts`) — was in neither the handed half
 *    nor the ending half. Nobody stopped it, which is why the leaked JVM lane S
 *    found had no `orphanedAt` in its record: the server had not handed it over
 *    *and* had not asked it to stop. `socket.ts`'s `shutdown` now ends every
 *    match it is not handing over, whatever status it ended in — the status a
 *    match stopped in is not its JVM's business.
 * 2. **And being told is not enough, because the bridge is slow.** Measured on
 *    this host against a real match JVM (lane U, `forge.jar`):
 *
 *        {"t":"stop"} → gone    9355 ms   the bridge closes its clients and
 *                                         stops Netty before `halt(0)`
 *        SIGTERM      → gone    4322 ms   Forge's own shutdown hooks
 *        SIGKILL      → gone       0 ms
 *        {"t":"stop"} → gone     314 ms   an idle warm SPARE: `halt(0)` at once
 *
 *    `stopGraceMs` is 5 s, `SHUTDOWN_DEADLINE_MS` is 5 s, and pm2 SIGKILLs US
 *    after `kill_timeout` (1.6 s). There is no budget in which a polite stop or
 *    a SIGTERM can finish, so waiting for one is not a tighter deadline — it is
 *    a deploy that hangs and then loses the JVM anyway. It is also why the
 *    escalation in `stop()` cannot be the answer here: both its timers are
 *    `unref`'d and the process is gone about a millisecond later.
 *
 * So `reapOnExit()` is the last word, and it is **synchronous and immediate**:
 * SIGKILL every JVM this process still holds and did not hand over, then
 * confirm it is gone and remove its run directory. It costs a deploy nothing —
 * there is no grace to spend — and `SHUTDOWN_DEADLINE_MS` is untouched.
 *
 * The pid it signals is confirmed the way `orphans()` confirms one, through
 * `/proc/<pid>/cwd`: a recycled pid is some other program, and the one thing
 * this must never do is kill a stranger's JVM. A JVM whose kill did not take
 * keeps its directory, because it is still standing in it and the next boot's
 * sweep needs that to spare, find or end it.
 *
 * ## The line protocol
 *
 * `bridge/PlayBridge.java` writes one JSON object per line on stdout and reads
 * one per line on stdin. Its class comment has the list. Stdout carries nothing
 * else — the bridge points `System.out` at stderr before Forge loads — so a line
 * that is not JSON is a bug and is logged, not parsed.
 *
 * ## Configuration (environment)
 *
 *   CARDTABLE_FORGE_JAR        the fat jar, `forge-gui-desktop-*-jar-with-dependencies.jar`  (required)
 *   CARDTABLE_FORGE_RES        Forge's `forge-gui/res` directory                              (required)
 *   CARDTABLE_JAVA             a JDK 21 `java`; default: `~/.local/opt/jdk-21*\/bin/java` (D14), then `java`
 *   CARDTABLE_PLAY_WORK_DIR    per-match run directories; default `<os tmpdir>/cardtable-play`
 *   CARDTABLE_PLAY_JVM_OPTS    extra JVM flags, space-separated; `-Xmx1g` is added unless one names `-Xmx`
 *   CARDTABLE_PLAY_WARM_SPARE  `0` to start every match cold; default on
 *   CARDTABLE_PLAY_BRIDGE_CACHE  where the compiled bridge is kept; default `~/.cache/cardtable/bridge`
 *
 * The bridge is one source file with no build step, and nothing compiled lands
 * in the repo: the pool compiles it itself, once per version, and launches the
 * classes (`bridgeLaunch`). Either way it needs a JDK — `javac` to compile, or
 * `jdk.compiler` for the source launcher it falls back to — which is why the
 * default is the user-local Temurin rather than the JRE on `PATH`, the same
 * trap `CLAUDE.md` describes for `javac`.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
	appendFileSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from 'node:fs';
import { Socket } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { AbortReasonSchema, ClientAction, GameLogLine, Loss, SendYieldUpdate } from '@hadoku/forge-wire';

import { playWorkDir } from '../config.js';
import { jsonLogger } from '../log.js';

/* ── What a host is ──────────────────────────────────────────────────── */

export interface SeatSpec {
	/** Forge's player name. Shown to both seats, so never an identity. */
	name: string;
	ai: boolean;
	/** `.dck` text, or null for a random Forge precon. */
	deck: string | null;
}

export interface MatchSpec {
	seats: [SeatSpec, SeatSpec];
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
	| { t: 'pace'; seat: number; skipPhaseDelay: boolean; at: number };

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
	 * Write down what a re-attach of this match would need that only the match
	 * knows: its epoch, and which participant owns each seat. Absent on a host
	 * that cannot outlive the process (the replay host in the tests).
	 */
	remember?(state: { epoch: string; owners: (string | null)[] }): void;
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
 * What one detached JVM is, from outside the process that started it —
 * `<run>/jvm.json`. Everything a re-attach needs and nothing a seat could not
 * already see: `owners` are participant ids, which never leave this host.
 */
export interface JvmRecord {
	/** The match's id, which is also the JVM's own id after `adopt`. */
	matchId: string;
	pid: number;
	run: string;
	startedAt: string;
	/** The match's epoch, so a re-attached client resyncs on the cursor it holds. */
	epoch: string | null;
	/** seat → participant id, so a re-attach cannot seat someone at the wrong hand. */
	owners: (string | null)[];
	/** Null only for a spare, which has no match and is never re-attached. */
	spec: MatchSpec | null;
	/** A `--spare` JVM holds no game and is never re-attached. */
	spare?: boolean;
	/** Set when a server handed this JVM over on its way out. */
	orphanedAt?: string;
}

/**
 * Makes a host for one match. `close`, when present, releases whatever the
 * factory holds between matches (the JVM pool's spare); `attachPlay`'s
 * `close()` calls it. `orphans`/`attach` are the re-attach seam — a factory
 * whose JVMs cannot outlive the process has neither.
 */
export type MatchHostFactory = ((matchId: string, spec: MatchSpec, events: HostEvents) => MatchHost) & {
	close?(): void;
	/** Matches still running from an earlier server, oldest first. Read once, at boot. */
	orphans?(): JvmRecord[];
	/** Take one back: re-open its transport and replay its stream into `events` before returning. */
	attach?(record: JvmRecord, events: HostEvents): MatchHost;
	/** Leave every live match running for the next process (SIGTERM). */
	handOverAll?(): void;
	/**
	 * The last word before `process.exit`: kill every JVM this process still
	 * holds and did not hand over. Synchronous, immediate, and idempotent — see
	 * "Going down" in the module header. Absent on a factory whose hosts die with
	 * this process anyway (the replay host in the tests).
	 */
	reapOnExit?(): ReapResult;
};

/** What `reapOnExit` did, by JVM id, for the shutdown log. */
export interface ReapResult {
	/** Confirmed gone because we killed them, and their run directories removed. */
	killed: string[];
	/** Already gone, or already handed over. Nothing to do and nothing owed. */
	kept: string[];
	/** Still running after the kill. A leak, said out loud — the boot sweep is the next chance. */
	left: string[];
}

/** See "The ceiling" in the module header. Also `PlayDeps.maxMatches`'s default. */
export const MAX_CONCURRENT_MATCHES = 10;

/** The per-JVM heap cap, unless `CARDTABLE_PLAY_JVM_OPTS` sets its own. See "The ceiling". */
const DEFAULT_JVM_HEAP = '-Xmx1g';

/** A spare that died idle is replaced after this long… */
const SPARE_RETRY_MS = 5000;
/** …and after this many such deaths in a row, not at all. */
export const SPARE_MAX_FAILURES = 3;

const LINE_TYPES = new Set(['ready', 'frame', 'probe', 'gameover', 'log', 'fatal', 'rejected', 'stale', 'unsupported', 'pace', 'resent']);

/** A line from the bridge, or null for one that is not a protocol line. */
function parseBridgeLine(text: string): BridgeLine | null {
	if (!text.startsWith('{')) return null;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (_err) {
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;
	const t = (value as { t?: unknown }).t;
	return typeof t === 'string' && LINE_TYPES.has(t) ? (value as BridgeLine) : null;
}

/* ── The JVM host ────────────────────────────────────────────────────── */

export interface JvmHostConfig {
	java: string;
	jar: string;
	res: string;
	workDir: string;
	jvmOpts: string[];
	bridgeSource: string;
	/** Compiled bridges, one directory per version. See `bridgeLaunch`. */
	bridgeCache: string;
	/** `stop()` sends SIGTERM after this long without an exit, and SIGKILL after twice it. */
	stopGraceMs: number;
	/** Keep one booted JVM waiting for the next match. See "The warm spare". */
	warmSpare: boolean;
}

export type JvmAvailability = { ok: true; config: JvmHostConfig } | { ok: false; reason: string };

function defaultJava(): string {
	const opt = join(homedir(), '.local', 'opt');
	if (existsSync(opt)) {
		const jdk = readdirSync(opt)
			.filter((d) => d.startsWith('jdk-21'))
			.sort()
			.map((d) => join(opt, d, 'bin', 'java'))
			.find((p) => existsSync(p));
		if (jdk !== undefined) return jdk;
	}
	return 'java';
}

/**
 * `src/play/bridge/PlayBridge.java` from here under `tsx`, or from `dist/` in
 * the bundle, where `import.meta.url` is `dist/index.js`.
 */
function defaultBridgeSource(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [join(here, 'bridge', 'PlayBridge.java'), resolve(here, '..', 'src', 'play', 'bridge', 'PlayBridge.java')];
	return candidates.find((p) => existsSync(p)) ?? (candidates[0] as string);
}

/** `DEFAULT_JVM_HEAP` first, unless the operator named a heap cap of their own. */
export function withHeapCap(opts: string[]): string[] {
	return opts.some((o) => o.startsWith('-Xmx')) ? opts : [DEFAULT_JVM_HEAP, ...opts];
}

/** Resolve the JVM host's configuration, or say exactly what is missing. */
export function jvmHostConfig(env: NodeJS.ProcessEnv = process.env): JvmAvailability {
	const jar = env.CARDTABLE_FORGE_JAR ?? '';
	const res = env.CARDTABLE_FORGE_RES ?? '';
	if (jar === '') return { ok: false, reason: 'CARDTABLE_FORGE_JAR is not set' };
	if (!existsSync(jar)) return { ok: false, reason: `CARDTABLE_FORGE_JAR does not exist: ${jar}` };
	if (res === '') return { ok: false, reason: 'CARDTABLE_FORGE_RES is not set' };
	if (!existsSync(join(res, 'cardsfolder'))) {
		return { ok: false, reason: `CARDTABLE_FORGE_RES is not Forge's res/ (no cardsfolder): ${res}` };
	}
	const bridgeSource = defaultBridgeSource();
	if (!existsSync(bridgeSource)) return { ok: false, reason: `bridge source not found: ${bridgeSource}` };
	return {
		ok: true,
		config: {
			java: env.CARDTABLE_JAVA ?? defaultJava(),
			jar: resolve(jar),
			res: resolve(res),
			workDir: playWorkDir(env),
			jvmOpts: withHeapCap((env.CARDTABLE_PLAY_JVM_OPTS ?? '').split(/\s+/).filter((s) => s !== '')),
			bridgeSource,
			bridgeCache: resolve(env.CARDTABLE_PLAY_BRIDGE_CACHE ?? join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'cardtable', 'bridge')),
			stopGraceMs: 5000,
			warmSpare: env.CARDTABLE_PLAY_WARM_SPARE !== '0',
		},
	};
}

/* ── The bridge, compiled once ───────────────────────────────────────── */

/**
 * A compiled bridge nobody has launched for this long is removed when the next
 * one is compiled. Far past `ORPHAN_MAX_MS`, so no JVM that could still load a
 * class from it is alive.
 */
export const BRIDGE_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * What a bridge JVM is launched with after its flags: `-cp <classpath> <main>`.
 *
 * Launching the SOURCE (`java -cp <jar> PlayBridge.java`, JEP 330) compiles the
 * whole file inside every JVM before `main` runs — about 0.6 s of a 5 s cold
 * start (median 5.68 s against 5.03 s over sixteen alternating starts,
 * 2026-10-06). So it is
 * compiled once instead, by the `javac` beside `config.java`, into a directory
 * named for a hash of everything that decides the result: the source's bytes,
 * the jar it is compiled against, and the JDK. An edited bridge is therefore a
 * different directory, never a stale one, and it still takes effect at the next
 * JVM with no restart, as it did under the source launcher. `-proc:none` is what
 * that launcher does too.
 *
 * Two processes may compile the same version at once (a deploy beside a CI job):
 * each compiles into its own temporary directory and RENAMES it into place, so a
 * JVM never sees half a directory, and the loser's copy is deleted.
 *
 * With no `javac` there (a `java` from `PATH`), or a compile that fails, this is
 * the source launcher exactly as before, and a failed compile is logged. Each
 * `jvm-spawned` line says which one that JVM got.
 *
 * `-sourcepath <bridgeSource's own directory>` is on every `javac` invocation
 * (wave 73 §D): `PlayBridge.java` and `PoolService.java` sit beside each other
 * there, and `PoolService.java` calls `PlayBridge.forgeCardName` — a
 * package-private static method, reachable because both are top-level classes
 * in the same (unnamed) package — so compiling `PoolService.java` alone needs
 * `javac` to find and compile `PlayBridge.java` too. It is a no-op for
 * `PlayBridge.java`'s own compile: nothing in that file references a sibling
 * class `javac` cannot already resolve from the jar, so `-sourcepath` is never
 * consulted and the compiled output is unchanged. The one thing this does NOT
 * do is track `PlayBridge.java` as an input to `PoolService.java`'s cache key
 * (`version`, below, hashes only `config.bridgeSource`'s own bytes) — an edit
 * to `PlayBridge.java` alone, with `PoolService.java` untouched, would reuse a
 * stale compiled `PlayBridge.class` until `PoolService.java` next changes or
 * the cache is pruned. Not a concern this wave (nothing edits `PlayBridge.java`
 * here); a wave that does should widen this.
 */
export function bridgeLaunch(config: JvmHostConfig, log: (entry: Record<string, unknown>) => void): { args: string[]; how: 'compiled' | 'source' } {
	const source = { args: ['-cp', config.jar, config.bridgeSource], how: 'source' as const };
	const javac = join(dirname(config.java), 'javac');
	if (!existsSync(javac)) return source;
	const main = basename(config.bridgeSource, '.java');
	let dir: string;
	try {
		const jar = statSync(config.jar);
		const version = createHash('sha256')
			.update(readFileSync(config.bridgeSource))
			.update(JSON.stringify([config.jar, jar.size, jar.mtimeMs, realpathSync(config.java)]))
			.digest('hex')
			.slice(0, 24);
		dir = join(config.bridgeCache, version);
	} catch (err) {
		log({ evt: 'bridge-compile-failed', error: (err as Error).message });
		return source;
	}
	const compiled = { args: ['-cp', `${dir}:${config.jar}`, main], how: 'compiled' as const };
	if (existsSync(join(dir, `${main}.class`))) {
		try {
			// Launched now, so not stale: the pruning below goes by this.
			const now = new Date();
			utimesSync(dir, now, now);
			return compiled;
		} catch {
			// Pruned by another process between the check and here. Compile it again.
		}
	}
	const staging = `${dir}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
	const started = Date.now();
	try {
		mkdirSync(staging, { recursive: true });
		const javacRun = spawnSync(
			javac,
			['-proc:none', '-nowarn', '-cp', config.jar, '-sourcepath', dirname(config.bridgeSource), '-d', staging, config.bridgeSource],
			{ encoding: 'utf8', timeout: 120_000 },
		);
		if (javacRun.status !== 0 || !existsSync(join(staging, `${main}.class`))) {
			throw new Error(`javac exited ${javacRun.status ?? javacRun.signal ?? javacRun.error?.message}: ${(javacRun.stderr ?? '').slice(-2000)}`);
		}
		try {
			renameSync(staging, dir);
		} catch (err) {
			// Another process put the same version there first. Theirs is as good as ours.
			if (!existsSync(join(dir, `${main}.class`))) throw err;
		}
		log({ evt: 'bridge-compiled', dir, ms: Date.now() - started });
	} catch (err) {
		log({ evt: 'bridge-compile-failed', error: (err as Error).message });
		return source;
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	try {
		for (const entry of readdirSync(config.bridgeCache)) {
			const other = join(config.bridgeCache, entry);
			if (other !== dir && Date.now() - statSync(other).mtimeMs > BRIDGE_CACHE_MAX_AGE_MS) rmSync(other, { recursive: true, force: true });
		}
	} catch (err) {
		// Housekeeping only: the bridge this JVM needs is compiled and in place.
		log({ evt: 'bridge-cache-prune-failed', dir: config.bridgeCache, error: (err as Error).message });
	}
	return compiled;
}

/* ── A JVM that outlives us: the fifos, the record, the stream ───────── */

/** The JVM's stdin. Both ends open it `O_RDWR`; see "A match outlives its server". */
const IN_FIFO = 'in.fifo';
/** The JVM's stdout, same treatment. */
const OUT_FIFO = 'out.fifo';
/** `JvmRecord` — the handle a later process re-attaches by. */
export const JVM_RECORD_FILE = 'jvm.json';
/** Every protocol line, as read, so a re-attach can replay the match into a fresh `Match`. */
export const STREAM_FILE = 'stream.jsonl';
/**
 * The JVM's `java.io.tmpdir`. Forge's lz4-java unpacks a native `.so` there on
 * every boot and only removes it on a clean JVM exit, which a SIGKILLed bridge
 * never has — so under the default `/tmp` every killed match leaked one copy
 * (3,036 of them on the host's RAM-backed /tmp, 2026-10-10). Inside the run dir it
 * goes wherever the run dir goes: removed on a clean end, pruned on a crash.
 */
const JVM_TMP_DIR = 'tmp';

/** An orphan older than this is not re-attached: it is killed and swept. */
export const ORPHAN_MAX_MS = 12 * 60 * 60 * 1000;
/**
 * An orphan nobody claimed this long after boot is killed. A caller that never
 * calls `orphans()` therefore cannot leak a JVM, and the spare comes back.
 */
export const ORPHAN_CLAIM_MS = 60_000;
/** How often an attached JVM (which is nobody's child, so has no `exit` event) is checked for. */
const PID_POLL_MS = 1000;

/**
 * Two named pipes in the run dir. `mkfifo(3)` has no binding in `node:fs`, so
 * this shells out — once per run directory, at staging time.
 */
function makeFifos(run: string): void {
	const made = spawnSync('mkfifo', [join(run, IN_FIFO), join(run, OUT_FIFO)], { stdio: 'pipe' });
	if (made.error !== undefined) throw made.error;
	if (made.status !== 0) {
		throw new Error(`mkfifo failed in ${run} (status ${made.status}): ${made.stderr?.toString().trim() ?? ''}`);
	}
}

/**
 * The transport to one JVM, either end of which may be opened by a process that
 * did not create it. Both fds are `O_RDWR` so neither side ever reads EOF —
 * the bridge would exit on one, and we could not tell a handed-over JVM from a
 * dead one.
 */
interface JvmIo {
	writeFd: number;
	lines: NodeJS.ReadableStream;
	close(): void;
}

/**
 * The read end is a `net.Socket` over the fd, **not** `fs.createReadStream`.
 * That is not a style choice: `fs.read` on a blocking fifo fd parks a libuv
 * THREADPOOL thread for as long as the fifo is empty, and the pool is four
 * threads by default. Two matches and a spare is three readers waiting on a
 * quiet Forge, and the fourth thread is every other piece of async file work
 * this process does — which is how the first version of this deadlocked
 * `host.test.ts` outright. `net.Socket` puts the fd in libuv's event loop
 * (`uv_pipe_open`, epoll) and occupies no thread at all.
 */
function openJvmIo(run: string): JvmIo {
	const writeFd = openSync(join(run, IN_FIFO), 'r+');
	const readFd = openSync(join(run, OUT_FIFO), 'r+');
	const lines = new Socket({ fd: readFd, readable: true, writable: false });
	lines.on('error', () => {
		// The fd went with the JVM, or was closed under us. The exit path says why.
	});
	return {
		writeFd,
		lines,
		close(): void {
			lines.destroy();
			try {
				closeSync(writeFd);
			} catch {
				// Already closed, or the fd went with the stream. Nothing to recover.
			}
		},
	};
}

/** `<run>/jvm.json`, or null when it is missing, unreadable or not a record. */
export function readJvmRecord(run: string): JvmRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(run, JVM_RECORD_FILE), 'utf8'));
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const record = parsed as Partial<JvmRecord>;
	if (typeof record.matchId !== 'string' || typeof record.pid !== 'number' || typeof record.run !== 'string') return null;
	// A spare carries no spec; anything else without one is not re-attachable.
	const hasSpec = record.spec !== null && record.spec !== undefined && Array.isArray(record.spec.seats) && record.spec.seats.length === 2;
	if (!hasSpec && record.spare !== true) return null;
	return {
		matchId: record.matchId,
		pid: record.pid,
		run: record.run,
		startedAt: typeof record.startedAt === 'string' ? record.startedAt : new Date(0).toISOString(),
		epoch: typeof record.epoch === 'string' ? record.epoch : null,
		owners: Array.isArray(record.owners) ? record.owners.map((o) => (typeof o === 'string' ? o : null)) : [],
		spec: hasSpec ? (record.spec as MatchSpec) : null,
		...(record.spare === true ? { spare: true } : {}),
		...(typeof record.orphanedAt === 'string' ? { orphanedAt: record.orphanedAt } : {}),
	};
}

/**
 * Is `pid` still the process standing in `run`? The cwd check is what makes
 * this safe against pid reuse: a recycled pid is some other program, in some
 * other directory. Null when `/proc` cannot answer.
 */
function pidIsStandingIn(pid: number, run: string): boolean | null {
	let cwd: string;
	try {
		cwd = readlinkSync(`/proc/${pid}/cwd`);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ESRCH') return false;
		// EACCES/EPERM: the process exists and is not ours to inspect. Not ours to claim either.
		if (code === 'EACCES' || code === 'EPERM') return false;
		return null;
	}
	return cwd === run;
}

/**
 * `pidIsStandingIn`, tolerant of a work dir reached through a symlink: `/proc`
 * answers with the resolved path and `stageRunDir` did not resolve one, so the
 * two spellings can differ. `sweepRunDirs` avoids this by resolving `workDir`
 * itself; a JVM holding its own `run` string has to ask both ways.
 */
function pidIsStandingInRun(pid: number, run: string): boolean {
	if (pidIsStandingIn(pid, run) === true) return true;
	let resolved: string;
	try {
		resolved = realpathSync(run);
	} catch {
		return false;
	}
	return resolved !== run && pidIsStandingIn(pid, resolved) === true;
}

/**
 * Alive, and not a zombie waiting to be reaped. A zombie still answers signal 0
 * — it has a pid until its parent collects it — so `/proc/<pid>/stat` is what
 * decides. `e2e/play.spec.ts` asks the same question the same way, on purpose:
 * the contract it checks and the code that keeps it should not disagree about
 * what "still running" means.
 */
function pidIsRunning(pid: number): boolean {
	try {
		return !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
	} catch {
		return false; // no /proc entry: it has exited
	}
}

/** How long `reapOnExit` will spin waiting for a SIGKILL to land. Measured at 0 ms. */
const REAP_CONFIRM_MS = 100;

/**
 * Block this thread for `ms`. Only ever used by `reapOnExit`, which runs with
 * `process.exit` a statement or two away: the JVM's death has to be confirmed
 * before we stop existing, and there is no later tick in which to confirm it.
 */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Forge resolves `res/` against the working directory (`ForgeConstants.RES_DIR`
 * is "res/" when the version string carries no "git"), and reads its user and
 * cache dirs from `forge.profile.properties` there. So each match gets its own
 * directory — the same staging `scripts/spike/tierc/run.sh` does — and
 * nothing is written into the Forge build it reads from.
 */
function stageRunDir(config: JvmHostConfig, name: string): string {
	const run = join(config.workDir, name);
	rmSync(run, { recursive: true, force: true });
	mkdirSync(join(run, 'user', 'decks', 'constructed'), { recursive: true });
	mkdirSync(join(run, 'user', 'preferences'), { recursive: true });
	mkdirSync(join(run, 'cache'), { recursive: true });
	mkdirSync(join(run, JVM_TMP_DIR), { recursive: true });
	symlinkSync(config.res, join(run, 'res'));
	makeFifos(run);
	writeFileSync(
		join(run, 'forge.profile.properties'),
		[
			`userDir=${run}/user/`,
			`cacheDir=${run}/cache/`,
			`decksDir=${run}/user/decks/`,
			`decksConstructedDir=${run}/user/decks/constructed/`,
			'',
		].join('\n'),
	);
	// ForgeConstants.MAIN_PREFS_FILE = <userDir>/preferences/forge.preferences
	// (ForgeConstants.java:247,275); AbstractPreferences reads it line by line
	// before FModel.initialize's callback runs (AbstractPreferences.java:41-67).
	writeFileSync(join(run, 'user', 'preferences', 'forge.preferences'), forgePreferencesFile());
	return run;
}

/**
 * Forge preferences every match runs with, and why each one is here.
 *
 * These are **Forge's own settings**, not rules: each turns off a desktop-UI
 * behaviour that makes no sense for a browser client, and the file is the
 * documented way to set them (`AbstractPreferences`). A JVM is one match, so
 * the file is written per run directory and nothing outlives it.
 */
export const FORGE_PREFERENCES: Readonly<Record<string, string>> = {
	/**
	 * Wave 19, #12 — *"when i cast preordain it showed the whole library with
	 * all the cards numbered? thats quite odd"*.
	 *
	 * With this pref true (its default, `ForgePreferences.java:157`),
	 * `PlayerControllerHuman.arrangeForScry` hands the GUI
	 * `player.getCardsIn(ZoneType.Library)` — **the whole library** — as the
	 * pile to rearrange, with only the scried cards `manipulable`
	 * (`PlayerControllerHuman.java:1006-1012`). The desktop UI renders that as
	 * a drag inside its library display; a browser client has no such display
	 * and draws every row, most of them cards the seat is not allowed to see
	 * and so cannot name.
	 *
	 * **Re-measured wave 64 §S (S10), against the pinned jar
	 * (`702b207eda874df8bae60435284f40836ed8799c`), with this pref flipped
	 * BOTH ways on the exact same scripted Preordain (`scenarios/w62-scry.state`,
	 * a 6-card library): `true` (Forge's default) sends `manipulateCardList`
	 * with all 6 cards and 2 `manipulable` — still exactly the bug #12
	 * complains about, numbers scaling with the library — and `false` (this
	 * file's override) sends `order` instead, title "Select cards to be put
	 * on the bottom of your library", `sourceChoices` carrying ONLY the two
	 * scried cards. The pref is still the one thing deciding which of these
	 * two asks Forge opens for a scry — nothing else in this file or in
	 * `auto.ts` branches on it — so it is still needed, and the value stays
	 * `'false'`. The method name `order` was missing from this comment before
	 * this measurement (`docs/.../wave62-evidence/S/scry.md`, 2026-10-08,
	 * independently confirmed the same false-branch shape for Serum Visions
	 * and Preordain, from the UI side rather than this pref's own doc) — this
	 * paragraph is what was stale, not the mechanism.
	 */
	UI_SELECT_FROM_CARD_DISPLAYS: 'false',
};

function forgePreferencesFile(): string {
	return [
		'# Written per run directory by apps/server/src/play/host.ts. See FORGE_PREFERENCES.',
		...Object.entries(FORGE_PREFERENCES).map(([key, value]) => `${key}=${value}`),
		'',
	].join('\n');
}

/* ── What is left of a run directory ─────────────────────────────────── */

/** Crash records kept at most, newest first. See "The run directory". */
export const CRASH_RECORDS_KEPT = 20;
/** A crash record older than this is removed. */
export const CRASH_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The boot sweep leaves a directory changed this recently: another process may be staging it. */
export const RUN_DIR_FRESH_MS = 60_000;
/** What a crashed JVM's directory is pruned to. `crash.json` marks it as a record. */
export const CRASH_RECORD_FILES = ['bridge.stderr.txt', 'config.json', 'crash.json'] as const;
const CRASH_MARKER = 'crash.json';

/** Match (`newMatchId`) and spare ids. Nothing else under `workDir` is ours to remove. */
const RUN_DIR_NAME = /^(m|spare)-[0-9a-f]{12}$/;

/** Why a JVM that did not end cleanly ended — written as `crash.json`. */
export interface CrashRecord {
	id: string;
	reason: string;
	code: number | null;
	signal: string | null;
	at: string;
}

/** Keep the diagnostics, drop Forge's scaffolding (the `res` symlink is unlinked, never followed). */
function keepCrashRecord(run: string, record: CrashRecord): void {
	const keep = new Set<string>(CRASH_RECORD_FILES);
	for (const entry of readdirSync(run)) {
		if (!keep.has(entry)) rmSync(join(run, entry), { recursive: true, force: true });
	}
	writeFileSync(join(run, CRASH_MARKER), `${JSON.stringify(record, null, 2)}\n`);
}

/** Our run directories directly under `workDir`, as real paths. */
function runDirs(workDir: string): { name: string; dir: string; mtimeMs: number }[] {
	if (!existsSync(workDir)) return [];
	const root = realpathSync(workDir);
	const dirs: { name: string; dir: string; mtimeMs: number }[] = [];
	for (const name of readdirSync(root)) {
		if (!RUN_DIR_NAME.test(name)) continue;
		const dir = join(root, name);
		const stat = lstatSync(dir);
		if (stat.isDirectory()) dirs.push({ name, dir, mtimeMs: stat.mtimeMs });
	}
	return dirs;
}

/** When a crash record was written: its own `at`, else the directory's mtime. */
function crashTime(dir: string, mtimeMs: number): number {
	const at = Date.parse((JSON.parse(readFileSync(join(dir, CRASH_MARKER), 'utf8')) as { at?: string }).at ?? '');
	return Number.isNaN(at) ? mtimeMs : at;
}

/**
 * Enforce the crash-record bound: the newest `CRASH_RECORDS_KEPT` within
 * `CRASH_RECORD_MAX_AGE_MS` stay, the rest go. Returns what it removed.
 */
function pruneCrashRecords(workDir: string, now = Date.now()): { kept: string[]; removed: string[] } {
	const records = runDirs(workDir)
		.filter((d) => existsSync(join(d.dir, CRASH_MARKER)))
		.map((d) => ({ ...d, at: crashTime(d.dir, d.mtimeMs) }))
		.sort((a, b) => b.at - a.at);
	const kept: string[] = [];
	const removed: string[] = [];
	for (const r of records) {
		if (kept.length < CRASH_RECORDS_KEPT && now - r.at <= CRASH_RECORD_MAX_AGE_MS) {
			kept.push(r.name);
		} else {
			rmSync(r.dir, { recursive: true, force: true });
			removed.push(r.name);
		}
	}
	return { kept, removed };
}

/**
 * The working directory of every process on this host that we can see, or
 * null when `/proc` cannot say (not Linux). A process that exits between the
 * listing and the readlink, or belongs to another user, is not standing in one
 * of our directories.
 */
function processCwds(): string[] | null {
	let pids: string[];
	try {
		pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
	const cwds: string[] = [];
	for (const pid of pids) {
		try {
			cwds.push(readlinkSync(`/proc/${pid}/cwd`));
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'ESRCH' && code !== 'EPERM') throw err;
		}
	}
	return cwds;
}

export interface SweepResult {
	/** Directories removed: dead, not fresh, not a crash record within the bound. */
	removed: string[];
	/** Spared: some process is standing in it — a running JVM, ours or another server's. */
	live: string[];
	/** Spared: changed within `RUN_DIR_FRESH_MS`. */
	fresh: string[];
	/** Crash records kept, and those the bound removed. */
	crashes: { kept: string[]; removed: string[] };
	/**
	 * Live directories that name themselves: a match from an earlier server whose
	 * JVM is still the process standing in its run dir. Oldest first, ready for
	 * `attach`. A subset of `live` — the rest of `live` is spared and untouched.
	 */
	orphans: JvmRecord[];
	/**
	 * Live directories the sweep ENDED, because their own `jvm.json` said they
	 * were worthless: a `--spare` JVM (it holds no game) or an orphan past
	 * `ORPHAN_MAX_MS`. Only ever a dir whose recorded pid is the very process
	 * standing in it.
	 */
	killed: string[];
	/** Set when the sweep did nothing, and why. */
	skipped?: string;
}

/**
 * Remove the run directories an earlier process left behind, and hand back the
 * ones that are still playing. See "The run directory" and "A match outlives
 * its server" in the module header for what it spares and why.
 */
export function sweepRunDirs(workDir: string, now = Date.now()): SweepResult {
	const result: SweepResult = { removed: [], live: [], fresh: [], crashes: { kept: [], removed: [] }, orphans: [], killed: [] };
	const cwds = processCwds();
	if (cwds === null) return { ...result, skipped: '/proc is not readable, so a live run directory cannot be told from a dead one' };
	for (const { name, dir, mtimeMs } of runDirs(workDir)) {
		if (cwds.some((cwd) => cwd === dir || cwd.startsWith(dir + sep))) {
			// LIVE. Some process is standing here, so the directory is not ours to
			// remove on a guess — that guard is why another server's match survives.
			// The only question this branch asks is whose it is, and it is answered
			// by the directory itself: a `jvm.json` whose pid IS the process
			// standing here is one of ours and says what it is worth.
			const record = readJvmRecord(dir);
			// `pidIsStandingIn` is the whole identity check, and it is exact: the
			// recorded pid must be the very process whose cwd is THIS directory. The
			// record's own `run` string is deliberately not compared — `runDirs`
			// resolves `workDir` through `realpath` and the writer did not, so on a
			// host where the work dir is reached through a symlink the two spellings
			// differ and a match would silently stop being re-attachable.
			const mine = record !== null && pidIsStandingIn(record.pid, dir) === true;
			const age = record === null ? 0 : now - Date.parse(record.orphanedAt ?? record.startedAt);
			if (mine && record !== null && (record.spare === true || !(age < ORPHAN_MAX_MS))) {
				// Worthless with certainty: a spare holds no game, and an orphan this
				// old is not a match anybody is coming back to.
				killPid(record.pid);
				rmSync(dir, { recursive: true, force: true });
				result.killed.push(name);
				continue;
			}
			result.live.push(name);
			if (mine && record !== null) result.orphans.push(record);
			continue;
		}
		if (existsSync(join(dir, CRASH_MARKER))) continue; // the bound decides, below
		if (now - mtimeMs < RUN_DIR_FRESH_MS) result.fresh.push(name);
		else {
			rmSync(dir, { recursive: true, force: true });
			result.removed.push(name);
		}
	}
	result.orphans.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
	result.crashes = pruneCrashRecords(workDir, now);
	return result;
}

/** SIGKILL a pid we own, or say nothing: it may have gone between the check and here. */
function killPid(pid: number): void {
	try {
		process.kill(pid, 'SIGKILL');
	} catch {
		// ESRCH — already gone, which is the outcome we wanted.
	}
}

/** The config object the bridge reads — from `config.json` cold, or in a spare's `start` line. */
function bridgeConfig(matchId: string, spec: MatchSpec): Record<string, unknown> {
	return { matchId, ...spec };
}

/**
 * Every JVM this process is talking to and has not seen exit.
 *
 * Until Wave 22 a `process.on('exit')` hook here SIGKILLed every one of them,
 * which is exactly how a deploy ended the operator's game. There is no such
 * hook any more, on purpose: a match is meant to outlive this process, and an
 * orphan is bounded by `ORPHAN_MAX_MS` and the boot sweep instead of by our
 * last breath. See "A match outlives its server".
 */
const live = new Set<BridgeJvm>();

/** Number of bridge JVMs this process currently has running. */
export function liveJvmCount(): number {
	return live.size;
}

/** A spare's `{"t":"warm","bootMs":…,"match":…}`, or null for any other line. */
function parseWarmLine(text: string): { match: unknown; bootMs: number } | null {
	if (!text.startsWith('{')) return null;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (_err) {
		return null;
	}
	if (typeof value !== 'object' || value === null || (value as { t?: unknown }).t !== 'warm') return null;
	const { match, bootMs } = value as { match?: unknown; bootMs?: unknown };
	return { match, bootMs: typeof bootMs === 'number' ? bootMs : -1 };
}

/** How a `BridgeJvm` came to be: we started it, or an earlier server did. */
type JvmSource = { mode: 'spawn'; args: string[] } | { mode: 'attach'; record: JvmRecord };

/**
 * One bridge JVM. Its lines are checked against `id` — the spare's own id until
 * `adopt`, the match's after — and go to `events`, which a spare does not have
 * yet. Everything a match sees of it is the `MatchHost` that `adopt` returns.
 *
 * It is addressed by **pid**, not by a `ChildProcess`: a JVM re-attached from an
 * earlier server is nobody's child, so `child` is null for it and its death is
 * noticed by polling rather than by an `exit` event.
 */
class BridgeJvm {
	id: string;
	readonly run: string;
	readonly pid: number;
	/** Set when we spawned it; null for one re-attached from an earlier server. */
	private readonly child: ChildProcess | null = null;
	private readonly io: JvmIo;
	/** Where every protocol line is kept, so a later process can replay this match. */
	private readonly streamFile: string;
	/** False once a line could not be persisted: this match is no longer re-attachable. */
	private durable = true;
	/** The record on disk, from `adopt` or from the attach. Null while this JVM is a spare. */
	private record: JvmRecord | null = null;
	/** Set by `adopt`. Null while this JVM is a spare. */
	private events: HostEvents | null = null;
	/** The spare's `warm` line has arrived. A cold JVM never sends one. */
	warm = false;
	exited = false;
	private stopping = false;
	/** Handed to the next server: do not kill it, do not settle its run dir. */
	handedOver = false;
	/** `reapOnExit` SIGKILLed it on our way out. That exit is a deploy, not a crash. */
	private reapedOnExit = false;
	/** How it ended, set on exit and consumed when the run dir is settled. */
	private ending: 'clean' | { reason: string; code: number | null; signal: NodeJS.Signals | null } | null = null;
	private readonly killTimers: NodeJS.Timeout[] = [];
	private watch: NodeJS.Timeout | null = null;

	constructor(
		private readonly config: JvmHostConfig,
		run: string,
		id: string,
		source: JvmSource,
		private log: (entry: Record<string, unknown>) => void,
		private readonly hooks: { warm(jvm: BridgeJvm, bootMs: number): void; exit(jvm: BridgeJvm, reason: string): void },
	) {
		this.id = id;
		this.run = run;
		this.streamFile = join(run, STREAM_FILE);
		this.io = openJvmIo(run);
		if (source.mode === 'attach') {
			this.pid = source.record.pid;
			this.record = source.record;
			live.add(this);
			log({ evt: 'jvm-attached', id, pid: this.pid, run, orphanedAt: source.record.orphanedAt ?? null });
			// Reading starts only once the match has been replayed into `events` —
			// see `resume`. A live line that arrived first would have nowhere to go.
			this.watchPid();
			return;
		}
		// stderr is an appended FILE, not a pipe: a pipe dies with this process and
		// the JVM must not. It is also what a crash record keeps.
		const stderrFd = openSync(join(run, 'bridge.stderr.txt'), 'a');
		// The child gets its OWN fds on the fifos, closed here once it holds them.
		const childIn = openSync(join(run, IN_FIFO), 'r+');
		const childOut = openSync(join(run, OUT_FIFO), 'r+');
		const bridge = bridgeLaunch(config, log);
		let child: ChildProcess;
		try {
			child = spawn(
				config.java,
				['-Djava.awt.headless=true', `-Djava.io.tmpdir=${join(run, JVM_TMP_DIR)}`, ...config.jvmOpts, ...bridge.args, ...source.args],
				// `detached` puts it in its own process group, so a signal aimed at
				// ours never reaches it; `unref` keeps it off our event loop.
				{ cwd: run, stdio: [childIn, childOut, stderrFd], detached: true },
			);
		} finally {
			for (const fd of [childIn, childOut, stderrFd]) closeSync(fd);
		}
		child.unref();
		this.child = child;
		this.pid = child.pid ?? -1;
		live.add(this);
		const spare = source.args[0] === '--spare';
		log({ evt: 'jvm-spawned', id, pid: this.pid, run, spare, bridge: bridge.how });
		if (spare) {
			// A spare holds no game, so it is never re-attached — but it must still
			// be killable from disk if this process dies before it is adopted.
			this.record = { matchId: id, pid: this.pid, run, startedAt: new Date().toISOString(), epoch: null, owners: [], spec: null, spare: true };
			this.writeRecord({});
		}
		this.resume();
		child.on('error', (err) => this.onGone(`the JVM could not be started: ${err.message}`, { code: null, signal: null }));
		child.on('exit', (code, signal) => {
			this.log({ evt: 'jvm-exited', id: this.id, pid: this.pid, code, signal });
			this.onGone(this.stopping ? 'stopped' : `the JVM exited (code ${code}, signal ${signal}); see ${run}/bridge.stderr.txt`, { code, signal });
		});
	}

	/** Start reading the JVM's lines. Called at spawn, and after a replay on attach. */
	private resume(): void {
		createInterface({ input: this.io.lines }).on('line', (text) => this.onText(text));
	}

	/**
	 * An attached JVM is nobody's child, so there is no `exit` event for it. The
	 * cwd check is not repeated here: `sweepRunDirs` established that this pid is
	 * the process standing in this run dir, and a pid that dies is not reissued
	 * to a process that then stands in the same directory.
	 */
	private watchPid(): void {
		const timer = setInterval(() => {
			try {
				process.kill(this.pid, 0);
			} catch {
				this.log({ evt: 'jvm-exited', id: this.id, pid: this.pid, code: null, signal: null, attached: true });
				this.onGone(
					this.stopping ? 'stopped' : `the JVM exited; see ${this.run}/bridge.stderr.txt`,
					{ code: null, signal: null },
				);
			}
		}, PID_POLL_MS);
		timer.unref();
		this.watch = timer;
	}

	private onText(text: string): void {
		if (this.events === null) {
			const warm = parseWarmLine(text);
			if (warm !== null && warm.match === this.id) {
				this.warm = true;
				this.hooks.warm(this, warm.bootMs);
				return;
			}
		}
		const parsed = parseBridgeLine(text);
		if (parsed === null) {
			this.log({ evt: 'bridge-noise', id: this.id, text: text.slice(0, 200) });
			return;
		}
		const { match, ...line } = parsed as BridgeLine & { match?: unknown };
		if (match !== this.id) {
			this.log({ evt: 'bridge-wrong-match', matchId: this.id, got: match, line: line.t });
			return;
		}
		if (this.events === null) {
			// A spare has nothing to say but `warm` — except `fatal`, which its exit reports.
			this.log({ evt: 'spare-line', id: this.id, line: line.t });
			return;
		}
		this.persist(line as BridgeLine);
		this.events.line(line as BridgeLine);
	}

	/**
	 * Keep the line, so a later process can rebuild this match by replaying it.
	 * A line that cannot be kept makes the match un-re-attachable, and saying so
	 * means deleting the handle — a replay from a stream with a hole would give a
	 * seat a board Forge does not have.
	 */
	private persist(entry: BridgeLine | { c: Record<string, unknown> }): void {
		if (!this.durable) return;
		try {
			appendFileSync(this.streamFile, `${JSON.stringify(entry)}\n`);
		} catch (err) {
			this.durable = false;
			this.log({ evt: 'jvm-stream-broken', id: this.id, run: this.run, error: (err as Error).message });
			rmSync(join(this.run, JVM_RECORD_FILE), { force: true });
		}
	}

	private onGone(reason: string, how: { code: number | null; signal: NodeJS.Signals | null }): void {
		if (this.exited || this.handedOver) return;
		this.exited = true;
		// Clean is only a stop we asked for that the bridge finished itself (`halt(0)`).
		// One that took our SIGTERM/SIGKILL hung, and is kept like any crash. An
		// ATTACHED JVM has no exit code to read — nobody waited on it — so a stop we
		// asked for is taken at its word. A JVM `reapOnExit` killed is clean too: no
		// polite stop fits a deploy (see "Going down"), so the signal is the design
		// and a crash record of every finished game at every restart is only noise.
		const finishedItself = this.reapedOnExit || (this.child === null ? true : how.code === 0 && how.signal === null);
		this.ending = this.stopping && finishedItself ? 'clean' : { reason, ...how };
		live.delete(this);
		for (const t of this.killTimers) clearTimeout(t);
		if (this.watch !== null) clearInterval(this.watch);
		this.io.close();
		if (this.events !== null) this.events.exit(reason);
		this.hooks.exit(this, reason);
		this.settleRunDir();
	}

	/**
	 * The JVM is gone and its stderr is flushed: remove a clean end's
	 * directory, keep a crash's diagnostics. See "The run directory".
	 */
	private settleRunDir(): void {
		const ending = this.ending;
		if (ending === null) return;
		this.ending = null;
		try {
			if (ending === 'clean') {
				rmSync(this.run, { recursive: true, force: true });
				this.log({ evt: 'run-dir-removed', id: this.id, run: this.run });
				return;
			}
			keepCrashRecord(this.run, { id: this.id, ...ending, at: new Date().toISOString() });
			const pruned = pruneCrashRecords(this.config.workDir);
			this.log({ evt: 'run-dir-kept', id: this.id, run: this.run, files: [...CRASH_RECORD_FILES], pruned: pruned.removed });
		} catch (err) {
			this.log({ evt: 'run-dir-settle-failed', id: this.id, run: this.run, error: (err as Error).message });
		}
	}

	/** Raw write, addressed to whatever id this JVM holds right now. */
	write(command: Record<string, unknown>): void {
		if (this.exited || this.handedOver) return;
		// Kept in the same file, in the same order, as the lines that came back:
		// a replay has to know which asks the old server had already answered.
		if (this.events !== null && command.t !== 'stop') this.persist({ c: command });
		try {
			writeSync(this.io.writeFd, `${JSON.stringify({ ...command, match: this.id })}\n`);
		} catch (err) {
			// The JVM is gone, or its fifo is full and nobody is draining it. The
			// exit path reports the first; the second cannot happen while the bridge
			// is reading, which is all it does between lines.
			this.log({ evt: 'bridge-stdin-error', id: this.id, error: (err as Error).message });
		}
	}

	/** Update the on-disk handle a later process would re-attach by. */
	private writeRecord(patch: Partial<JvmRecord>): void {
		if (this.record === null || !this.durable) return;
		this.record = { ...this.record, ...patch };
		try {
			writeFileSync(join(this.run, JVM_RECORD_FILE), `${JSON.stringify(this.record, null, 2)}\n`);
		} catch (err) {
			this.log({ evt: 'jvm-record-failed', id: this.id, error: (err as Error).message });
		}
	}

	/** What a match holds of this JVM. The two optional halves are the re-attach seam. */
	private hostFace(): MatchHost {
		return {
			send: (command: BridgeCommand) => this.write(command),
			stop: () => this.stop(),
			remember: (state) => this.writeRecord({ epoch: state.epoch, owners: state.owners }),
			handOver: () => this.handOver(),
		};
	}

	/**
	 * Make this JVM `matchId`'s. For a spare, the `start` line goes out addressed
	 * to the spare's id and every line after it must carry the match's. The
	 * bridge reads nothing else before `start`, and Node is single-threaded, so
	 * no line can arrive stamped with the wrong one.
	 */
	adopt(matchId: string, spec: MatchSpec, events: HostEvents, spare: boolean): MatchHost {
		writeFileSync(join(this.run, 'config.json'), JSON.stringify(bridgeConfig(matchId, spec)));
		if (spare) this.write({ t: 'start', config: bridgeConfig(matchId, spec) });
		// From here this JVM's log lines are the match's.
		this.log = events.log;
		this.log({ evt: spare ? 'spare-adopted' : 'jvm-cold', matchId, from: this.id, pid: this.pid, warm: this.warm });
		this.id = matchId;
		this.events = events;
		// And from here it is re-attachable: the handle names the match, not the spare.
		this.record = {
			matchId,
			pid: this.pid,
			run: this.run,
			startedAt: new Date().toISOString(),
			epoch: null,
			owners: [],
			spec,
		};
		this.writeRecord({});
		return this.hostFace();
	}

	/**
	 * Take a JVM an earlier server left running back into a match: replay every
	 * line that server read, THEN start reading live ones. The order is the whole
	 * point — a live delta applied before the `setGameView` it follows would give
	 * the seat a board Forge does not have — and it holds because the replay is
	 * synchronous and Node is single-threaded.
	 */
	resumeInto(events: HostEvents): { host: MatchHost; replayed: number } {
		this.log = events.log;
		this.events = events;
		const replayed = this.replay(events);
		this.resume();
		this.log({ evt: 'match-resumed', matchId: this.id, pid: this.pid, run: this.run, replayed });
		return { host: this.hostFace(), replayed };
	}

	/** Feed `<run>/stream.jsonl` back to the match. Returns how many lines it had. */
	private replay(events: HostEvents): number {
		let text: string;
		try {
			text = readFileSync(this.streamFile, 'utf8');
		} catch (err) {
			this.log({ evt: 'replay-unreadable', matchId: this.id, run: this.run, error: (err as Error).message });
			return 0;
		}
		let replayed = 0;
		for (const raw of text.split('\n')) {
			if (raw === '') continue;
			let entry: unknown;
			try {
				entry = JSON.parse(raw);
			} catch {
				// Only ever the last line, and only if the old process died between
				// the write and the newline. Said out loud: the seat is one frame
				// behind what Forge has, and its next delta will say so.
				this.log({ evt: 'replay-truncated', matchId: this.id, bytes: raw.length });
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

	/**
	 * Let go without killing: this process is going down and the match is not.
	 * Nothing is signalled, the run directory is NOT settled (it is the next
	 * server's handle), and the record is stamped so the orphan bound runs from
	 * now. False when there was nothing to hand over.
	 */
	handOver(): boolean {
		if (this.exited || this.handedOver || this.record === null || this.record.spare === true || !this.durable) return false;
		this.handedOver = true;
		this.writeRecord({ orphanedAt: new Date().toISOString() });
		for (const t of this.killTimers) clearTimeout(t);
		if (this.watch !== null) clearInterval(this.watch);
		// Its exit is no longer our business, and must not be read as a crash.
		this.child?.removeAllListeners('exit');
		this.child?.removeAllListeners('error');
		live.delete(this);
		this.io.close();
		this.log({ evt: 'jvm-handed-over', matchId: this.id, pid: this.pid, run: this.run });
		return true;
	}

	/**
	 * Ask, then insist: the bridge's own `stop` (a clean Netty shutdown),
	 * then SIGTERM, then SIGKILL — lane D's close sequence
	 * (`docs/spikes/jvm-per-match.md` §6). Idempotent.
	 */
	stop(): void {
		if (this.stopping || this.exited || this.handedOver) return;
		this.stopping = true;
		this.write({ t: 'stop' });
		const term = setTimeout(() => this.signal('SIGTERM'), this.config.stopGraceMs);
		const kill = setTimeout(() => this.signal('SIGKILL'), 2 * this.config.stopGraceMs);
		term.unref();
		kill.unref();
		this.killTimers.push(term, kill);
	}

	/** A spawned JVM is signalled through its handle, an attached one by pid. */
	private signal(sig: NodeJS.Signals): void {
		if (this.child !== null) {
			this.child.kill(sig);
			return;
		}
		try {
			process.kill(this.pid, sig);
		} catch {
			// ESRCH — it went on its own, which the watcher will notice.
		}
	}

	/**
	 * Last rites: this process is going down and this JVM is NOT being handed
	 * over, so it has to be gone before we are. See "Going down" for why the
	 * answer is SIGKILL and nothing gentler — a polite `stop` takes ~9.3 s on a
	 * real match and a SIGTERM ~4.3 s, and pm2 SIGKILLs us after 1.6 s.
	 *
	 * `'gone'` means confirmed dead and the run directory removed; `'kept'` that
	 * it was already gone and its directory already settled; `'left'` that the
	 * kill did not take, which is said out loud and leaves the directory alone —
	 * it is still that JVM's cwd, and the next boot's sweep needs it to spare,
	 * find or end it. Idempotent, and a pid that has already exited is not an
	 * error: it is the outcome.
	 *
	 * It does NOT ask again. `PlayHandle.shutdown` already asked through
	 * `Match.stop()`, the answer measurably cannot arrive in time, and a second
	 * `writeSync` into a fifo whose reader is wedged is the one thing here that
	 * could hang a deploy.
	 */
	reapNow(): 'gone' | 'kept' | 'left' {
		if (this.handedOver) return 'kept';
		if (this.exited) return 'kept';
		this.stopping = true;
		this.reapedOnExit = true;
		// Only signal something that is actually there: a pid that has already gone
		// has no `/proc/<pid>/cwd` to confirm, and a refusal logged for it would
		// read like the pid-reuse guard firing when nothing was in question.
		if (pidIsRunning(this.pid)) this.killConfirmed();
		const deadline = Date.now() + REAP_CONFIRM_MS;
		while (pidIsRunning(this.pid) && Date.now() < deadline) sleepSync(5);
		if (pidIsRunning(this.pid)) {
			this.log({ evt: 'jvm-reap-failed', id: this.id, pid: this.pid, run: this.run, afterMs: REAP_CONFIRM_MS });
			return 'left';
		}
		this.log({ evt: 'jvm-reaped', id: this.id, pid: this.pid, run: this.run });
		// Its end is accounted for here rather than left to an `exit` event that
		// `process.exit` will pre-empt, so nothing reports it twice and the run dir
		// is settled once. Nobody is told — `events.exit` would reach a `Match` in a
		// process that is already gone.
		this.exited = true;
		live.delete(this);
		for (const t of this.killTimers) clearTimeout(t);
		if (this.watch !== null) clearInterval(this.watch);
		this.child?.removeAllListeners('exit');
		this.child?.removeAllListeners('error');
		this.io.close();
		try {
			// Confirmed gone, so the directory is nobody's cwd, and nothing re-attaches
			// to a match that is not being handed over. Remove it whole, as a clean stop
			// would: left behind it is `RUN_DIR_FRESH_MS`-fresh at the next boot, so that
			// sweep spares it and it survives to the one after.
			rmSync(this.run, { recursive: true, force: true });
			this.log({ evt: 'run-dir-removed', id: this.id, run: this.run });
		} catch (err) {
			this.log({ evt: 'run-dir-settle-failed', id: this.id, run: this.run, error: (err as Error).message });
		}
		return 'gone';
	}

	/**
	 * SIGKILL, having first confirmed the pid is the process standing in THIS run
	 * directory — the `/proc/<pid>/cwd` check `orphans()` makes, for the reason
	 * `orphans()` makes it: a recycled pid is some other program, and this is the
	 * one path in this file that kills on the way out with nothing left to catch
	 * a mistake. A spawned child is checked too, not just an attached one: both
	 * are addressed by pid in the end, and `child.kill` would be no safer.
	 */
	private killConfirmed(): void {
		if (!pidIsStandingInRun(this.pid, this.run)) {
			this.log({ evt: 'jvm-reap-refused', id: this.id, pid: this.pid, run: this.run, why: 'that pid is not the process standing in this run dir' });
			return;
		}
		try {
			process.kill(this.pid, 'SIGKILL');
		} catch {
			// ESRCH — it went between the check and here, which is the outcome we wanted.
		}
	}
}

export interface JvmPoolOptions {
	/** Keep a warm spare. Default: `config.warmSpare`. */
	spare?: boolean;
	/** JVMs this pool will run at once, spare included. Default `MAX_CONCURRENT_MATCHES`. */
	maxJvms?: number;
	/** Wait before replacing a spare that died idle. Default `SPARE_RETRY_MS`. */
	spareRetryMs?: number;
	/** Sweep `workDir` of what an earlier process left (`sweepRunDirs`) before the first JVM. Default true. */
	sweep?: boolean;
	log?: (entry: Record<string, unknown>) => void;
}

/** The JVM factory, with its spare. `spare()` is for diagnostics and the benchmark. */
export type JvmHostFactory = MatchHostFactory & {
	close(): void;
	spare(): 'none' | 'booting' | 'warm';
	orphans(): JvmRecord[];
	attach(record: JvmRecord, events: HostEvents): MatchHost;
	handOverAll(): string[];
	reapOnExit(): ReapResult;
};

/**
 * One JVM per match, and (unless turned off) one warm spare. A match's own
 * `HostEvents.log` receives its JVM's log lines; the spare's, which belong to no
 * match yet, go to `options.log`.
 */
export function jvmHostFactory(config: JvmHostConfig, options: JvmPoolOptions = {}): JvmHostFactory {
	const useSpare = options.spare ?? config.warmSpare;
	const maxJvms = options.maxJvms ?? MAX_CONCURRENT_MATCHES;
	const poolLog = options.log ?? jsonLogger('cardtable-play');
	/** JVMs that belong to a match and have not exited. */
	const serving = new Set<BridgeJvm>();
	/**
	 * Matches an earlier server left running, found by the boot sweep and not yet
	 * taken back. They count against `maxJvms` from the moment they are found, so
	 * a re-attach cannot push the JVM count past the ceiling — and they are killed
	 * if nobody claims them, so a caller that ignores `orphans()` leaks nothing.
	 */
	const pending = new Map<string, JvmRecord>();
	/**
	 * JVMs this pool has asked to stop and not yet seen exit. `close()` forgets
	 * the spare — so its death is not counted as a spare that failed — and this is
	 * what still remembers it, because a spare takes ~314 ms to `halt(0)` and
	 * `reapOnExit` has to be able to insist on one that is still going. Emptied by
	 * `hooks.exit`.
	 */
	const doomed = new Set<BridgeJvm>();
	let claimDeadline: NodeJS.Timeout | null = null;
	let spare: BridgeJvm | null = null;
	let spareFailures = 0;
	let retry: NodeJS.Timeout | null = null;
	let closed = false;

	const hooks = {
		warm(jvm: BridgeJvm, bootMs: number) {
			spareFailures = 0;
			poolLog({ evt: 'spare-warm', id: jvm.id, pid: jvm.pid, bootMs });
		},
		exit(jvm: BridgeJvm, reason: string) {
			doomed.delete(jvm);
			if (jvm === spare) {
				spare = null;
				spareFailures += 1;
				poolLog({ evt: 'spare-died', id: jvm.id, reason, failures: spareFailures });
				if (spareFailures >= SPARE_MAX_FAILURES) {
					poolLog({ evt: 'spare-disabled', reason: `${spareFailures} spares died before being used; matches start cold` });
					return;
				}
				if (retry === null && !closed) {
					retry = setTimeout(() => {
						retry = null;
						replenish();
					}, options.spareRetryMs ?? SPARE_RETRY_MS);
					retry.unref();
				}
				return;
			}
			serving.delete(jvm);
			replenish();
		},
	};

	function replenish(): void {
		if (!useSpare || closed || spare !== null || spareFailures >= SPARE_MAX_FAILURES) return;
		if (serving.size + pending.size + 1 > maxJvms) return;
		const id = `spare-${randomBytes(6).toString('hex')}`;
		spare = new BridgeJvm(config, stageRunDir(config, id), id, { mode: 'spawn', args: ['--spare', id] }, poolLog, hooks);
	}

	/** Nobody came back for these. See "A match outlives its server". */
	function dropUnclaimed(): void {
		for (const [matchId, record] of pending) {
			poolLog({ evt: 'orphan-unclaimed', matchId, pid: record.pid, run: record.run, afterMs: ORPHAN_CLAIM_MS });
			killPid(record.pid);
			rmSync(record.run, { recursive: true, force: true });
		}
		pending.clear();
		replenish();
	}

	const factory = ((matchId: string, spec: MatchSpec, events: HostEvents): MatchHost => {
		let jvm: BridgeJvm;
		let fromSpare = false;
		if (spare !== null && !spare.exited) {
			jvm = spare;
			spare = null;
			fromSpare = true;
		} else {
			const run = stageRunDir(config, matchId);
			writeFileSync(join(run, 'config.json'), JSON.stringify(bridgeConfig(matchId, spec)));
			jvm = new BridgeJvm(config, run, matchId, { mode: 'spawn', args: [join(run, 'config.json')] }, events.log, hooks);
		}
		serving.add(jvm);
		const host = jvm.adopt(matchId, spec, events, fromSpare);
		replenish();
		return host;
	}) as JvmHostFactory;

	factory.close = () => {
		closed = true;
		if (retry !== null) clearTimeout(retry);
		if (claimDeadline !== null) clearTimeout(claimDeadline);
		// Forget it first, so its exit is not counted as a spare that died — but not
		// entirely: `doomed` keeps it reachable for `reapOnExit`.
		const idle = spare;
		spare = null;
		if (idle !== null) {
			doomed.add(idle);
			idle.stop();
		}
	};
	factory.spare = () => (spare === null ? 'none' : spare.warm ? 'warm' : 'booting');

	factory.orphans = () => [...pending.values()];

	factory.attach = (record: JvmRecord, events: HostEvents): MatchHost => {
		if (!pending.delete(record.matchId)) {
			throw new Error(`there is no orphan match ${record.matchId} to attach to`);
		}
		const jvm = new BridgeJvm(config, record.run, record.matchId, { mode: 'attach', record }, events.log, hooks);
		serving.add(jvm);
		const { host } = jvm.resumeInto(events);
		replenish();
		return host;
	};

	/**
	 * SIGTERM: every live match is left running for the next process, and the
	 * spare — which holds no game — is stopped. Returns the matches handed over.
	 */
	factory.handOverAll = (): string[] => {
		closed = true;
		if (retry !== null) clearTimeout(retry);
		if (claimDeadline !== null) clearTimeout(claimDeadline);
		const handed: string[] = [];
		for (const jvm of [...serving]) {
			if (jvm.handOver()) {
				serving.delete(jvm);
				handed.push(jvm.id);
			}
		}
		const idle = spare;
		spare = null;
		idle?.stop();
		return handed;
	};

	/**
	 * The last word before `process.exit`. See "Going down" in the module header:
	 * every JVM still here that was not handed over is killed now, because no
	 * polite stop fits a deploy's budget and an `unref`'d timer in a process that
	 * is about to exit is not a plan.
	 *
	 * It asks the JVM pool, not the match statuses. The bug this fixes was a
	 * status filter deciding a JVM's fate — a game that had FINISHED was neither
	 * handed over nor ended, so nothing stopped it — and the fix is that the only
	 * question asked here is the one that matters: did we hand this one over?
	 *
	 * The orphans from an EARLIER server (`pending`) are deliberately untouched:
	 * they already carry an `orphanedAt`, the next process is offered them again,
	 * and killing them here would end a match across two restarts that survived
	 * one.
	 */
	factory.reapOnExit = (): ReapResult => {
		closed = true;
		if (retry !== null) clearTimeout(retry);
		if (claimDeadline !== null) clearTimeout(claimDeadline);
		if (spare !== null) {
			doomed.add(spare);
			spare = null;
		}
		const result: ReapResult = { killed: [], kept: [], left: [] };
		const targets = new Set<BridgeJvm>([...serving, ...doomed]);
		for (const jvm of targets) {
			const fate = jvm.reapNow();
			if (fate === 'gone') result.killed.push(jvm.id);
			else if (fate === 'left') result.left.push(jvm.id);
			else result.kept.push(jvm.id);
			if (fate !== 'left') {
				serving.delete(jvm);
				doomed.delete(jvm);
			}
		}
		poolLog({ evt: 'jvms-reaped', ...result });
		return result;
	};

	if (options.sweep ?? true) {
		try {
			const swept = sweepRunDirs(config.workDir);
			for (const record of swept.orphans) {
				if (record.spare === true || record.spec === null) continue;
				pending.set(record.matchId, record);
			}
			poolLog({
				evt: 'run-dirs-swept',
				workDir: config.workDir,
				removed: swept.removed.length,
				live: swept.live,
				fresh: swept.fresh,
				killed: swept.killed,
				orphans: [...pending.keys()],
				crashRecords: swept.crashes.kept.length,
				crashRecordsRemoved: swept.crashes.removed.length,
				...(swept.skipped === undefined ? {} : { skipped: swept.skipped }),
			});
			if (pending.size > 0) {
				claimDeadline = setTimeout(dropUnclaimed, ORPHAN_CLAIM_MS);
				claimDeadline.unref();
			}
		} catch (err) {
			// A sweep that fails leaves directories behind; it must not stop play from starting.
			poolLog({ evt: 'run-dir-sweep-failed', workDir: config.workDir, error: (err as Error).message });
		}
	}
	replenish();
	return factory;
}
