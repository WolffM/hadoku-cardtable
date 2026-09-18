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
 * JVM so a new match does not wait for startup — is NOT built: the bridge reads
 * its seats and decks at launch, so a spare needs the config to arrive over
 * stdin after boot instead. Recorded in `README.md` as a follow-up.
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
 *   CARDTABLE_PLAY_JVM_OPTS    extra JVM flags, space-separated, e.g. `-Xmx1g`
 *
 * The bridge is run as a single-file source program (`java … PlayBridge.java`,
 * JEP 330), so there is no build step and nothing compiled lands in the repo.
 * That needs a JDK (the source launcher is `jdk.compiler`), which is why the
 * default is the user-local Temurin rather than the JRE on `PATH` — the same
 * trap `CLAUDE.md` describes for `javac`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
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
	| { t: 'ready'; forgePort: number; bootMs: number; seats: { seat: number; ai: boolean; deck: string }[] }
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

export type MatchHostFactory = (matchId: string, spec: MatchSpec, events: HostEvents) => MatchHost;

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
			jvmOpts: (env.CARDTABLE_PLAY_JVM_OPTS ?? '').split(/\s+/).filter((s) => s !== ''),
			bridgeSource,
			stopGraceMs: 5000,
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
function stageRunDir(config: JvmHostConfig, matchId: string, spec: MatchSpec): string {
	const run = join(config.workDir, matchId);
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
	writeFileSync(join(run, 'config.json'), JSON.stringify({ matchId, ...spec }));
	return run;
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

export function jvmHostFactory(config: JvmHostConfig): MatchHostFactory {
	return (matchId, spec, events) => {
		installExitHook();
		const run = stageRunDir(config, matchId, spec);
		const stderr = createWriteStream(join(run, 'bridge.stderr.txt'));
		const child = spawn(
			config.java,
			['-Djava.awt.headless=true', ...config.jvmOpts, '-cp', config.jar, config.bridgeSource, join(run, 'config.json')],
			{ cwd: run, stdio: ['pipe', 'pipe', 'pipe'] },
		);
		live.add(child);
		events.log({ evt: 'jvm-spawned', matchId, pid: child.pid, run });
		const write = (command: BridgeCommand): void => {
			if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ ...command, match: matchId })}\n`);
		};

		child.stderr.pipe(stderr);
		const lines = createInterface({ input: child.stdout });
		lines.on('line', (text) => {
			const parsed = parseBridgeLine(text);
			if (parsed === null) {
				events.log({ evt: 'bridge-noise', matchId, text: text.slice(0, 200) });
				return;
			}
			const { match, ...line } = parsed as BridgeLine & { match?: unknown };
			if (match !== matchId) {
				events.log({ evt: 'bridge-wrong-match', matchId, got: match, line: line.t });
				return;
			}
			events.line(line as BridgeLine);
		});

		let stopping = false;
		const killTimers: NodeJS.Timeout[] = [];
		child.on('error', (err) => {
			live.delete(child);
			events.exit(`the JVM could not be started: ${err.message}`);
		});
		child.on('exit', (code, signal) => {
			live.delete(child);
			for (const t of killTimers) clearTimeout(t);
			events.log({ evt: 'jvm-exited', matchId, pid: child.pid, code, signal });
			events.exit(stopping ? 'stopped' : `the JVM exited (code ${code}, signal ${signal}); see ${run}/bridge.stderr.txt`);
		});
		// A write after the JVM died is an EPIPE on a stream nobody is reading;
		// the exit handler above already reported why.
		child.stdin.on('error', (err) => events.log({ evt: 'bridge-stdin-error', matchId, error: err.message }));

		return {
			send: write,
			/**
			 * Ask, then insist: the bridge's own `stop` (a clean Netty shutdown),
			 * then SIGTERM, then SIGKILL — lane D's close sequence
			 * (`docs/spikes/jvm-per-match.md` §6).
			 */
			stop() {
				if (stopping) return;
				stopping = true;
				write({ t: 'stop' });
				const term = setTimeout(() => child.kill('SIGTERM'), config.stopGraceMs);
				const kill = setTimeout(() => child.kill('SIGKILL'), 2 * config.stopGraceMs);
				term.unref();
				kill.unref();
				killTimers.push(term, kill);
			},
		};
	};
}
