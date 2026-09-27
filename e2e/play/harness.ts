/**
 * The play e2e's own stack: the REAL built server, WITH a Forge, behind the
 * same stand-in edge the draft e2e uses.
 *
 * Why not `../harness.ts`: that is Playwright's `webServer` for every spec,
 * and it runs the server deliberately without `CARDTABLE_FORGE_JAR` — a draft
 * does not touch Forge, and CI has no Forge build. A match needs one. So this
 * starts a second server + edge pair, on its own ports, from inside the spec,
 * and only when a Forge build is configured (`forgeAvailability`). The two
 * stacks coexist; nothing in `../harness.ts` changes.
 *
 * Posture, the same as `../harness.ts` plus exactly three things:
 *
 *  - a real `EDGE_AUTH_SECRET`, minted per run, and NO
 *    `CARDTABLE_INSECURE_NO_EDGE_AUTH` — two contexts are two participants
 *    because the edge says so, not because a dev hatch was opened;
 *  - `CARDTABLE_FORGE_JAR` / `CARDTABLE_FORGE_RES`, passed through;
 *  - `CARDTABLE_PLAY_PROBE=1`. A dev diagnostic, never on in production
 *    (`apps/server/src/play/socket.ts`). It is what lets the spec read the
 *    SERVER's fold of each seat (`GET …/seats/:seat/state`) to compare with
 *    what the browser drew, and ask Forge's own `showConfirmDialog` of a seat.
 *
 * ## Two directories this stack must NOT share with production
 *
 * Both used to be left at their defaults, and both defaults point at the
 * running server's own state:
 *
 *  - **`CARDTABLE_PLAY_WORK_DIR`** defaults to `<os tmpdir>/cardtable-play`,
 *    which on this host IS production's. `jvmHostFactory` **boot-sweeps** that
 *    directory (`play/host.ts` `sweepRunDirs`), so starting this stack without
 *    the variable deletes production's crash diagnostics. That is not a
 *    hypothetical: it happened on 2026-09-19 (Wave 12 lane B, 173 directories
 *    removed) and the tracker recorded it as an incident. The live-process
 *    guard saved the running JVM; nothing saved the records.
 *  - **`CARDTABLE_ROOMS_DIR`** defaults to `<logDir>/../data/rooms`, which
 *    `CARDTABLE_LOG_DIR` already moves under `.run/` — so it was never
 *    production's. It is still pinned here, and WIPED per run, because the
 *    lobby restores every room a previous process wrote and the play spec
 *    asserts on the room list it sees. A run must not inherit last run's rooms,
 *    nor share a directory with the draft stack's server, which is up at the
 *    same time under the same `.run/`.
 *
 * ## …and the work dir must not be shared with ANOTHER STACK either
 *
 * Wave 22 §E made a match JVM outlive its server: SIGTERM hands every live
 * match over (`jvm.json` gains `orphanedAt`) instead of killing it, and the
 * next server that boots on the same work dir **re-attaches** it. In
 * production that is the point. In a test it was a cross-spec hazard, because
 * the work dir used to be one constant shared by every stack:
 *
 *   `play.spec.ts` / `table-fit.spec.ts` (two stacks of its own) / `arrow.spec.ts`
 *   each tore their server down, leaving live handed-over JVMs in
 *   `.run/play-work`; the NEXT stack's server swept that directory, adopted
 *   them, and hit `MAX_CONCURRENT_MATCHES` — so `POST /api/play/matches`
 *   answered **503** and the spec died on a `waitForURL` that could never
 *   resolve. CI runs `play.spec.ts table-fit.spec.ts` in ONE invocation, so it
 *   was deterministic there, not a flake.
 *
 * Two halves fix it, and both live here rather than in the product — §E's
 * hand-over is the contract, not the bug:
 *
 *  1. **A work dir per stack.** `PLAY_WORK_ROOT` is only the parent now; each
 *     `startPlayStack` gets its own `stack-<random>` subdirectory of it, which
 *     is what the server's `CARDTABLE_PLAY_WORK_DIR` points at and what
 *     `PlayStack.workDir` reports. One stack's run dirs are therefore not in
 *     any other stack's sweep, so they cannot be adopted — not by the next
 *     spec, and not by the next RUN either.
 *  2. **Reaping on teardown.** A test has no successor server, so a
 *     handed-over JVM here is a leak rather than a promise. `stop()` therefore
 *     ends the JVMs it started once the server is down (`reapJvms`), and
 *     `stop({ reap: false })` defers that to an explicit `reap()` for the one
 *     caller that must first SEE a live handed-over JVM: `play.spec.ts`'s
 *     `jvmFates()`, which is what proves §E's contract from outside.
 *
 * The reaper signals a pid only when `/proc/<pid>/cwd` puts that process
 * inside THIS stack's work dir — the same pid-reuse check `host.ts`'s
 * `orphans()` makes — and refuses outright to run on a work dir that is not
 * under `PLAY_WORK_ROOT`. Production's JVMs live in `/tmp/cardtable-play` and
 * can match neither test.
 *
 * The bundle is served from a temp copy, for the reasons `../harness.ts` gives
 * (a concurrent `vite build` empties `dist/`; `send` 404s any path with a
 * dot-directory in it, and an agent worktree lives under `.claude/`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { startEdge } from '../edge.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SERVER_JS = resolve(ROOT, 'apps/server/dist/index.js');
const BUILT_WEB_DIR = resolve(ROOT, 'apps/ui/dist');
export const RUN_DIR = resolve(import.meta.dirname, '..', '.run');
/** This stack's room snapshots. Wiped per run; never production's `data/rooms`. */
export const PLAY_ROOMS_DIR = resolve(RUN_DIR, 'play-rooms');
/**
 * The PARENT of every stack's work dir — never itself a server's
 * `CARDTABLE_PLAY_WORK_DIR`. See "…and the work dir must not be shared with
 * ANOTHER STACK either". Never production's `/tmp/cardtable-play`, and the
 * reaper refuses to signal anything outside it.
 */
export const PLAY_WORK_ROOT = resolve(RUN_DIR, 'play-work');
/** Each stack's own subdirectory of `PLAY_WORK_ROOT`. */
const STACK_DIR_PREFIX = 'stack-';
/**
 * How many dead leftovers under `PLAY_WORK_ROOT` a new stack keeps, newest
 * first — a crashed run's diagnostics are worth reading, an unbounded pile of
 * them is not. Nothing a process is standing in is ever pruned, whoever's it is.
 */
const STALE_WORK_DIRS_KEPT = 6;

export const PLAY_EDGE_PORT = Number(process.env.CARDTABLE_E2E_PLAY_EDGE_PORT ?? '19128');
export const PLAY_SERVER_PORT = Number(process.env.CARDTABLE_E2E_PLAY_SERVER_PORT ?? '19028');
export const PLAY_EDGE_ORIGIN = `http://127.0.0.1:${PLAY_EDGE_PORT}`;

/*
 * The handle a later server re-attaches a match by, as
 * `apps/server/src/play/host.ts` writes it (`JVM_RECORD_FILE`, `JvmRecord`,
 * `ORPHAN_MAX_MS`). Read here rather than imported: `host.ts` is not
 * erasable-syntax-clean and this package typechecks with `erasableSyntaxOnly`
 * so Node can strip its types (`tsc` exits 2 on the import). ONE copy for the
 * whole e2e — the reaper below and `play.spec.ts`'s `jvmFates` share it.
 */

/** `host.ts` `JVM_RECORD_FILE`: the record a run dir keeps itself in. */
export const JVM_RECORD_FILE = 'jvm.json';
/** `host.ts` `ORPHAN_MAX_MS`: past this a boot kills an orphan instead of re-attaching. */
export const ORPHAN_MAX_MS = 12 * 60 * 60 * 1000;

/** The fields of `host.ts`'s `JvmRecord` anything in the e2e asks about. */
export interface JvmRecordSeen {
  matchId: string;
  pid: number;
  epoch: string | null;
  owners: unknown[];
  spec: unknown;
  spare: boolean;
  orphanedAt: string | null;
}

/** `<run>/jvm.json`, or null when it is missing, unreadable or not a record. */
export function readJvmRecord(run: string): JvmRecordSeen | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(run, JVM_RECORD_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.matchId !== 'string' || typeof r.pid !== 'number') return null;
  return {
    matchId: r.matchId,
    pid: r.pid,
    epoch: typeof r.epoch === 'string' ? r.epoch : null,
    owners: Array.isArray(r.owners) ? r.owners : [],
    spec: r.spec ?? null,
    spare: r.spare === true,
    orphanedAt: typeof r.orphanedAt === 'string' ? r.orphanedAt : null,
  };
}

export type ForgeAvailability = { ok: true; jar: string; res: string } | { ok: false; reason: string };

/** The same test the server's `jvmHostConfig` makes, so the skip says the same thing. */
export function forgeAvailability(env: NodeJS.ProcessEnv = process.env): ForgeAvailability {
  const jar = env.CARDTABLE_FORGE_JAR ?? '';
  const res = env.CARDTABLE_FORGE_RES ?? '';
  if (jar === '') return { ok: false, reason: 'CARDTABLE_FORGE_JAR is not set' };
  if (!existsSync(jar)) return { ok: false, reason: `CARDTABLE_FORGE_JAR does not exist: ${jar}` };
  if (res === '') return { ok: false, reason: 'CARDTABLE_FORGE_RES is not set' };
  if (!existsSync(join(res, 'cardsfolder'))) return { ok: false, reason: `CARDTABLE_FORGE_RES has no cardsfolder: ${res}` };
  return { ok: true, jar, res };
}

/* ── Reaping this stack's JVMs, and nobody else's ─────────────────────────── */

/** One JVM the harness ended. `id` is its `jvm.json` match id, null when it had no record yet. */
export interface ReapedJvm {
  pid: number;
  run: string;
  id: string | null;
}

/** `realpathSync`, or null when the path is gone (a deleted cwd included). */
function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Every process's cwd, as real paths. Null for a pid `/proc` will not answer for. */
function processCwds(): { pid: number; cwd: string | null }[] {
  const out: { pid: number; cwd: string | null }[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let link: string;
    try {
      link = readlinkSync(`/proc/${entry}/cwd`);
    } catch {
      continue; // gone, or not ours to inspect — either way not ours to signal
    }
    out.push({ pid: Number(entry), cwd: realpathOrNull(link) });
  }
  return out;
}

/** Is `cwd` `dir` itself or somewhere under it? Both must already be real paths. */
function isUnder(cwd: string | null, dir: string): boolean {
  return cwd !== null && (cwd === dir || cwd.startsWith(dir + sep));
}

/**
 * End every JVM standing in `workDir`, and NOTHING else.
 *
 * Two guards, and they are the whole safety of this function:
 *
 *  1. `workDir` must resolve to `PLAY_WORK_ROOT` or a path under it — this
 *     repo's `e2e/.run/play-work`. Production's work dir is
 *     `/tmp/cardtable-play`, which is not under it, so a reaper pointed there
 *     by a bad env or a stale constant throws instead of killing the
 *     operator's game or its warm spare.
 *  2. A pid is signalled only when `/proc/<pid>/cwd` — resolved through
 *     `realpath`, exactly as `host.ts`'s `pidIsStandingIn` reads it — puts
 *     that process inside that same directory. That is the pid-reuse check: a
 *     recycled pid is some other program, in some other directory, and it is
 *     not signalled. A pid whose cwd cannot be read is not signalled either.
 *
 * The records come first, because they name the match (and are what a
 * successor server would have re-attached by); the `/proc` pass then catches a
 * JVM that died before `adopt` wrote its `jvm.json` at all.
 *
 * Call it only once the server is down: while it is up, its own processes —
 * and the match JVMs it means to keep — are exactly what this would kill.
 */
export function reapJvms(workDir: string): ReapedJvm[] {
  const root = realpathOrNull(workDir);
  if (root === null) return []; // never created, or already removed
  const bound = realpathOrNull(PLAY_WORK_ROOT);
  if (bound === null || !(root === bound || root.startsWith(bound + sep))) {
    throw new Error(`refusing to reap ${workDir}: it is not under the e2e's own ${PLAY_WORK_ROOT}`);
  }

  const reaped: ReapedJvm[] = [];
  const signalled = new Set<number>();
  /** SIGKILL `pid`, but only if it is really the process standing in `dir`. */
  const reap = (pid: number, dir: string, id: string | null): void => {
    if (signalled.has(pid) || pid <= 0) return;
    if (!isUnder(realpathOrNull(`/proc/${pid}/cwd`), dir)) return;
    signalled.add(pid);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ESRCH: it went between the check and here, which is the outcome wanted.
    }
    reaped.push({ pid, run: dir, id });
  };

  for (const name of readdirSync(root)) {
    const run = join(root, name);
    let isDir: boolean;
    try {
      isDir = lstatSync(run).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const record = readJvmRecord(run);
    if (record !== null) reap(record.pid, run, record.matchId);
  }
  // A match JVM writes `jvm.json` at `adopt`, so one killed before that has no
  // record to be found by. Its cwd still names it, and that is guard 2 again.
  for (const { pid, cwd } of processCwds()) {
    if (cwd === null || !isUnder(cwd, root)) continue;
    reap(pid, cwd, null);
  }
  return reaped;
}

/**
 * Bound the pile under `PLAY_WORK_ROOT`: keep the newest `STALE_WORK_DIRS_KEPT`
 * leftovers and remove the rest. A directory some process is standing in is
 * never touched — that is the same guard `host.ts`'s `sweepRunDirs` leads with,
 * and here it is what keeps a still-running stack (or a previous run's orphan
 * this stack has no business ending) out of it.
 */
function pruneWorkRoot(): void {
  const root = realpathOrNull(PLAY_WORK_ROOT);
  if (root === null) return;
  const cwds = processCwds();
  const stale: { dir: string; mtimeMs: number }[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    let mtimeMs: number;
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory()) continue;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }
    if (cwds.some(({ cwd }) => isUnder(cwd, dir))) continue; // LIVE: not ours to remove
    stale.push({ dir, mtimeMs });
  }
  stale.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { dir } of stale.slice(STALE_WORK_DIRS_KEPT)) rmSync(dir, { recursive: true, force: true });
}

export interface PlayStack {
  origin: string;
  serverPort: number;
  /** The server's structured log, one JSON object per line. */
  serverLogFile: string;
  /** Where this stack's rooms and match run dirs went. Reported, so a run can prove it was not production's. */
  roomsDir: string;
  /** THIS stack's own subdirectory of `PLAY_WORK_ROOT`; no other stack sweeps it. */
  workDir: string;
  /**
   * Stop the server and the edge, then end this stack's JVMs. Idempotent.
   *
   * `reap: false` stops the server and leaves the JVMs it handed over ALIVE,
   * for a caller that must see them before they go — `play.spec.ts`'s
   * `jvmFates()`. Such a caller owns calling `reap()` itself; nothing else
   * will, and a live JVM after the last spec is a leak.
   */
  stop(options?: { reap?: boolean }): Promise<void>;
  /** End every JVM standing in `workDir`. Idempotent; safe after `stop()` either way. */
  reap(): ReapedJvm[];
}

async function waitForHealth(server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last = 'no answer';
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`the play server exited with ${String(server.exitCode)} before it was healthy`);
    try {
      const res = await fetch(`http://127.0.0.1:${PLAY_SERVER_PORT}/health`);
      const body = await res.text();
      if (res.status === 200) return;
      last = `${res.status} ${body}`;
      if (res.status === 503) throw new Error(`the play server is up but degraded: ${body}`);
    } catch (err) {
      last = String(err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the play server never became healthy: ${last}`);
}

export async function startPlayStack(forge: { jar: string; res: string }): Promise<PlayStack> {
  if (!existsSync(SERVER_JS) || !existsSync(resolve(BUILT_WEB_DIR, 'index.html'))) {
    throw new Error(`no built app: need ${SERVER_JS} and ${BUILT_WEB_DIR}/index.html — build @hadoku/ui and @hadoku/server first`);
  }
  const webDir = mkdtempSync(join(tmpdir(), 'cardtable-e2e-play-web-'));
  if (webDir.split('/').some((seg) => seg.startsWith('.'))) {
    throw new Error(`the temp dir ${webDir} has a dot segment; set TMPDIR to a path without one`);
  }
  cpSync(BUILT_WEB_DIR, webDir, { recursive: true });

  mkdirSync(RUN_DIR, { recursive: true });
  // An empty lobby, every run. See the header: the rooms the spec asserts on
  // are the ones it creates, and a room left by the last run would be in the
  // list beside them.
  rmSync(PLAY_ROOMS_DIR, { recursive: true, force: true });
  mkdirSync(PLAY_ROOMS_DIR, { recursive: true });
  // This stack's OWN work dir, so no other stack's server can sweep it or adopt
  // out of it. Not wiped, and not reused: a crashed match's diagnostics are the
  // reason these directories are kept, and `pruneWorkRoot` is the bound.
  mkdirSync(PLAY_WORK_ROOT, { recursive: true });
  pruneWorkRoot();
  const workDir = mkdtempSync(join(PLAY_WORK_ROOT, STACK_DIR_PREFIX));
  const serverLogFile = resolve(RUN_DIR, 'play-server.jsonl');
  const serverLog = createWriteStream(serverLogFile, { flags: 'w' });
  const secret = randomBytes(24).toString('hex');

  const server = spawn(process.execPath, [SERVER_JS], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'production',
      CARDTABLE_PORT: String(PLAY_SERVER_PORT),
      CARDTABLE_HOST: '127.0.0.1',
      CARDTABLE_WEB_DIR: webDir,
      CARDTABLE_LOG_DIR: resolve(RUN_DIR, 'play-logs'),
      CARDTABLE_ROOMS_DIR: PLAY_ROOMS_DIR,
      CARDTABLE_PLAY_WORK_DIR: workDir,
      EDGE_AUTH_SECRET: secret,
      CARDTABLE_FORGE_JAR: forge.jar,
      CARDTABLE_FORGE_RES: forge.res,
      CARDTABLE_PLAY_PROBE: '1',
    },
  });
  server.stdout?.pipe(serverLog, { end: false });
  server.stderr?.on('data', (chunk: Buffer) => serverLog.write(chunk));
  const exited = new Promise<void>((r) => server.once('exit', () => r()));

  let edge: Server | null = null;
  const reap = (): ReapedJvm[] => reapJvms(workDir);
  const stop = async (options: { reap?: boolean } = {}): Promise<void> => {
    edge?.closeAllConnections();
    edge?.close();
    edge = null;
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      const killed = setTimeout(() => server.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(killed);
    }
    /*
     * The server's LAST lines must be on disk before `stop()` returns, and this
     * is not housekeeping — it decides a verdict.
     *
     * `play.spec.ts`'s `jvmFates` asks this very file which JVMs the server
     * handed over on its way out. Those lines are the last things it writes, and
     * `exit` on the child says nothing about whether its stdout has drained
     * through the pipe into the file. Read one moment too early, the file is
     * missing `jvm-handed-over` for a match that WAS handed over — and the fate
     * of a live JVM with no hand-over line is the fault "the server did not hand
     * it over, yet it is still running". Seen exactly once, 2026-09-26, on a JVM
     * whose own `jvm.json` carried the match id the reaper then reported: lane
     * E's `handOverAll` is unconditional, so a live match at shutdown HAS been
     * handed over and the line existed — this file just had not got it yet.
     *
     * So: wait for both streams to end, then for the log's own `close`.
     */
    await Promise.all(
      [server.stdout, server.stderr].map(
        (s) => new Promise<void>((r) => (s === null || s.readableEnded ? r() : s.once('end', () => r()))),
      ),
    );
    await new Promise<void>((r) => {
      if (serverLog.closed) {
        r();
        return;
      }
      // Listener first, then `end()`: `close` can be emitted synchronously
      // enough that attaching afterwards would wait for an event already gone.
      // `error` resolves too — a log we cannot finish is not a reason to hang
      // teardown before the reaper has run.
      serverLog.once('close', () => r());
      serverLog.once('error', () => r());
      serverLog.end();
    });
    rmSync(webDir, { recursive: true, force: true });
    // Only now: while the server was up, the JVMs it means to keep are exactly
    // what this would have killed.
    if (options.reap !== false) reap();
  };

  try {
    await waitForHealth(server);
    edge = await startEdge({ port: PLAY_EDGE_PORT, upstreamPort: PLAY_SERVER_PORT, secret });
  } catch (err) {
    await stop();
    throw err;
  }
  return {
    origin: PLAY_EDGE_ORIGIN,
    serverPort: PLAY_SERVER_PORT,
    serverLogFile,
    roomsDir: PLAY_ROOMS_DIR,
    workDir,
    stop,
    reap,
  };
}
