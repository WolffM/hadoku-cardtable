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
import { subscribe } from 'node:diagnostics_channel';
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
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

import { startEdge } from '../edge.ts';
import { PLAY_SEED } from '../playSeed.ts';
import { closeStaleFriends } from './open-friends.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SERVER_JS = resolve(ROOT, 'apps/server/dist/index.js');
const BUILT_WEB_DIR = resolve(ROOT, 'apps/ui/dist');
export const RUN_DIR = resolve(import.meta.dirname, '..', '.run');
/** This stack's room snapshots. Wiped per run; never production's `data/rooms`. */
export const PLAY_ROOMS_DIR = resolve(RUN_DIR, 'play-rooms');
/**
 * This stack's draft pods. Wiped per run, the same reasoning as
 * `PLAY_ROOMS_DIR`: left at the server's own default
 * (`CARDTABLE_LOG_DIR`'s own `../data/drafts`) it resolved to the SAME path
 * `../harness.ts`'s own stack does — both log dirs sit one level under the
 * same `.run` — so this stack picked up whatever draft pods the shared
 * webServer had already written in the same invocation.
 */
export const PLAY_DRAFTS_DIR = resolve(RUN_DIR, 'play-drafts');
/**
 * This stack's imported-cube store (`apps/server/src/pools/cubes.ts`'s
 * `importDir` — the shortlist itself is `apps/server/pools/cubes/`, a
 * committed path, never this). Unlike `PLAY_ROOMS_DIR`/`PLAY_DRAFTS_DIR`,
 * `startPlayStack` does NOT wipe this one: `createCubeStore` reads it once,
 * at the spawned server's own boot, so a spec that needs a specific cube
 * present (`draft-pools.spec.ts`'s Forge-unplayable fixture) has to write it
 * here BEFORE calling `startPlayStack`, not after — the server would already
 * have booted on whatever was there by the time a post-call write lands. The
 * store creates the directory itself if a spec writes nothing into it.
 */
export const PLAY_CUBES_DIR = resolve(RUN_DIR, 'play-cubes');
/**
 * This stack's card catalog — a committed FIXTURE
 * (`e2e/fixtures/sets-catalog.json`, built by
 * `e2e/fixtures/build-sets-catalog.ts`), never the real
 * `~/.local/share/cardtable/catalog/cards.json` a deploy builds offline and
 * only hokon has. A claw has none of that file at all: without this, every
 * card in every set is `missingText` and `room/plan.ts`'s verdict refuses
 * every realistic/set-cube source outright (found live, run `39746410366`,
 * `catalog-load-failed: ENOENT`). The fixture covers exactly the sets
 * `draft-sets.spec.ts` deals (ISD, ALA, ARB) plus the five basic lands.
 */
export const PLAY_CATALOG = resolve(import.meta.dirname, '..', 'fixtures', 'sets-catalog.json');
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
/**
 * How many finished stacks' work dirs survive `pruneWorkRoot`. 6 is enough for
 * a developer's loop; CI sets `CARDTABLE_E2E_WORK_DIRS_KEPT` high enough that
 * the FAILING test's JVM run dir (its `bridge.stderr.txt`, `jvm.json`) is
 * still there when the job uploads its evidence — with 6, test 14's dir was
 * gone by test 21 (2026-10-03, Q7's `unknown-match` red had nothing to read).
 */
const STALE_WORK_DIRS_KEPT = Number(process.env.CARDTABLE_E2E_WORK_DIRS_KEPT ?? '6');

export const PLAY_EDGE_PORT = Number(process.env.CARDTABLE_E2E_PLAY_EDGE_PORT ?? '19128');
export const PLAY_SERVER_PORT = Number(process.env.CARDTABLE_E2E_PLAY_SERVER_PORT ?? '19028');
export const PLAY_EDGE_ORIGIN = `http://127.0.0.1:${PLAY_EDGE_PORT}`;

/*
 * A socket error nobody listens for is thrown in this worker and fails whichever test is running as a bare
 * "read ECONNRESET", with no stack naming the socket (ca-condition, run 39796470673). Each socket is named
 * by its ports as it opens, since a reset one no longer has them, and the name is printed before the error
 * goes on exactly as before.
 */
const socketNames = new WeakMap<Socket, string>();
const portName = (port: number | undefined): string =>
  port === PLAY_EDGE_PORT ? `play edge ${port}` : port === PLAY_SERVER_PORT ? `play server ${port}` : String(port);
subscribe('net.server.socket', (message) => {
  const { socket } = message as { socket: Socket };
  socketNames.set(socket, `accepted on ${portName(socket.localPort)} from ${portName(socket.remotePort)}`);
});
subscribe('net.client.socket', (message) => {
  const { socket } = message as { socket: Socket };
  socket.once('connect', () => socketNames.set(socket, `dialled ${portName(socket.remotePort)} from ${portName(socket.localPort)}`));
});
const socketEmit = Socket.prototype.emit as (this: Socket, event: string | symbol, ...args: unknown[]) => boolean;
Socket.prototype.emit = function (this: Socket, event: string | symbol, ...args: unknown[]): boolean {
  if (event === 'error' && this.listenerCount('error') === 0) {
    console.log(`[socket-error] ${String((args[0] as Error | undefined)?.message)} with no listener, on a socket ${socketNames.get(this) ?? 'never connected'}`);
  }
  return socketEmit.call(this, event, ...args);
} as typeof Socket.prototype.emit;

/*
 * The handles a later server re-attaches a JVM and its matches by, as
 * `apps/server/src/play/host.ts` and `jvm-transport.ts` write them
 * (`JVM_RECORD_FILE`/`JvmRecord`, `LAUNCH_RECORD_FILE`, `ORPHAN_MAX_MS`). Read here
 * rather than imported: `host.ts` is not erasable-syntax-clean and this package
 * typechecks with `erasableSyntaxOnly` so Node can strip its types (`tsc` exits 2 on
 * the import). ONE copy for the whole e2e — the reaper below and `play.spec.ts`'s
 * `jvmFates` share it.
 */

/** `host.ts` `JVM_RECORD_FILE`: the coordinator's record of a JVM and its matches. */
export const JVM_RECORD_FILE = 'jvm.json';
/** `jvm-transport.ts` `LAUNCH_RECORD_FILE`: the JVM's pid, written at launch. */
export const LAUNCH_RECORD_FILE = 'launch.json';
/** `host.ts` `ORPHAN_MAX_MS`: past this a boot retires an orphaned JVM instead of re-attaching. */
export const ORPHAN_MAX_MS = 12 * 60 * 60 * 1000;

/** The fields of a JVM's two records anything in the e2e asks about. */
export interface JvmRecordSeen {
  hostId: string;
  pid: number;
  orphanedAt: string | null;
  matches: { matchId: string; epoch: string | null; owners: unknown[]; spec: unknown }[];
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `<run>/launch.json` with `<run>/jvm.json`, or null when the launch record is missing or not one. */
export function readJvmRecord(run: string): JvmRecordSeen | null {
  const launch = readJson(resolve(run, LAUNCH_RECORD_FILE));
  if (launch === null || typeof launch.hostId !== 'string' || typeof launch.pid !== 'number') return null;
  const record = readJson(resolve(run, JVM_RECORD_FILE));
  const matches = Array.isArray(record?.matches) ? (record.matches as Record<string, unknown>[]) : [];
  return {
    hostId: launch.hostId,
    pid: launch.pid,
    orphanedAt: typeof record?.orphanedAt === 'string' ? record.orphanedAt : null,
    matches: matches
      .filter((m) => typeof m?.matchId === 'string')
      .map((m) => ({
        matchId: m.matchId as string,
        epoch: typeof m.epoch === 'string' ? m.epoch : null,
        owners: Array.isArray(m.owners) ? m.owners : [],
        spec: m.spec ?? null,
      })),
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

/** One JVM the harness ended. `id` is its host id, null when it had no launch record yet. */
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
 * JVM that died before it wrote its `launch.json` at all.
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
    if (record !== null) reap(record.pid, run, record.hostId);
  }
  // A JVM writes `launch.json` once it is spawned, so one killed before that has no
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
  /**
   * A deploy, mid-test: SIGTERM the server (which hands its live matches over),
   * then start the next one on the same rooms, work dir, port and log, and wait
   * for it to be healthy. Rooms and running matches carry over; nothing else does.
   */
  restart(): Promise<void>;
}

/** The longest a seat may hold a live server window with nothing on its screen to press. */
export const DEAD_BAR_MAX_MS = 3_000;

type LogRow = Record<string, unknown>;

/** The server's structured lines (`{`-led JSON), in order. */
function logRows(serverLogFile: string): LogRow[] {
  if (!existsSync(serverLogFile)) return [];
  return readFileSync(serverLogFile, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as LogRow);
}

/**
 * Every spec's dead-bar check. The client reports `bar-stuck`
 * (`apps/ui/src/play/live/bar-hold.ts`) once a live server window has had nothing pressable
 * on its screen for `BAR_STUCK_MS`, and again when that ends; a seat stuck past
 * {@link DEAD_BAR_MAX_MS}, or still stuck when the log ends, fails the spec that ran it. The
 * server's own `window-resent` repairs are printed beside it.
 */
function deadBars(rows: readonly LogRow[]): string[] {
  const lastAt = rows.length === 0 ? 0 : Date.parse(String(rows.at(-1)!.t));
  for (const r of rows.filter((r) => r.evt === 'window-resent')) console.log(`[window-resent] ${JSON.stringify(r)}`);
  const stuck = rows.filter((r) => r.evt === 'client' && r.kind === 'bar-stuck');
  for (const r of stuck) console.log(`[bar-stuck] ${JSON.stringify(r)}`);
  const dead = stuck.filter((r, i) => {
    if (r.phase === 'cleared') return Number(r.ms) > DEAD_BAR_MAX_MS;
    const cleared = stuck.slice(i + 1).some((c) => c.phase === 'cleared' && c.seat === r.seat && c.matchId === r.matchId);
    return !cleared && Number(r.ms) + (lastAt - Date.parse(String(r.t))) > DEAD_BAR_MAX_MS;
  });
  return dead.length === 0 ? [] : [`a seat's live window had nothing pressable for over ${DEAD_BAR_MAX_MS} ms: ${dead.map((r) => JSON.stringify(r)).join(' ; ')}`];
}

/**
 * An ask whose frame did not parse (`ask-unparsed`, `match.ts`: shown as a fallback pick or
 * left open) or a trigger decision the server could not read (`trigger-decision-malformed`,
 * `socket.ts`) is a prompt shape nothing was built for. Zero in all 422 stack logs of five
 * full-shard evidence uploads (2026-10-12), so any one of them is the spec's red.
 */
function unreadAsks(rows: readonly LogRow[]): string[] {
  const bad = rows.filter((r) => r.evt === 'ask-unparsed' || r.evt === 'trigger-decision-malformed');
  return bad.length === 0 ? [] : [`the server could not read ${bad.length} ask(s) or decision(s): ${bad.map((r) => JSON.stringify(r)).join(' ; ')}`];
}

/**
 * A hand-over or landing that left two copies of the card drawn on the frame after it
 * (`handover-report.ts`'s `doubled`, with `copies` naming what was drawn): a hand-over is a
 * swap, so any one of them is the spec's red.
 */
function doubledHandovers(rows: readonly LogRow[]): string[] {
  const doubled = rows.filter((r) => r.evt === 'client' && (r.kind === 'handover' || r.kind === 'landing') && r.doubled === true);
  for (const r of doubled) console.log(`[handover-doubled] ${JSON.stringify(r)}`);
  return doubled.length === 0 ? [] : [`${doubled.length} hand-over(s) left two copies of a card drawn: ${doubled.map((r) => JSON.stringify(r)).join(' ; ')}`];
}

/**
 * The other seat's back taken down by a clock rather than by its card (`presence.ts`'s `expire`).
 * `how: 'grace'` is a cancelled play's designed end, printed only. `how: 'timeout'` means the play's
 * safety clock ran out while nothing said it was still being decided — a back the other seat saw
 * stand with no card behind it, or taken away mid-decision — and is the spec's red; the match's own
 * server rows across the wait are printed with it, which is what tells the two apart.
 */
function expiredStandIns(rows: readonly LogRow[]): string[] {
  const expired = rows.filter((r) => r.evt === 'client' && r.kind === 'stand-in');
  for (const r of expired) {
    console.log(`[stand-in] ${JSON.stringify(r)}`);
    if (r.how !== 'timeout') continue;
    const end = Date.parse(String(r.t));
    const start = end - Number(r.ms) - 1000;
    for (const o of rows) {
      const t = Date.parse(String(o.t));
      if (o !== r && o.matchId === r.matchId && t >= start && t <= end) console.log(`[stand-in]   +${t - start - 1000}ms ${JSON.stringify(o).slice(0, 300)}`);
    }
  }
  const timedOut = expired.filter((r) => r.how === 'timeout');
  return timedOut.length === 0 ? [] : [`${timedOut.length} stand-in(s) taken down by the safety clock, not by their card: ${timedOut.map((r) => JSON.stringify(r)).join(' ; ')}`];
}

/** What every spec's stack checks at `stop()`, whatever the spec was about. */
function assertStackInvariants(serverLogFile: string): void {
  const rows = logRows(serverLogFile);
  const broken = [...deadBars(rows), ...unreadAsks(rows), ...doubledHandovers(rows), ...expiredStandIns(rows)];
  if (broken.length > 0) throw new Error(broken.join('\n'));
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
  const begun = Date.now();
  // The previous test's pages, if it left them open — see `open-friends.ts`.
  const closed = await closeStaleFriends();
  if (closed > 0) console.log(`[play-stack] closed ${closed} browser context(s) left open by an earlier test`);
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
  // Likewise an empty drafts store — see `PLAY_DRAFTS_DIR`'s own comment.
  rmSync(PLAY_DRAFTS_DIR, { recursive: true, force: true });
  mkdirSync(PLAY_DRAFTS_DIR, { recursive: true });
  // This stack's OWN work dir, so no other stack's server can sweep it or adopt
  // out of it. Not wiped, and not reused: a crashed match's diagnostics are the
  // reason these directories are kept, and `pruneWorkRoot` is the bound.
  mkdirSync(PLAY_WORK_ROOT, { recursive: true });
  pruneWorkRoot();
  const workDir = mkdtempSync(join(PLAY_WORK_ROOT, STACK_DIR_PREFIX));
  // One log PER STACK, named after its work dir, in `RUN_DIR` (which nothing
  // prunes mid-run). It used to be one `play-server.jsonl` opened with `'w'`
  // by every stack, so a 48-test CI run kept only the last stack's server log
  // and a failure in test 29 had no server side to read by the time the job
  // ended (2026-10-03, R13). `PlayStack.serverLogFile` is how a spec finds it.
  const serverLogFile = resolve(RUN_DIR, `play-server-${basename(workDir)}.jsonl`);
  const serverLog = createWriteStream(serverLogFile, { flags: 'w' });
  const secret = randomBytes(24).toString('hex');

  /** One server process on this stack's dirs; `restart` launches the next one on the SAME dirs. */
  const launch = (): ChildProcess =>
    spawn(process.execPath, [SERVER_JS], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        NODE_ENV: 'production',
        CARDTABLE_PORT: String(PLAY_SERVER_PORT),
        CARDTABLE_HOST: '127.0.0.1',
        // A new room opens on the newest Standard era, not a random one: specs read a fresh room's pool.
        CARDTABLE_NEW_ROOM_FORMAT: 'newest',
        CARDTABLE_WEB_DIR: webDir,
        CARDTABLE_LOG_DIR: resolve(RUN_DIR, 'play-logs'),
        CARDTABLE_ROOMS_DIR: PLAY_ROOMS_DIR,
        CARDTABLE_DRAFTS_DIR: PLAY_DRAFTS_DIR,
        CARDTABLE_CUBES_DIR: PLAY_CUBES_DIR,
        CARDTABLE_CATALOG: PLAY_CATALOG,
        CARDTABLE_PLAY_WORK_DIR: workDir,
        EDGE_AUTH_SECRET: secret,
        CARDTABLE_FORGE_JAR: forge.jar,
        CARDTABLE_FORGE_RES: forge.res,
        CARDTABLE_PLAY_PROBE: '1',
        /*
         * ONE game, every run — and this is the server that plays it.
         *
         * The seed reaches Forge through `parseStartBody`, which reads this
         * variable off the PLAY SERVER's environment (`play/socket.ts`), so it
         * has to be set on the process spawned here. It was set on
         * `e2e/harness.ts`'s server instead (wave 20), and that server is the one
         * started WITHOUT `CARDTABLE_FORGE_JAR` — "deliberately absent … minus
         * Forge" in its own comment. So no e2e match has ever been seeded: every
         * run of `play.spec.ts` dealt a fresh shuffle, and the two runs recorded
         * as "seed 7 verified twice" were two lucky deals.
         *
         * With it here the deal is fixed: two cold matches on one seed produce
         * the same library permutation for both seats, measured through the real
         * bridge (`MyRandom.setRandom` in `PlayBridge.java`, Forge's shuffle in
         * `GameAction.java`). A red in `play.spec.ts` is now the product.
         */
        CARDTABLE_PLAY_SEED: String(PLAY_SEED),
        // Off: this server would otherwise run `createCatalogRefresh` at
        // boot against the shared `~/.local/share/cardtable/scryfall` cache
        // — a real Scryfall download, every e2e run (wave 74 §E). Production
        // is the only server this stays on for.
        CARDTABLE_CATALOG_REFRESH: '0',
        // Bots take a turn every 100 ms rather than production's 1.2 s: a spec drives
        // 45 picks a drafter, and at production's pace the bots, not the product,
        // would be what it waits on. Still a clock, so packs queue as they do live.
        CARDTABLE_DRAFT_BOT_PICK_MS: '100',
      },
    });
  /** Whoever is waiting on a line the server has not written yet — see {@link jvmWarm}. */
  const lineWatchers = new Set<(line: string) => void>();
  /*
   * Both streams land in ONE file, so each is written a whole line at a time.
   * Copying raw chunks let a stdout chunk that ended mid-line be followed by a
   * stderr chunk or by the next stdout line's start — a torn line that is not
   * JSON, which `play.spec.ts`'s `serverLog()` then threw on (seen 2026-09-30:
   * `…"path":"/r-4270d944{"t":…`). A partial line is held until its newline
   * arrives, and flushed when its stream ends.
   */
  const pipeLog = (proc: ChildProcess): void => {
    for (const stream of [proc.stdout, proc.stderr]) {
      if (stream === null) continue;
      let held = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        const lines = (held + chunk).split('\n');
        held = lines.pop() ?? '';
        for (const line of lines) {
          serverLog.write(`${line}\n`);
          for (const watch of lineWatchers) watch(line);
        }
      });
      stream.on('end', () => {
        if (held !== '') serverLog.write(`${held}\n`);
        held = '';
      });
    }
  };
  /** Every line a process wrote is in the log once both its streams have ended. */
  const drained = (proc: ChildProcess): Promise<void[]> =>
    Promise.all(
      [proc.stdout, proc.stderr].map(
        (s) => new Promise<void>((r) => (s === null || s.readableEnded ? r() : s.once('end', () => r()))),
      ),
    );
  /** SIGTERM — the signal pm2 sends on a deploy, which hands live matches over — and SIGKILL after 10 s. */
  const terminate = async (proc: ChildProcess): Promise<void> => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<void>((r) => proc.once('exit', () => r()));
    proc.kill('SIGTERM');
    const killed = setTimeout(() => proc.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(killed);
  };
  /**
   * Resolves on the server's own "the next match will not wait for a JVM" line: `jvm-warm`
   * (or `warm-disabled`, after which a match launches its own JVM and there is nothing to wait
   * for). Watched from the first byte, so the line cannot be missed.
   *
   * Why the stack waits on it: every stack is a fresh server, and `POST /api/play/matches`
   * adopts the spare it is still booting and answers only once Forge is ready, so the
   * request carried the whole JVM boot. That is 8.4–9.3 s on an idle CI runner and 15–19 s on a
   * loaded one (run 38117429287, 61 stacks), and past ~19 s Playwright's 20 s request
   * timeout cut it: the M4 `apiRequestContext.post: Timeout 20000ms` reds. Waiting here
   * leaves the request the ~0.5 s it takes a warm JVM to open a game.
   */
  const jvmWarm = (proc: ChildProcess): Promise<void> =>
    new Promise<void>((resolveWarm, rejectWarm) => {
      const done = (err?: Error): void => {
        lineWatchers.delete(watch);
        proc.off('exit', exited);
        clearTimeout(cap);
        if (err === undefined) resolveWarm();
        else rejectWarm(err);
      };
      // The pool logs compact `JSON.stringify` lines (`host.ts` `defaultHostLog`).
      const watch = (line: string): void => {
        if (/"evt":"(jvm-warm|warm-disabled)"/.test(line)) done();
      };
      const exited = (): void => done(new Error(`the play server exited with ${String(proc.exitCode)} before its warm JVM was warm`));
      // The server's own bound on a match start (`socket.ts`, `startTimeoutMs`): a JVM that is
      // not warm by then would fail the match placed into it anyway.
      const cap = setTimeout(() => done(new Error('the play server\'s warm JVM was not warm within 60 s')), 60_000);
      lineWatchers.add(watch);
      proc.once('exit', exited);
    });
  let server = launch();
  pipeLog(server);
  const warm = jvmWarm(server);
  // Awaited once the edge is up. Marked handled now, so a failure that lands before then
  // is not reported as an unhandled rejection on top of the error the await rethrows.
  warm.catch(() => undefined);

  let edge: Server | null = null;
  const reap = (): ReapedJvm[] => reapJvms(workDir);
  const stop = async (options: { reap?: boolean } = {}): Promise<void> => {
    // AE20: while recording (`CARDTABLE_E2E_VIDEO=1`), close this stack's own
    // friends HERE rather than leaving them for the next stack's
    // `closeStaleFriends` — otherwise the LAST test in a run never flushes
    // its `.webm` at all. Absent when the flag is unset: no behaviour change.
    if (process.env.CARDTABLE_E2E_VIDEO === '1') await closeStaleFriends();
    edge?.closeAllConnections();
    edge?.close();
    edge = null;
    await terminate(server);
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
    await drained(server);
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
    assertStackInvariants(serverLogFile);
  };

  try {
    const spawned = Date.now();
    await waitForHealth(server);
    const healthy = Date.now();
    edge = await startEdge({ port: PLAY_EDGE_PORT, upstreamPort: PLAY_SERVER_PORT, secret });
    await warm;
    // What a test pays before its match exists, split where it goes: the evidence for (or
    // against) sharing one server across a worker's tests.
    console.log(`[play-stack] up in ${Date.now() - begun} ms: prepare ${spawned - begun}, server healthy ${healthy - spawned}, warm JVM up ${Date.now() - healthy}`);
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
    restart: async () => {
      // The edge stays up, so every browser keeps its origin and its socket
      // reconnects to the next server exactly as it does across a deploy.
      await terminate(server);
      await drained(server);
      server = launch();
      pipeLog(server);
      await waitForHealth(server);
    },
  };
}
