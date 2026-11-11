/**
 * Generic process hosting for a game engine run as a long-lived subprocess: a run directory
 * reached over named pipes that outlive the server, pid-based liveness (a recycled pid is some
 * other program, never ours to claim), and the crash-record bookkeeping a boot sweep prunes.
 * `local-jvm.ts` is the one caller today — Forge's bridge JVM, hosted through this file's
 * primitives — and `EngineRuntime` below is the seam a later lane (L2, `host.ts` going generic)
 * can rewire the coordinator through, so a non-JVM engine fits the same host.
 *
 * Nothing here knows about Forge, bridges, or `.dck` files. See `local-jvm.ts`'s own header for
 * the run directory's on-disk shape and why a JVM outlives its server.
 */

import { spawnSync } from 'node:child_process';
import { closeSync, constants as fsConstants, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs';
import { Socket } from 'node:net';
import { delimiter, join, sep } from 'node:path';

/**
 * What the host asks of any engine it runs matches through: the process it spawns and what that
 * process costs. Not wired into `host.ts` yet — the coordinator still calls `localJvmLauncher`
 * and `bridgeLaunch` directly — this only proves the shape fits Forge's own code
 * (`forgeEngineRuntime` in `local-jvm.ts`) before a later lane rewires the coordinator through it.
 */
export interface EngineRuntime {
	/** Paths (or other identifiers) of what the process needs, keyed for logging. */
	artifacts: Record<string, string>;
	/** The full argv (after the executable) to launch one process in run directory `dir`, sized to `size`. */
	argv(dir: string, size: { memoryMb: number }): string[];
	/** RAM one idle process costs beyond what it hosts. */
	overheadMb: number;
	/** Matches (or jobs) one process hosts at most. */
	perProcess: number;
	/** Is the process in `dir` still healthy, or due for a recycle? */
	health?(dir: string): { recycle: boolean };
}

/* ── A whole number from an environment variable ────────────────────── */

/** A whole number of at least 1 from `raw`, else `fallback`. */
export function positiveInt(raw: string | undefined, fallback: number): number {
	const n = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
	return Number.isInteger(n) && n >= 1 ? n : fallback;
}

/* ── Finding a JDK's `java` ───────────────────────────────────────────── */

/**
 * The `java` to run when nothing names one, as an ABSOLUTE path whenever one can be found: a
 * caller that also wants `javac` (to compile a bridge, say) looks beside it, and beside a bare
 * `java` is `./javac`, which never exists.
 *
 * In order: `$JAVA_HOME/bin/java`, then the first `java` on `PATH` with its symlinks followed
 * (`/usr/local/bin/java` is a link into the fleet's JDK, and `javac` sits beside the real file,
 * not the link). A bare `java` only when neither exists.
 */
export function defaultJava(env: NodeJS.ProcessEnv = process.env): string {
	const candidates = [
		...(env.JAVA_HOME ? [join(env.JAVA_HOME, 'bin', 'java')] : []),
		...(env.PATH ?? '').split(delimiter).filter((dir) => dir !== '').map((dir) => join(dir, 'java')),
	];
	const found = candidates.find((p) => existsSync(p) && statSync(p).isFile());
	return found === undefined ? 'java' : realpathSync(found);
}

/* ── Named pipes: a run directory's stdio ────────────────────────────── */

/** A process's stdin, opened by both ends. */
export const IN_FIFO = 'in.fifo';
/** A process's stdout, same treatment. */
export const OUT_FIFO = 'out.fifo';
/** Where a process's own `java.io.tmpdir`-style scratch space goes, inside the run dir. */
export const JVM_TMP_DIR = 'tmp';

/**
 * Two named pipes in the run dir. `mkfifo(3)` has no binding in `node:fs`, so
 * this shells out — once per run directory, at staging time.
 */
export function makeFifos(run: string): void {
	const made = spawnSync('mkfifo', [join(run, IN_FIFO), join(run, OUT_FIFO)], { stdio: 'pipe' });
	if (made.error !== undefined) throw made.error;
	if (made.status !== 0) {
		throw new Error(`mkfifo failed in ${run} (status ${made.status}): ${made.stderr?.toString().trim() ?? ''}`);
	}
}

/**
 * The transport to one process over its fifos, either end of which may be opened by a process
 * that did not create it. Both fds are `O_RDWR` so neither side ever reads EOF — the engine would
 * exit on one, and we could not tell a handed-over process from a dead one.
 */
export interface JvmIo {
	/** Queue one line for the process's stdin; never blocks. See {@link openJvmIo}. */
	write(line: string): void;
	lines: NodeJS.ReadableStream;
	close(): void;
}

/** How soon a write the fifo had no room for is tried again. */
const STDIN_RETRY_MS = 20;

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
export function openJvmIo(run: string, log: (entry: Record<string, unknown>) => void): JvmIo {
	// The write end is non-blocking, and a line the fifo has no room for waits in `pending`.
	// A blocking `writeSync` into a fifo nobody drains — a process that died before its stdin thread
	// ran — parks the whole event loop: its own `exit` is never handled, every other match and
	// socket stops, and the matches placed on it hold their ceiling slots for good. Our fd is
	// `O_RDWR`, so a dead reader is no EPIPE; the fifo just fills. The child's stdin is its own
	// open (the caller's `spawn`), so the process still reads a blocking fd.
	const writeFd = openSync(join(run, IN_FIFO), fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
	const readFd = openSync(join(run, OUT_FIFO), 'r+');
	const lines = new Socket({ fd: readFd, readable: true, writable: false });
	lines.on('error', () => {
		// The fd went with the process, or was closed under us. The exit path says why.
	});
	const pending: Buffer[] = [];
	let retry: NodeJS.Timeout | null = null;
	let closed = false;
	let waitingSince: number | null = null;
	const flush = (): void => {
		retry = null;
		while (!closed && pending.length > 0) {
			const head = pending[0]!;
			let wrote: number;
			try {
				wrote = writeSync(writeFd, head);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === 'EAGAIN') {
					if (waitingSince === null) {
						waitingSince = Date.now();
						log({ evt: 'bridge-stdin-full', run, queued: pending.reduce((n, b) => n + b.length, 0) });
					}
					retry = setTimeout(flush, STDIN_RETRY_MS);
					return;
				}
				// The fd is gone with the process. The exit path reports that.
				log({ evt: 'bridge-stdin-error', run, error: (err as Error).message });
				pending.length = 0;
				return;
			}
			if (wrote < head.length) pending[0] = head.subarray(wrote);
			else pending.shift();
		}
		if (waitingSince !== null) {
			log({ evt: 'bridge-stdin-drained', run, waitedMs: Date.now() - waitingSince });
			waitingSince = null;
		}
	};
	return {
		write(line: string): void {
			if (closed) return;
			pending.push(Buffer.from(`${line}\n`));
			if (retry === null && pending.length === 1) flush();
		},
		lines,
		close(): void {
			closed = true;
			pending.length = 0;
			if (retry !== null) clearTimeout(retry);
			lines.destroy();
			try {
				closeSync(writeFd);
			} catch {
				// Already closed, or the fd went with the stream. Nothing to recover.
			}
		},
	};
}

/* ── Pid liveness: a recycled pid is some other program ──────────────── */

/**
 * Is `pid` still the process standing in `run`? The cwd check is what makes
 * this safe against pid reuse: a recycled pid is some other program, in some
 * other directory. Null when `/proc` cannot answer.
 */
export function pidIsStandingIn(pid: number, run: string): boolean | null {
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
 * `pidIsStandingIn`, tolerant of a run dir reached through a symlink: `/proc`
 * answers with the resolved path and a run dir is not always resolved first, so the
 * two spellings can differ.
 */
export function pidIsStandingInRun(pid: number, run: string): boolean {
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
 * decides.
 */
export function pidIsRunning(pid: number): boolean {
	try {
		return !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
	} catch {
		return false; // no /proc entry: it has exited
	}
}

/** How long a kill will spin waiting for a SIGKILL to land. Measured at 0 ms. */
export const REAP_CONFIRM_MS = 100;

/** How often an attached process (which is nobody's child, so has no `exit` event) is checked for. */
export const PID_POLL_MS = 1000;

/**
 * Block this thread for `ms`. Only ever used confirming a kill before the caller
 * stops existing (`process.exit` a statement away), where there is no later tick to confirm in.
 */
export function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** SIGKILL a pid we own, or say nothing: it may have gone between the check and here. */
export function killPid(pid: number): void {
	try {
		process.kill(pid, 'SIGKILL');
	} catch {
		// ESRCH — already gone, which is the outcome we wanted.
	}
}

/* ── Run directories and crash records ───────────────────────────────── */

/** One run directory under a `workDir`, as a real path. */
export interface RunDirEntry {
	name: string;
	dir: string;
	mtimeMs: number;
}

/** Marks a pruned-down run directory as a crash record rather than scaffolding to remove outright. */
export const CRASH_MARKER = 'crash.json';

/** Our run directories directly under `workDir`, as real paths, matching `namePattern`. */
export function runDirs(workDir: string, namePattern: RegExp): RunDirEntry[] {
	if (!existsSync(workDir)) return [];
	const root = realpathSync(workDir);
	const dirs: RunDirEntry[] = [];
	for (const name of readdirSync(root)) {
		if (!namePattern.test(name)) continue;
		const dir = join(root, name);
		const stat = lstatSync(dir);
		if (stat.isDirectory()) dirs.push({ name, dir, mtimeMs: stat.mtimeMs });
	}
	return dirs;
}

/** When a crash record (named `marker`, inside `dir`) was written: its own `at`, else `fallbackMtimeMs`. */
export function crashTime(dir: string, marker: string, fallbackMtimeMs: number): number {
	const at = Date.parse((JSON.parse(readFileSync(join(dir, marker), 'utf8')) as { at?: string }).at ?? '');
	return Number.isNaN(at) ? fallbackMtimeMs : at;
}

/**
 * Enforce a crash-record bound over directories matching `namePattern` under `workDir`: the
 * newest `keep` within `maxAgeMs` stay, the rest are removed outright. Returns what it removed.
 */
export function pruneCrashRecords(
	workDir: string,
	namePattern: RegExp,
	marker: string,
	keep: number,
	maxAgeMs: number,
	now = Date.now(),
): { kept: string[]; removed: string[] } {
	const records = runDirs(workDir, namePattern)
		.filter((d) => existsSync(join(d.dir, marker)))
		.map((d) => ({ ...d, at: crashTime(d.dir, marker, d.mtimeMs) }))
		.sort((a, b) => b.at - a.at);
	const kept: string[] = [];
	const removed: string[] = [];
	for (const r of records) {
		if (kept.length < keep && now - r.at <= maxAgeMs) {
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
export function processCwds(): string[] | null {
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

/** Is `cwd` this directory, or somewhere under it? */
export function cwdIsUnder(cwd: string, dir: string): boolean {
	return cwd === dir || cwd.startsWith(dir + sep);
}

export interface SweepResult {
	/** Directories removed: dead, not fresh, not a crash record within the bound. */
	removed: string[];
	/** Spared: some process is standing in it — a running process, ours or another server's. */
	live: string[];
	/** Spared: changed within the sweep's freshness window. */
	fresh: string[];
	/** Crash records kept, and those the bound removed. */
	crashes: { kept: string[]; removed: string[] };
	/**
	 * Live processes of ours: the directory's own launch record names the very process standing in it.
	 * A subset of `live`, oldest first.
	 */
	running: { hostId: string; pid: number; run: string; startedAt: string }[];
	/**
	 * Live directories the sweep ENDED: a legacy one-process-per-run-dir layout nothing re-attaches
	 * any more, named by its own record's pid.
	 */
	killed: string[];
	/** Set when the sweep did nothing, and why. */
	skipped?: string;
}
