/**
 * `--host` bridge JVMs on THIS machine: the local `JvmLauncher` (`jvm-transport.ts` is the seam;
 * `remote/launcher.ts` is the same seam over a claw's agent). The coordinator (`host.ts`) places
 * matches into JVMs; this file starts them, reaches their line streams and settles what they
 * leave on disk.
 *
 * ## The run directory
 *
 * Every local JVM gets `<workDir>/<hostId>` (`stageRunDir`): Forge's profile, a `res` symlink,
 * empty user and cache dirs, two fifos, `launch.json` (its pid), the coordinator's `jvm.json` and
 * per-match streams, and `bridge.stderr.txt`. `workDir` is on tmpfs by default, so a directory
 * nobody removes is RAM nobody gets back. What happens to it is decided when the JVM is gone:
 *
 * - **A clean end is removed whole**: the coordinator asked the JVM to go and it went.
 * - **Anything else is a crash record**, pruned to `CRASH_RECORD_FILES` (stderr, the
 *   coordinator's `jvm.json` with every match's decks, and a `crash.json` saying how it ended).
 *   The exit reason names its path.
 * - **Crash records are bounded**: the newest `CRASH_RECORDS_KEPT`, none older than
 *   `CRASH_RECORD_MAX_AGE_MS`.
 * - **The boot sweep** (`sweepRunDirs`, run when the launcher is made) removes what an earlier
 *   process left, and spares a directory some process is standing in (`/proc/<pid>/cwd` — so
 *   another server's live JVM survives), one changed in the last `RUN_DIR_FRESH_MS`, and crash
 *   records within the bound. A live directory whose `launch.json` pid IS the process standing in
 *   it is one of ours, and `running()` offers it back. A live one-match JVM from before many
 *   matches per JVM (`m-…`, `spare-…`) is ended: nothing re-attaches one any more. Where `/proc`
 *   cannot be read the sweep does nothing and says so.
 *
 * ## A JVM outlives its server (Wave 22, §E)
 *
 * A deploy must not end live games, so a JVM survives the server that started it:
 *
 * 1. **The transport is not an inherited pipe**, which dies with its process. The run dir holds
 *    two named pipes, `in.fifo` and `out.fifo`, and the JVM's stdin/stdout are fds on those. Both
 *    ends open them **`O_RDWR`**, which on Linux succeeds without a peer and means neither side
 *    ever sees EOF (each is its own last writer). The bridge exits on stdin EOF. stderr is an
 *    `O_APPEND` fd on `bridge.stderr.txt`, for the same reason.
 * 2. **The JVM is not in our process group, and nothing kills it on the way out**: `detached`,
 *    `unref`, and no exit hook.
 * 3. **The next process finds it** by `launch.json`, confirmed through `/proc/<pid>/cwd` (a
 *    recycled pid is some other program, in some other directory), and `attach` re-opens the
 *    fifos. Lines the JVM wrote while nobody was attached are still in `out.fifo`, so they are the
 *    first ones read. Rebuilding each MATCH from its history is the coordinator's (`host.ts`).
 *
 * ## The bridge, compiled once
 *
 * See `bridgeLaunch`.
 *
 * ## Configuration (environment)
 *
 *   CARDTABLE_FORGE_JAR              the fat jar, `forge-gui-desktop-*-jar-with-dependencies.jar`  (required)
 *   CARDTABLE_FORGE_RES              Forge's `forge-gui/res` directory                              (required)
 *   CARDTABLE_JAVA                   a JDK 21 `java`; default: `~/.local/opt/jdk-21*\/bin/java` (D14), then `java`
 *   CARDTABLE_PLAY_WORK_DIR          per-JVM run directories; default `<os tmpdir>/cardtable-play`
 *   CARDTABLE_PLAY_JVM_OPTS          extra JVM flags, space-separated; an `-Xmx` here beats `JVM_HEAP_MB`
 *   CARDTABLE_PLAY_WARM_JVM          `0` to keep no JVM booted ahead of a match; default on
 *   CARDTABLE_PLAY_MATCHES_PER_JVM   matches one JVM hosts at most; default `MATCHES_PER_JVM`
 *   CARDTABLE_PLAY_BRIDGE_CACHE      where the compiled bridge is kept; default `~/.cache/cardtable/bridge`
 *
 * The bridge needs a JDK — `javac` to compile, or `jdk.compiler` for the source launcher it falls
 * back to — which is why the default is the user-local Temurin rather than the JRE on `PATH`.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
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

import { playWorkDir } from '../config.js';
import { bridgeDiagnostics } from './diagnostics.js';
import type { JvmLauncher, JvmTransport } from './jvm-transport.js';

/**
 * Forge's server drops a client it has read nothing from for this long
 * (`FServerManager.HEARTBEAT_TIMEOUT_SECONDS`, `forge.net.heartbeatTimeout`, default 45 s;
 * its clients write a heartbeat every 15 s). Every client of a bridge's server is a
 * loopback `FGameClient` in the same JVM, so the only thing that silences one is the
 * whole JVM pausing — and a dropped client is never reconnected: the seat's every later
 * press is lost (hosting-test-plan C2b: a 60 s pause wedged the match for good). A day is
 * far past any pause a JVM comes back from; a JVM that stops for longer is
 * `UNRESPONSIVE_MS`'s to end (host.ts), not Forge's.
 */
export const FORGE_HEARTBEAT_TIMEOUT_S = 86_400;

/**
 * Flags every bridge JVM gets, before the heap cap and the operator's `jvmOpts` (so a later flag
 * of theirs wins). `ExitOnOutOfMemoryError`: G1 has no GC-overhead limit, and without this a JVM
 * out of heap never exits — its games die of `OutOfMemoryError` and the JVM limps on
 * (hosting-test-plan B4: 62 % GC, act p99 14.6 s). With it the JVM exits (code 3), which fails
 * every match on it through the exit path.
 */
export const BRIDGE_JVM_FLAGS: readonly string[] = ['-XX:+ExitOnOutOfMemoryError', `-Dforge.net.heartbeatTimeout=${FORGE_HEARTBEAT_TIMEOUT_S}`];

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
	/**
	 * A JVM asked to stop (`{"t":"stop"}` to its host id) is killed after this long, and a
	 * match asked to stop is let go after `MATCH_STOP_MS` (host.ts).
	 */
	stopGraceMs: number;
	/** Keep one booted JVM with room for the next match. See host.ts, "The warm JVM". */
	warmJvm: boolean;
	/** Matches one JVM hosts at most. Default `MATCHES_PER_JVM`. */
	perJvm?: number;
	/** Each JVM's heap cap, unless `jvmOpts` names an `-Xmx` of its own. Default `JVM_HEAP_MB`. */
	xmxMb?: number;
	/** A JVM silent this long is killed and every match on it failed. Default `UNRESPONSIVE_MS` (host.ts); see "Liveness". */
	unresponsiveMs?: number;
}

/** See host.ts, "Many matches per JVM". `CARDTABLE_PLAY_MATCHES_PER_JVM` overrides it. */
export const MATCHES_PER_JVM = 8;

/**
 * Each JVM's heap cap: the budget for {@link MATCHES_PER_JVM} matches. A one-match JVM had 1 GB
 * against ~172 MB live idle and ~10 MB per match (Wave 9 lane D), so 2 GB for eight keeps the same
 * kind of headroom. G1 does not hand committed heap back, so a JVM's RSS is budgeted at its peak:
 * ~2.3 GB with metaspace, code cache and Netty.
 */
export const JVM_HEAP_MB = 2048;

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

/** A whole number of at least 1 from `raw`, else `fallback`. */
function positiveInt(raw: string | undefined, fallback: number): number {
	const n = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
	return Number.isInteger(n) && n >= 1 ? n : fallback;
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
			jvmOpts: (env.CARDTABLE_PLAY_JVM_OPTS ?? '').split(/\s+/).filter((s) => s !== ''),
			bridgeSource,
			bridgeCache: resolve(env.CARDTABLE_PLAY_BRIDGE_CACHE ?? join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'cardtable', 'bridge')),
			stopGraceMs: 5000,
			warmJvm: env.CARDTABLE_PLAY_WARM_JVM !== '0',
			perJvm: positiveInt(env.CARDTABLE_PLAY_MATCHES_PER_JVM, MATCHES_PER_JVM),
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
 * each compiles into its own temporary directory and RENAMES it into place, so
 * a JVM never sees half a directory, and the loser's copy is deleted. The
 * directory name carries the main's own name as well as `bridgeVersion`
 * (below) precisely so this stays true even though two different mains
 * (`PlayBridge`, `PoolService`) can share a version: each still gets its own
 * directory, so a reader finding ITS main's class already there is never
 * looking at one another process is still mid-write on for a DIFFERENT main.
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
 * consulted for it, and the compiled output is unchanged.
 */
export function bridgeLaunch(config: JvmHostConfig, log: (entry: Record<string, unknown>) => void): { args: string[]; how: 'compiled' | 'source' } {
	const source = { args: ['-cp', config.jar, config.bridgeSource], how: 'source' as const };
	const javac = join(dirname(config.java), 'javac');
	if (!existsSync(javac)) return source;
	const main = basename(config.bridgeSource, '.java');
	let dir: string;
	try {
		// The main's own name is part of the directory, not just the version: two
		// mains compiling the same siblings (PlayBridge.java and PoolService.java,
		// most of the time) must never share one, or a reader that finds ITS
		// main's class already there could be looking at a directory ANOTHER
		// process is still mid-write on the OTHER main's classes. One main, one
		// directory, keeps the rename below the only thing that makes a directory
		// visible at all — no reader ever sees a half-written one.
		dir = join(config.bridgeCache, `${main}-${bridgeVersion(config)}`);
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

/**
 * Every input that decides a compiled bridge's cache directory. Not just
 * `config.bridgeSource`'s own bytes: `javac`'s `-sourcepath` (above) can pull
 * ANY `.java` file beside it into the compile, so the key has to cover every
 * sibling in that directory, hashed in a fixed (sorted) order for a
 * deterministic digest — otherwise an edit to a file that IS referenced,
 * with the referencing file itself unchanged, would keep the old key and so
 * silently serve a stale compiled class for it.
 *
 * Covering the whole directory means `PlayBridge.java`'s own key also changes
 * when `PoolService.java` changes, and vice versa, even on an edit that
 * changes nothing either file's compile actually depends on. Accepted for
 * simplicity: the alternative is having `javac` report exactly which
 * siblings it resolved for THAT compile (it does not expose this), and
 * tracking it per bridge source — real staleness is worse than an occasional
 * needless recompile.
 *
 * Exported so the key itself is unit-testable (`host.test.ts`, "an edited
 * SIBLING .java changes the key too") without a real compile.
 */
export function bridgeVersion(config: JvmHostConfig): string {
	const dir = dirname(config.bridgeSource);
	const siblings = readdirSync(dir)
		.filter((f) => f.endsWith('.java'))
		.sort();
	const hash = createHash('sha256');
	for (const file of siblings) hash.update(readFileSync(join(dir, file)));
	const jar = statSync(config.jar);
	hash.update(JSON.stringify([config.jar, jar.size, jar.mtimeMs, realpathSync(config.java)]));
	return hash.digest('hex').slice(0, 24);
}

/* ── A JVM that outlives us: the fifos and the launch record ─────────── */

/** The JVM's stdin. Both ends open it `O_RDWR`; see "A JVM outlives its server". */
const IN_FIFO = 'in.fifo';
/** The JVM's stdout, same treatment. */
const OUT_FIFO = 'out.fifo';
/** `{hostId, pid, startedAt}`: what a later process finds a running JVM by. Written at launch. */
export const LAUNCH_RECORD_FILE = 'launch.json';
/**
 * The JVM's `java.io.tmpdir`. Forge's lz4-java unpacks a native `.so` there on
 * every boot and only removes it on a clean JVM exit, which a SIGKILLed bridge
 * never has — so under the default `/tmp` every killed match leaked one copy
 * (3,036 of them on the host's RAM-backed /tmp, 2026-10-10). Inside the run dir it
 * goes wherever the run dir goes: removed on a clean end, pruned on a crash.
 */
const JVM_TMP_DIR = 'tmp';

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

/**
 * Write `file` whole or not at all: into a temporary file beside it, then renamed over
 * it. `writeFileSync` in place truncates first, so a full disk left `jvm.json` empty and
 * its match un-re-attachable (hosting-test-plan C6); here a failed write leaves the old
 * file as it was, and throws.
 */
export function writeFileAtomic(file: string, text: string): void {
	const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
	try {
		writeFileSync(tmp, text);
		renameSync(tmp, file);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
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
 * nothing is written into the Forge build it reads from. Exported for
 * `multi-match.jvm.test.ts`, which stages a `--host` JVM itself.
 */
export function stageRunDir(config: JvmHostConfig, name: string): string {
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
/**
 * What a crashed JVM's directory is pruned to. `crash.json` marks it as a record; `jvm.json` is the
 * coordinator's record of the matches it hosted, with their decks, so one can be replayed.
 */
export const CRASH_RECORD_FILES = ['bridge.stderr.txt', 'jvm.json', 'crash.json'] as const;

/** The tail of `bridge.stderr.txt` read for {@link bridgeDiagnostics}: the end of a long match is what a report is about. */
const DIAGNOSTICS_READ_BYTES = 4 * 1024 * 1024;

/** {@link bridgeDiagnostics} of a run directory's `bridge.stderr.txt`; none for a JVM that never wrote one. */
function runDirDiagnostics(run: string): { line: string; count: number }[] {
	const path = join(run, 'bridge.stderr.txt');
	if (!existsSync(path)) return [];
	const size = statSync(path).size;
	const fd = openSync(path, 'r');
	try {
		const length = Math.min(size, DIAGNOSTICS_READ_BYTES);
		const buf = Buffer.alloc(length);
		readSync(fd, buf, 0, length, size - length);
		return bridgeDiagnostics(buf.toString('utf8'));
	} finally {
		closeSync(fd);
	}
}
const CRASH_MARKER = 'crash.json';

/**
 * JVM host ids (`h-…`), and the one-match JVMs (`m-…`, `spare-…`) of the servers before many
 * matches per JVM, which a boot still ends and removes. Nothing else under `workDir` is ours.
 */
const RUN_DIR_NAME = /^(h|m|spare)-[0-9a-f]{12}$/;
/** A run directory from before many matches per JVM: one match each, re-attached by nothing now. */
const LEGACY_RUN_DIR = /^(m|spare)-/;

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
	writeFileAtomic(join(run, CRASH_MARKER), `${JSON.stringify(record, null, 2)}\n`);
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
	 * Live JVMs of ours: the directory's own `launch.json` names the very process standing in it.
	 * A subset of `live`, oldest first; what `JvmLauncher.running()` offers back.
	 */
	running: { hostId: string; pid: number; run: string; startedAt: string }[];
	/**
	 * Live directories the sweep ENDED: a one-match JVM from before many matches per JVM
	 * (`m-…`/`spare-…`), named by its own record's pid. Nothing re-attaches those any more.
	 */
	killed: string[];
	/** Set when the sweep did nothing, and why. */
	skipped?: string;
}

/** `<run>/launch.json`, or null when it is missing, unreadable or not one. */
export function readLaunchRecord(run: string): { hostId: string; pid: number; startedAt: string } | null {
	try {
		const r = JSON.parse(readFileSync(join(run, LAUNCH_RECORD_FILE), 'utf8')) as Record<string, unknown>;
		if (typeof r.hostId !== 'string' || typeof r.pid !== 'number') return null;
		return { hostId: r.hostId, pid: r.pid, startedAt: typeof r.startedAt === 'string' ? r.startedAt : new Date(0).toISOString() };
	} catch {
		return null;
	}
}

/** The pid a one-match JVM's own record named (`jvm.json`, or `jvm.degraded.json` once its stream broke). */
function legacyPid(run: string): number | null {
	for (const file of ['jvm.json', 'jvm.degraded.json']) {
		try {
			const pid = (JSON.parse(readFileSync(join(run, file), 'utf8')) as { pid?: unknown }).pid;
			if (typeof pid === 'number') return pid;
		} catch {
			// Not this one; the other, or none.
		}
	}
	return null;
}

/**
 * Remove the run directories an earlier process left behind, and hand back the JVMs that are
 * still running. See "The run directory" and "A JVM outlives its server" in the module header for
 * what it spares and why.
 */
export function sweepRunDirs(workDir: string, now = Date.now()): SweepResult {
	const result: SweepResult = { removed: [], live: [], fresh: [], crashes: { kept: [], removed: [] }, running: [], killed: [] };
	const cwds = processCwds();
	if (cwds === null) return { ...result, skipped: '/proc is not readable, so a live run directory cannot be told from a dead one' };
	for (const { name, dir, mtimeMs } of runDirs(workDir)) {
		if (cwds.some((cwd) => cwd === dir || cwd.startsWith(dir + sep))) {
			// LIVE. Some process is standing here, so the directory is not ours to remove on a
			// guess — that guard is why another server's JVM survives. The only question asked is
			// whose it is, answered by the directory's own record: a pid that IS the process
			// standing here. Its `run` string is deliberately not compared — `runDirs` resolves
			// `workDir` through `realpath` and the writer did not.
			if (LEGACY_RUN_DIR.test(name)) {
				const pid = legacyPid(dir);
				if (pid !== null && pidIsStandingIn(pid, dir) === true) {
					killPid(pid);
					rmSync(dir, { recursive: true, force: true });
					result.killed.push(name);
					continue;
				}
			} else {
				const launch = readLaunchRecord(dir);
				if (launch !== null && launch.hostId === name && pidIsStandingIn(launch.pid, dir) === true) {
					result.running.push({ hostId: name, pid: launch.pid, run: dir, startedAt: launch.startedAt });
				}
			}
			result.live.push(name);
			continue;
		}
		if (existsSync(join(dir, CRASH_MARKER))) continue; // the bound decides, below
		if (now - mtimeMs < RUN_DIR_FRESH_MS) result.fresh.push(name);
		else {
			rmSync(dir, { recursive: true, force: true });
			result.removed.push(name);
		}
	}
	result.running.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
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


/* ── One JVM's transport, over its fifos ─────────────────────────────── */

/**
 * Every local JVM this process is talking to and has not seen exit or let go. There is no
 * `process.on('exit')` hook that kills them, on purpose: a JVM is meant to outlive this process
 * (see "A JVM outlives its server"), and what must not is the coordinator's `reapOnExit`'s.
 */
const live = new Set<LocalJvm>();

/** Number of bridge JVMs this process currently has running. */
export function liveJvmCount(): number {
	return live.size;
}

/** `{"t":"stop","match":<hostId>}`: the coordinator asking the JVM itself to go (`PlayBridge.handle`). */
function isHostStop(line: string, hostId: string): boolean {
	if (!line.startsWith('{"t":"stop"')) return false;
	try {
		return (JSON.parse(line) as { match?: unknown }).match === hostId;
	} catch {
		return false;
	}
}

/**
 * One `--host` JVM on this machine, either end of whose fifos may be opened by a process that
 * did not start it. Addressed by **pid**: a JVM re-attached from an earlier server is nobody's
 * child, so its death is noticed by polling rather than by an `exit` event.
 *
 * Its run directory is settled when it is gone. **A clean end is removed whole**: the
 * coordinator asked the JVM to go (`{"t":"stop"}` to its host id) and it went, by itself
 * (`halt(0)`) or by the `kill()` that followed. **Anything else is a crash record**: a JVM that
 * exited on its own, non-zero, by a signal, or that the coordinator killed without asking first
 * (the liveness watchdog does exactly that).
 */
class LocalJvm implements JvmTransport {
	readonly pid: number;
	private readonly child: ChildProcess | null = null;
	private readonly io: JvmIo;
	private lineListener: ((line: string) => void) | null = null;
	private exitListener: ((reason: string) => void) | null = null;
	/** Exited, killed, or released: nothing more goes either way. */
	private gone = false;
	private askedToStop = false;
	private killedByUs = false;
	private watch: NodeJS.Timeout | null = null;

	constructor(
		private readonly config: JvmHostConfig,
		readonly hostId: string,
		readonly run: string,
		source: { mode: 'spawn'; xmxMb: number } | { mode: 'attach'; pid: number },
		private readonly log: (entry: Record<string, unknown>) => void,
	) {
		this.io = openJvmIo(run);
		if (source.mode === 'attach') {
			this.pid = source.pid;
			live.add(this);
			log({ evt: 'jvm-attached', id: hostId, pid: this.pid, run });
			this.read();
			this.watchPid();
			return;
		}
		// stderr is an appended FILE, not a pipe: a pipe dies with this process and the JVM must
		// not. It is also what a crash record keeps.
		const stderrFd = openSync(join(run, 'bridge.stderr.txt'), 'a');
		// The child gets its OWN fds on the fifos, closed here once it holds them.
		const childIn = openSync(join(run, IN_FIFO), 'r+');
		const childOut = openSync(join(run, OUT_FIFO), 'r+');
		const bridge = bridgeLaunch(config, log);
		let child: ChildProcess;
		try {
			child = spawn(
				config.java,
				[
					'-Djava.awt.headless=true',
					`-Djava.io.tmpdir=${join(run, JVM_TMP_DIR)}`,
					...BRIDGE_JVM_FLAGS,
					// Before the operator's flags, so an `-Xmx` of theirs wins.
					`-Xmx${source.xmxMb}m`,
					...config.jvmOpts,
					...bridge.args,
					'--host',
					hostId,
				],
				// `detached` puts it in its own process group, so a signal aimed at ours never
				// reaches it; `unref` keeps it off our event loop.
				{ cwd: run, stdio: [childIn, childOut, stderrFd], detached: true },
			);
		} finally {
			for (const fd of [childIn, childOut, stderrFd]) closeSync(fd);
		}
		child.unref();
		this.child = child;
		this.pid = child.pid ?? -1;
		live.add(this);
		log({ evt: 'jvm-spawned', id: hostId, pid: this.pid, run, bridge: bridge.how });
		writeFileAtomic(join(run, LAUNCH_RECORD_FILE), `${JSON.stringify({ hostId, pid: this.pid, startedAt: new Date().toISOString() })}\n`);
		this.read();
		child.on('error', (err) => this.finish(`the JVM could not be started: ${err.message}`, { code: null, signal: null }));
		child.on('exit', (code, signal) => {
			this.log({ evt: 'jvm-exited', id: hostId, pid: this.pid, code, signal });
			this.finish(this.askedToStop ? 'stopped' : `the JVM exited (code ${code}, signal ${signal}); see ${run}/bridge.stderr.txt`, { code, signal });
		});
	}

	send(line: string): void {
		if (this.gone) return;
		if (isHostStop(line, this.hostId)) this.askedToStop = true;
		try {
			writeSync(this.io.writeFd, `${line}\n`);
		} catch (err) {
			// The JVM is gone, or its fifo is full and nobody is draining it. The exit path
			// reports the first; the second cannot happen while the bridge is reading, which is
			// all its stdin thread does.
			this.log({ evt: 'bridge-stdin-error', id: this.hostId, error: (err as Error).message });
		}
	}

	onLine(listener: (line: string) => void): void {
		this.lineListener = listener;
	}

	onExit(listener: (reason: string) => void): void {
		this.exitListener = listener;
	}

	/**
	 * SIGKILL, confirmed: synchronous, so `reapOnExit` can rely on it with `process.exit` a
	 * statement away (see "Going down"). The pid is signalled only once `/proc/<pid>/cwd` says it
	 * is the process standing in THIS run directory — a recycled pid is some other program.
	 */
	kill(): void {
		if (this.gone) return;
		this.killedByUs = true;
		if (pidIsRunning(this.pid)) {
			if (!pidIsStandingInRun(this.pid, this.run)) {
				this.log({ evt: 'jvm-reap-refused', id: this.hostId, pid: this.pid, run: this.run, why: 'that pid is not the process standing in this run dir' });
				return;
			}
			try {
				process.kill(this.pid, 'SIGKILL');
			} catch {
				// ESRCH — it went between the check and here, which is the outcome we wanted.
			}
		}
		const deadline = Date.now() + REAP_CONFIRM_MS;
		while (pidIsRunning(this.pid) && Date.now() < deadline) sleepSync(5);
		if (pidIsRunning(this.pid)) {
			this.log({ evt: 'jvm-reap-failed', id: this.hostId, pid: this.pid, run: this.run, afterMs: REAP_CONFIRM_MS });
			return;
		}
		this.log({ evt: 'jvm-killed', id: this.hostId, pid: this.pid, run: this.run });
		this.finish(this.askedToStop ? 'stopped' : `the JVM was killed; see ${this.run}/bridge.stderr.txt`, { code: null, signal: 'SIGKILL' });
	}

	/** Let go without killing and without settling the run directory: it is the next server's handle. */
	release(): void {
		if (this.gone) return;
		this.gone = true;
		this.detach();
		this.log({ evt: 'jvm-handed-over', id: this.hostId, pid: this.pid, run: this.run });
	}

	/** Is the JVM still there? False once it is gone, killed or let go. */
	alive(): boolean {
		return !this.gone;
	}

	private read(): void {
		createInterface({ input: this.io.lines }).on('line', (text) => {
			if (!this.gone) this.lineListener?.(text);
		});
	}

	/**
	 * An attached JVM is nobody's child, so there is no `exit` event for it. The cwd check is not
	 * repeated here: the sweep established that this pid is the process standing in this run dir,
	 * and a pid that dies is not reissued to a process that then stands in the same directory.
	 */
	private watchPid(): void {
		const timer = setInterval(() => {
			if (pidIsRunning(this.pid)) return;
			this.log({ evt: 'jvm-exited', id: this.hostId, pid: this.pid, code: null, signal: null, attached: true });
			this.finish(this.askedToStop ? 'stopped' : `the JVM exited; see ${this.run}/bridge.stderr.txt`, { code: null, signal: null });
		}, PID_POLL_MS);
		timer.unref();
		this.watch = timer;
	}

	private detach(): void {
		live.delete(this);
		if (this.watch !== null) clearInterval(this.watch);
		this.child?.removeAllListeners('exit');
		this.child?.removeAllListeners('error');
		this.io.close();
	}

	private finish(reason: string, how: { code: number | null; signal: NodeJS.Signals | null }): void {
		if (this.gone) return;
		this.gone = true;
		this.detach();
		// An attached JVM has no exit code to read — nobody waited on it — so a stop that was asked
		// for is taken at its word.
		const clean = this.askedToStop && (this.killedByUs || this.child === null || (how.code === 0 && how.signal === null));
		this.exitListener?.(reason);
		this.settle(clean ? 'clean' : { reason, ...how });
	}

	/** The JVM is gone and its stderr is flushed: remove a clean end's directory, keep a crash's diagnostics. */
	private settle(ending: 'clean' | { reason: string; code: number | null; signal: NodeJS.Signals | null }): void {
		try {
			if (ending === 'clean') {
				this.logDiagnostics();
				rmSync(this.run, { recursive: true, force: true });
				this.log({ evt: 'run-dir-removed', id: this.hostId, run: this.run });
				return;
			}
			keepCrashRecord(this.run, { id: this.hostId, ...ending, at: new Date().toISOString() });
			const pruned = pruneCrashRecords(this.config.workDir);
			this.log({ evt: 'run-dir-kept', id: this.hostId, run: this.run, files: [...CRASH_RECORD_FILES], pruned: pruned.removed });
		} catch (err) {
			this.log({ evt: 'run-dir-settle-failed', id: this.hostId, run: this.run, error: (err as Error).message });
		}
	}

	/** What the bridge said about itself, logged before a removal takes its stderr: see {@link bridgeDiagnostics}. */
	private logDiagnostics(): void {
		try {
			const lines = runDirDiagnostics(this.run);
			if (lines.length > 0) this.log({ evt: 'bridge-diagnostics', id: this.hostId, lines });
		} catch (err) {
			this.log({ evt: 'bridge-diagnostics-failed', id: this.hostId, run: this.run, error: (err as Error).message });
		}
	}
}

export interface LocalLauncherOptions {
	/** Sweep `workDir` of what an earlier process left (`sweepRunDirs`) now. Default true. */
	sweep?: boolean;
	log?: (entry: Record<string, unknown>) => void;
}

/** {@link JvmLauncher} for JVMs on this machine, plus what its boot sweep found. */
export type LocalJvmLauncher = JvmLauncher & { readonly swept: SweepResult | null };

/**
 * `--host` JVMs on this machine, one run directory each (`<workDir>/<hostId>`), reached over the
 * directory's fifos so a later process can take one back. The boot sweep runs here, once, when the
 * launcher is made: it removes what an earlier process left and finds the JVMs still running.
 */
export function localJvmLauncher(config: JvmHostConfig, options: LocalLauncherOptions = {}): LocalJvmLauncher {
	const log = options.log ?? (() => undefined);
	/** Running JVMs from an earlier server, not yet attached. */
	const found = new Map<string, { pid: number; run: string }>();
	let swept: SweepResult | null = null;
	if (options.sweep ?? true) {
		try {
			swept = sweepRunDirs(config.workDir);
			for (const r of swept.running) found.set(r.hostId, { pid: r.pid, run: r.run });
			log({
				evt: 'run-dirs-swept',
				workDir: config.workDir,
				removed: swept.removed.length,
				live: swept.live,
				fresh: swept.fresh,
				killed: swept.killed,
				running: [...found.keys()],
				crashRecords: swept.crashes.kept.length,
				crashRecordsRemoved: swept.crashes.removed.length,
				...(swept.skipped === undefined ? {} : { skipped: swept.skipped }),
			});
		} catch (err) {
			// A sweep that fails leaves directories behind; it must not stop play from starting.
			log({ evt: 'run-dir-sweep-failed', workDir: config.workDir, error: (err as Error).message });
		}
	}
	return {
		swept,
		launch(hostId: string, opts: { xmxMb: number }): JvmTransport {
			const run = join(config.workDir, hostId);
			try {
				stageRunDir(config, hostId);
				return new LocalJvm(config, hostId, run, { mode: 'spawn', xmxMb: opts.xmxMb }, log);
			} catch (err) {
				rmSync(run, { recursive: true, force: true });
				throw err;
			}
		},
		running: () => Promise.resolve([...found.keys()]),
		attach(hostId: string): JvmTransport {
			const at = found.get(hostId);
			if (at === undefined) throw new Error(`there is no running JVM ${hostId} to attach to`);
			found.delete(hostId);
			return new LocalJvm(config, hostId, at.run, { mode: 'attach', pid: at.pid }, log);
		},
	};
}
