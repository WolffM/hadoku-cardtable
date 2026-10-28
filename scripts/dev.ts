/**
 * `pnpm dev`: the whole app on this machine, with no service key, no vault and no hadoku.me.
 *
 *   browser ──► 127.0.0.1:PORT/cardtable/*    e2e/edge.ts, the same stand-in for the edge the
 *                                             e2e suite runs behind: strips the prefix
 *           ──► 127.0.0.1:PORT+1              apps/server/dist/index.js, the real built server
 *
 * Why an edge at all: the app is built for `hadoku.me/cardtable/` and its server is handed ROOT
 * paths, because hadoku.me's edge strips the prefix. A browser pointed straight at the server asks
 * for `/cardtable/assets/…` and gets `index.html` back: a blank page.
 *
 * Identity: the server runs with its dev hatch (`CARDTABLE_INSECURE_NO_EDGE_AUTH=1`, no
 * `EDGE_AUTH_SECRET`), so every visitor is the one `local-dev` participant, at `admin` tier so the
 * seeded testing rooms show (`CARDTABLE_DEV_TIER` to change it). Two browser windows are therefore
 * the SAME player; the e2e suite is where two-person flows are tested.
 *
 * Forge: `scripts/forge-bundle.sh` builds (first time: Maven, a few minutes) and caches the
 * submodule's pinned jar. With no JDK 21 or Maven it says so and the app starts anyway: rooms,
 * drafts and deck building work, and starting a match answers that Forge is missing. Set
 * `CARDTABLE_FORGE_JAR` and `CARDTABLE_FORGE_RES` to use a jar you already have, or
 * `CARDTABLE_DEV_NO_FORGE=1` to skip it.
 *
 * Everything the server writes goes under `.dev/` in this checkout (gitignored): logs, rooms,
 * recordings, Forge's run directories, and its own copy of Scryfall's card data (~200 MB, fetched on
 * the first start). Nothing is shared with another checkout or with a production install on the
 * same machine. Ctrl-C stops the server and the Forge JVMs it started.
 *
 * Not here, because they are other hadoku.me services: the room chat (watchparty), sign-in, match
 * stats. Their panels stay empty.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startEdge } from '../e2e/edge.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV = join(REPO, '.dev');
const PORT = Number(process.env.CARDTABLE_DEV_PORT ?? 9300);
const SERVER_PORT = PORT + 1;

function forge(): Record<string, string> {
  if (process.env.CARDTABLE_FORGE_JAR && process.env.CARDTABLE_FORGE_RES) return {};
  if (process.env.CARDTABLE_DEV_NO_FORGE === '1') {
    console.log('[dev] CARDTABLE_DEV_NO_FORGE=1: no Forge, so no matches');
    return {};
  }
  console.log('[dev] resolving the Forge jar for this checkout (scripts/forge-bundle.sh; the first build takes a few minutes)');
  const run = spawnSync('bash', ['scripts/forge-bundle.sh'], { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (run.status !== 0) {
    console.log('[dev] no Forge jar (needs git, a JDK 21 and Maven on PATH; reason above). Starting without it: matches are off.');
    return {};
  }
  return Object.fromEntries(
    run.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('=') as [string, string]),
  );
}

/** Stop the Forge JVMs under this checkout's `.dev/work`: the server leaves them running across its own restarts on purpose. */
function stopJvms(workDir: string): void {
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  for (const line of ps.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2].includes('java') && m[2].includes(workDir)) {
      try {
        process.kill(Number(m[1]), 'SIGTERM');
      } catch (err) {
        console.log(`[dev] could not stop JVM ${m[1]}: ${(err as Error).message}`);
      }
    }
  }
}

async function healthy(deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${SERVER_PORT}/health`)).ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const logDir = join(DEV, 'logs');
const workDir = join(DEV, 'work');
mkdirSync(logDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...forge(),
  CARDTABLE_INSECURE_NO_EDGE_AUTH: '1',
  CARDTABLE_DEV_TIER: process.env.CARDTABLE_DEV_TIER ?? 'admin',
  CARDTABLE_HOST: '127.0.0.1',
  CARDTABLE_PORT: String(SERVER_PORT),
  CARDTABLE_LOG_DIR: logDir,
  CARDTABLE_PLAY_WORK_DIR: workDir,
  CARDTABLE_CATALOG: join(DEV, 'catalog', 'cards.json'),
  CARDTABLE_SCRYFALL_DIR: join(DEV, 'scryfall'),
  CARDTABLE_STREAM_PORT: String(PORT + 10),
  CARDTABLE_ROOM_STREAM_PORT: String(PORT + 20),
  CARDTABLE_STREAM_NAME_PREFIX: 'cardtable-dev',
};
// The dev hatch only opens with no secret: a stray one from the shell would refuse every request.
delete env.EDGE_AUTH_SECRET;

const log = openSync(join(logDir, 'server.log'), 'a');
const server: ChildProcess = spawn(process.execPath, [join(REPO, 'apps/server/dist/index.js')], { env, stdio: ['ignore', log, 'pipe'] });
server.stderr?.pipe(process.stderr);

let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  server.kill('SIGTERM');
  stopJvms(workDir);
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
server.on('exit', (code) => {
  if (stopping) return;
  console.log(`[dev] the server exited (${code}); its log is ${join(logDir, 'server.log')}`);
  stop(code ?? 1);
});

if (!(await healthy(Date.now() + 60_000))) {
  console.log(`[dev] the server never answered /health; its log is ${join(logDir, 'server.log')}`);
  stop(1);
}
// The edge stamps identity only for the e2e suite's named friends; here it only strips the prefix,
// and the dev hatch makes the caller `local-dev`. The secret is never used, so any value will do.
await startEdge({ port: PORT, upstreamPort: SERVER_PORT, secret: randomBytes(16).toString('hex') });
console.log(`[dev] Card Table on http://127.0.0.1:${PORT}/cardtable/  (server log: ${join(logDir, 'server.log')}; Ctrl-C to stop)`);
