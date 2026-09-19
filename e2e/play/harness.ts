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
 * The bundle is served from a temp copy, for the reasons `../harness.ts` gives
 * (a concurrent `vite build` empties `dist/`; `send` 404s any path with a
 * dot-directory in it, and an agent worktree lives under `.claude/`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startEdge } from '../edge.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SERVER_JS = resolve(ROOT, 'apps/server/dist/index.js');
const BUILT_WEB_DIR = resolve(ROOT, 'apps/ui/dist');
export const RUN_DIR = resolve(import.meta.dirname, '..', '.run');
/** This stack's room snapshots. Wiped per run; never production's `data/rooms`. */
export const PLAY_ROOMS_DIR = resolve(RUN_DIR, 'play-rooms');
/** This stack's per-match run directories. NEVER production's `/tmp/cardtable-play`. */
export const PLAY_WORK_DIR = resolve(RUN_DIR, 'play-work');

export const PLAY_EDGE_PORT = Number(process.env.CARDTABLE_E2E_PLAY_EDGE_PORT ?? '19128');
export const PLAY_SERVER_PORT = Number(process.env.CARDTABLE_E2E_PLAY_SERVER_PORT ?? '19028');
export const PLAY_EDGE_ORIGIN = `http://127.0.0.1:${PLAY_EDGE_PORT}`;

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

export interface PlayStack {
  origin: string;
  serverPort: number;
  /** The server's structured log, one JSON object per line. */
  serverLogFile: string;
  /** Where this stack's rooms and match run dirs went. Reported, so a run can prove it was not production's. */
  roomsDir: string;
  workDir: string;
  /** Stop the server (which stops every match JVM) and the edge. Idempotent. */
  stop(): Promise<void>;
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
  // Not wiped: a crashed match's diagnostics are the reason this directory is
  // kept, and the server's own boot sweep bounds it.
  mkdirSync(PLAY_WORK_DIR, { recursive: true });
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
      CARDTABLE_PLAY_WORK_DIR: PLAY_WORK_DIR,
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
  const stop = async (): Promise<void> => {
    edge?.closeAllConnections();
    edge?.close();
    edge = null;
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      const killed = setTimeout(() => server.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(killed);
    }
    serverLog.end();
    rmSync(webDir, { recursive: true, force: true });
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
    workDir: PLAY_WORK_DIR,
    stop,
  };
}
