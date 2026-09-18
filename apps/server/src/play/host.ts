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
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
	return run;
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
		child.on('error', (err) => this.onGone(`the JVM could not be started: ${err.message}`));
		child.on('exit', (code, signal) => {
			log({ evt: 'jvm-exited', id: this.id, pid: child.pid, code, signal });
			this.onGone(this.stopping ? 'stopped' : `the JVM exited (code ${code}, signal ${signal}); see ${run}/bridge.stderr.txt`);
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

	private onGone(reason: string): void {
		if (this.exited) return;
		this.exited = true;
		live.delete(this.child);
		for (const t of this.killTimers) clearTimeout(t);
		if (this.events !== null) this.events.exit(reason);
		this.hooks.exit(this, reason);
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

	replenish();
	return factory;
}
