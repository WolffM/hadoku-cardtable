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
 * ## The ceiling: at most `MAX_CONCURRENT_MATCHES` JVMs, spare included
 *
 * Deliberately **2**. Wave 9 lane D measured ~650 MB of RSS for an idle JVM and
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
 *
 * The bridge is run as a single-file source program (`java … PlayBridge.java`,
 * JEP 330), so there is no build step and nothing compiled lands in the repo.
 * That needs a JDK (the source launcher is `jdk.compiler`), which is why the
 * default is the user-local Temurin rather than the JRE on `PATH` — the same
 * trap `CLAUDE.md` describes for `javac`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
	createWriteStream,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { AbortReasonSchema, ClientAction } from '@hadoku/forge-wire';

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
}

type AbortReason = (typeof AbortReasonSchema)['_zod']['output'];

/**
 * Node → Forge. On the wire each command also carries `match` — the JVM host adds
 * it and the bridge refuses a command without its own match id.
 */
export type BridgeCommand =
	| { t: 'reply'; seat: number; callId: string; result: unknown }
	| { t: 'abort'; seat: number; callId: string; reason: AbortReason }
	| { t: 'act'; seat: number; frame: ClientAction }
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
	| { t: 'ready'; forgePort: number; bootMs: number; startMs?: number; seats: { seat: number; ai: boolean; deck: string }[] }
	| { t: 'frame'; seat: number; frame: unknown }
	| { t: 'probe'; probeId: string; seat: number; answer?: boolean; ms?: number; error?: string }
	| { t: 'gameover'; winner: string | null }
	| { t: 'fatal'; message: string }
	| { t: 'rejected'; message: string; command: string }
	| { t: 'stale'; seat: number; callId: string }
	| { t: 'unsupported'; seat: number; method: string };

export interface HostEvents {
	line(line: BridgeLine): void;
	/** The host is gone. `reason` says why, for the match's status. */
	exit(reason: string): void;
	log(entry: Record<string, unknown>): void;
}

export interface MatchHost {
	send(command: BridgeCommand): void;
	/** Ask the match to stop; force it after a grace period. Idempotent. */
	stop(): void;
}

/**
 * Makes a host for one match. `close`, when present, releases whatever the
 * factory holds between matches (the JVM pool's spare); `attachPlay`'s
 * `close()` calls it.
 */
export type MatchHostFactory = ((matchId: string, spec: MatchSpec, events: HostEvents) => MatchHost) & {
	close?(): void;
};

/** See "The ceiling" in the module header. Also `PlayDeps.maxMatches`'s default. */
export const MAX_CONCURRENT_MATCHES = 2;

/** The per-JVM heap cap, unless `CARDTABLE_PLAY_JVM_OPTS` sets its own. See "The ceiling". */
export const DEFAULT_JVM_HEAP = '-Xmx1g';

/** A spare that died idle is replaced after this long… */
export const SPARE_RETRY_MS = 5000;
/** …and after this many such deaths in a row, not at all. */
export const SPARE_MAX_FAILURES = 3;

const LINE_TYPES = new Set(['ready', 'frame', 'probe', 'gameover', 'fatal', 'rejected', 'stale', 'unsupported']);

/** A line from the bridge, or null for one that is not a protocol line. */
export function parseBridgeLine(text: string): BridgeLine | null {
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
			workDir: resolve(env.CARDTABLE_PLAY_WORK_DIR ?? join(tmpdir(), 'cardtable-play')),
			jvmOpts: withHeapCap((env.CARDTABLE_PLAY_JVM_OPTS ?? '').split(/\s+/).filter((s) => s !== '')),
			bridgeSource,
			stopGraceMs: 5000,
			warmSpare: env.CARDTABLE_PLAY_WARM_SPARE !== '0',
		},
	};
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
	symlinkSync(config.res, join(run, 'res'));
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
	 * (`PlayerControllerHuman.java:1006-1012`). Verified on this host: a
	 * Preordain scry arrived as `manipulateCardList` with **53** cards and 2
	 * manipulable. The desktop UI renders that as a drag inside its library
	 * display; a browser client has no such display and draws 53 rows, 51 of
	 * them cards the seat is not allowed to see and so cannot name.
	 *
	 * False takes Forge's other branch (`:1013-1027`): it asks with the scried
	 * cards alone. The seat's own library stops crossing the wire for a scry.
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
export function pruneCrashRecords(workDir: string, now = Date.now()): { kept: string[]; removed: string[] } {
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
	/** Set when the sweep did nothing, and why. */
	skipped?: string;
}

/**
 * Remove the run directories an earlier process left behind. See "The run
 * directory" in the module header for what it spares and why.
 */
export function sweepRunDirs(workDir: string, now = Date.now()): SweepResult {
	const result: SweepResult = { removed: [], live: [], fresh: [], crashes: { kept: [], removed: [] } };
	const cwds = processCwds();
	if (cwds === null) return { ...result, skipped: '/proc is not readable, so a live run directory cannot be told from a dead one' };
	for (const { name, dir, mtimeMs } of runDirs(workDir)) {
		if (cwds.some((cwd) => cwd === dir || cwd.startsWith(dir + sep))) result.live.push(name);
		else if (existsSync(join(dir, CRASH_MARKER))) continue; // the bound decides, below
		else if (now - mtimeMs < RUN_DIR_FRESH_MS) result.fresh.push(name);
		else {
			rmSync(dir, { recursive: true, force: true });
			result.removed.push(name);
		}
	}
	result.crashes = pruneCrashRecords(workDir, now);
	return result;
}

/** The config object the bridge reads — from `config.json` cold, or in a spare's `start` line. */
function bridgeConfig(matchId: string, spec: MatchSpec): Record<string, unknown> {
	return { matchId, ...spec };
}

/** Every JVM this process started and has not seen exit. Killed if Node exits first. */
const live = new Set<ChildProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on('exit', () => {
		for (const child of live) child.kill('SIGKILL');
	});
}

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

/**
 * One bridge JVM. Its lines are checked against `id` — the spare's own id until
 * `adopt`, the match's after — and go to `events`, which a spare does not have
 * yet. Everything a match sees of it is the `MatchHost` that `adopt` returns.
 */
class BridgeJvm {
	id: string;
	readonly run: string;
	readonly child: ChildProcess;
	/** Set by `adopt`. Null while this JVM is a spare. */
	private events: HostEvents | null = null;
	/** The spare's `warm` line has arrived. A cold JVM never sends one. */
	warm = false;
	exited = false;
	private stopping = false;
	/** How it ended, set on exit and consumed when the run dir is settled. */
	private ending: 'clean' | { reason: string; code: number | null; signal: NodeJS.Signals | null } | null = null;
	private readonly killTimers: NodeJS.Timeout[] = [];

	constructor(
		private readonly config: JvmHostConfig,
		run: string,
		id: string,
		args: string[],
		private log: (entry: Record<string, unknown>) => void,
		private readonly hooks: { warm(jvm: BridgeJvm, bootMs: number): void; exit(jvm: BridgeJvm, reason: string): void },
	) {
		installExitHook();
		this.id = id;
		this.run = run;
		const stderr = createWriteStream(join(run, 'bridge.stderr.txt'));
		stderr.on('error', (err) => this.log({ evt: 'bridge-stderr-error', id: this.id, error: err.message }));
		const child = spawn(
			config.java,
			['-Djava.awt.headless=true', ...config.jvmOpts, '-cp', config.jar, config.bridgeSource, ...args],
			{ cwd: run, stdio: ['pipe', 'pipe', 'pipe'] },
		);
		this.child = child;
		live.add(child);
		log({ evt: 'jvm-spawned', id, pid: child.pid, run, spare: args[0] === '--spare' });
		child.stderr?.pipe(stderr);
		createInterface({ input: child.stdout as NodeJS.ReadableStream }).on('line', (text) => this.onText(text));
		child.on('error', (err) => this.onGone(`the JVM could not be started: ${err.message}`, { code: null, signal: null }));
		child.on('exit', (code, signal) => {
			log({ evt: 'jvm-exited', id: this.id, pid: child.pid, code, signal });
			this.onGone(this.stopping ? 'stopped' : `the JVM exited (code ${code}, signal ${signal}); see ${run}/bridge.stderr.txt`, { code, signal });
		});
		// `close` comes after `exit` (or `error`) and after the child's stdio has
		// closed. A child that never started never ends its stderr, so end the
		// file here; the directory is settled once every byte is in it.
		child.on('close', () => {
			if (!stderr.writableEnded) stderr.end();
			if (stderr.closed) this.settleRunDir();
			else stderr.once('close', () => this.settleRunDir());
		});
		// A write after the JVM died is an EPIPE on a stream nobody is reading;
		// the exit handler above already reported why.
		child.stdin?.on('error', (err) => log({ evt: 'bridge-stdin-error', id: this.id, error: err.message }));
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
		this.events.line(line as BridgeLine);
	}

	private onGone(reason: string, how: { code: number | null; signal: NodeJS.Signals | null }): void {
		if (this.exited) return;
		this.exited = true;
		// Clean is only a stop we asked for that the bridge finished itself (`halt(0)`).
		// One that took our SIGTERM/SIGKILL hung, and is kept like any crash.
		this.ending = this.stopping && how.code === 0 && how.signal === null ? 'clean' : { reason, ...how };
		live.delete(this.child);
		for (const t of this.killTimers) clearTimeout(t);
		if (this.events !== null) this.events.exit(reason);
		this.hooks.exit(this, reason);
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
		const stdin = this.child.stdin;
		if (stdin !== null && stdin.writable) stdin.write(`${JSON.stringify({ ...command, match: this.id })}\n`);
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
		this.log({ evt: spare ? 'spare-adopted' : 'jvm-cold', matchId, from: this.id, pid: this.child.pid, warm: this.warm });
		this.id = matchId;
		this.events = events;
		return {
			send: (command: BridgeCommand) => this.write(command),
			stop: () => this.stop(),
		};
	}

	/**
	 * Ask, then insist: the bridge's own `stop` (a clean Netty shutdown),
	 * then SIGTERM, then SIGKILL — lane D's close sequence
	 * (`docs/spikes/jvm-per-match.md` §6). Idempotent.
	 */
	stop(): void {
		if (this.stopping || this.exited) return;
		this.stopping = true;
		this.write({ t: 'stop' });
		const term = setTimeout(() => this.child.kill('SIGTERM'), this.config.stopGraceMs);
		const kill = setTimeout(() => this.child.kill('SIGKILL'), 2 * this.config.stopGraceMs);
		term.unref();
		kill.unref();
		this.killTimers.push(term, kill);
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
};

function defaultHostLog(entry: Record<string, unknown>): void {
	console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'cardtable-play', ...entry }));
}

/**
 * One JVM per match, and (unless turned off) one warm spare. A match's own
 * `HostEvents.log` receives its JVM's log lines; the spare's, which belong to no
 * match yet, go to `options.log`.
 */
export function jvmHostFactory(config: JvmHostConfig, options: JvmPoolOptions = {}): JvmHostFactory {
	const useSpare = options.spare ?? config.warmSpare;
	const maxJvms = options.maxJvms ?? MAX_CONCURRENT_MATCHES;
	const poolLog = options.log ?? defaultHostLog;
	/** JVMs that belong to a match and have not exited. */
	const serving = new Set<BridgeJvm>();
	let spare: BridgeJvm | null = null;
	let spareFailures = 0;
	let retry: NodeJS.Timeout | null = null;
	let closed = false;

	const hooks = {
		warm(jvm: BridgeJvm, bootMs: number) {
			spareFailures = 0;
			poolLog({ evt: 'spare-warm', id: jvm.id, pid: jvm.child.pid, bootMs });
		},
		exit(jvm: BridgeJvm, reason: string) {
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
		if (serving.size + 1 > maxJvms) return;
		const id = `spare-${randomBytes(6).toString('hex')}`;
		spare = new BridgeJvm(config, stageRunDir(config, id), id, ['--spare', id], poolLog, hooks);
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
			jvm = new BridgeJvm(config, run, matchId, [join(run, 'config.json')], events.log, hooks);
		}
		serving.add(jvm);
		const host = jvm.adopt(matchId, spec, events, fromSpare);
		replenish();
		return host;
	}) as JvmHostFactory;

	factory.close = () => {
		closed = true;
		if (retry !== null) clearTimeout(retry);
		// Forget it first, so its exit is not counted as a spare that died.
		const idle = spare;
		spare = null;
		idle?.stop();
	};
	factory.spare = () => (spare === null ? 'none' : spare.warm ? 'warm' : 'booting');

	if (options.sweep ?? true) {
		try {
			const swept = sweepRunDirs(config.workDir);
			poolLog({
				evt: 'run-dirs-swept',
				workDir: config.workDir,
				removed: swept.removed.length,
				live: swept.live,
				fresh: swept.fresh,
				crashRecords: swept.crashes.kept.length,
				crashRecordsRemoved: swept.crashes.removed.length,
				...(swept.skipped === undefined ? {} : { skipped: swept.skipped }),
			});
		} catch (err) {
			// A sweep that fails leaves directories behind; it must not stop play from starting.
			poolLog({ evt: 'run-dir-sweep-failed', workDir: config.workDir, error: (err as Error).message });
		}
	}
	replenish();
	return factory;
}
