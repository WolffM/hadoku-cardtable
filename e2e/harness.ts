/**
 * The e2e harness: the REAL built server, behind a stand-in for the edge.
 *
 * Playwright starts this as its `webServer`. It is plain Node (24 strips the
 * types), with no dependency outside the standard library.
 *
 *   browser ──► 127.0.0.1:EDGE_PORT/cardtable/*   edge.ts — strip the prefix,
 *                                                 stamp the identity headers
 *           ──► 127.0.0.1:SERVER_PORT             apps/server/dist/index.js
 *
 * ## Why there is an edge in a local test at all
 *
 * The app is built for `hadoku.me/cardtable/` and its server is handed ROOT
 * paths, because the edge strips the prefix (`apps/server/src/index.ts`,
 * `base-path.ts`). A browser pointed straight at the server asks for
 * `/cardtable/assets/…` and gets `index.html` back. So the test needs the
 * prefix stripped, and something has to put the friend identity on every
 * request, the socket handshake included.
 *
 * ## The friend gate is NOT weakened
 *
 * The server runs with a real `EDGE_AUTH_SECRET` — random, minted per run,
 * known only to this process and the stand-in edge — and WITHOUT
 * `CARDTABLE_INSECURE_NO_EDGE_AUTH`. It believes identity headers only when the
 * secret checks out, exactly as in production. A context the edge does not
 * know gets nothing stamped, and the server's own floor 404s it; the spec
 * asserts that as its first test.
 *
 * The dev hatch would not even have worked: it grants every header-less caller
 * the same `local-dev` id, so two browser contexts would have been ONE
 * participant, and a two-person draft would have been a one-person draft that
 * looked like it passed.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startEdge } from './edge.ts';
import { STREAM_BASE_PORT, STREAM_NAME_PREFIX, STREAM_PORT_MAX } from './streamNamespace.ts';
import { EDGE_PORT, SERVER_PORT } from './identities.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER_JS = resolve(ROOT, 'apps/server/dist/index.js');
const BUILT_WEB_DIR = resolve(ROOT, 'apps/ui/dist');
const RUN_DIR = resolve(HERE, '.run');
/**
 * This stack's own draft pods, wiped per run the same way `play/harness.ts`'s
 * `PLAY_ROOMS_DIR` already is. Left at the server's own default
 * (`CARDTABLE_LOG_DIR`'s own `../data/drafts`) this and `play/harness.ts`'s
 * stack resolved to the SAME path — both log dirs sit one level under this
 * same `.run` — so a play stack booted while this server was still up would
 * restore pods THIS server wrote, same as `PLAY_ROOMS_DIR`'s own header
 * explains for the rooms dir it already guards against.
 */
const DRAFTS_DIR = resolve(RUN_DIR, 'drafts');

function die(message: string): never {
  console.error(`[e2e-harness] ${message}`);
  process.exit(1);
}

if (!existsSync(SERVER_JS) || !existsSync(resolve(BUILT_WEB_DIR, 'index.html'))) {
  die(
    `no built app: need ${SERVER_JS} and ${BUILT_WEB_DIR}/index.html. ` +
      'Build first: `pnpm --filter @hadoku/ui build && pnpm --filter @hadoku/server build`.',
  );
}

/*
 * The bundle is served from a COPY, for two reasons.
 *
 * 1. A run must not change under itself: `vite build` empties `dist/` first,
 *    so anything rebuilding the UI mid-run would 404 the page half-way through
 *    a draft.
 * 2. express's `sendFile`/`static` (via `send`) refuse any path with a
 *    dot-directory in it and answer 404 — and an agent worktree lives under
 *    `.claude/worktrees/`. The server then reports `/health` 200 while serving
 *    `Not Found` for every page. Production serves from a path with no dot
 *    segment, so this is a property of where a checkout sits, not of the app;
 *    it is still worth knowing that /health cannot see it.
 */
const WEB_DIR = mkdtempSync(join(tmpdir(), 'cardtable-e2e-web-'));
// Registered HERE rather than beside `shutdown()` below, because the very next
// line can `die()` and every `die()` is a `process.exit(1)`.
//
// `shutdown()` already removed WEB_DIR, but only from SIGTERM and SIGINT. Every
// other way this process ends — all six `die()` call sites, an uncaught throw,
// or simply running to completion — left the directory behind, which is how 366
// `cardtable-e2e-web-*` directories reached /tmp on the host by 2026-09-28 (part of
// a 421,879-entry pile that made `du -sm /tmp/*` fail with E2BIG). 'exit' covers
// all of those, fires after `shutdown()`'s own removal, and `force: true` makes
// the second pass a no-op.
process.on('exit', () => {
  try {
    rmSync(WEB_DIR, { recursive: true, force: true });
  } catch {
    // best effort — a temp dir that will not delete is not worth a red run
  }
});
if (WEB_DIR.split('/').some((seg) => seg.startsWith('.'))) {
  die(`the temp dir ${WEB_DIR} has a dot segment too; set TMPDIR to a path without one`);
}
cpSync(BUILT_WEB_DIR, WEB_DIR, { recursive: true });

mkdirSync(RUN_DIR, { recursive: true });
const serverLog = createWriteStream(resolve(RUN_DIR, 'server.jsonl'), { flags: 'w' });

// An empty store, every run — see `DRAFTS_DIR`'s own comment.
rmSync(DRAFTS_DIR, { recursive: true, force: true });
mkdirSync(DRAFTS_DIR, { recursive: true });

const secret = randomBytes(24).toString('hex');

const server = spawn(process.execPath, [SERVER_JS], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'production',
    CARDTABLE_PORT: String(SERVER_PORT),
    CARDTABLE_HOST: '127.0.0.1',
    // A new room opens on the newest Standard era, not a random one: specs read a fresh room's pool.
    CARDTABLE_NEW_ROOM_FORMAT: 'newest',
    CARDTABLE_WEB_DIR: WEB_DIR,
    CARDTABLE_LOG_DIR: resolve(RUN_DIR, 'logs'),
    CARDTABLE_DRAFTS_DIR: DRAFTS_DIR,
    EDGE_AUTH_SECRET: secret,
    // ── This server may only ever touch ITS OWN containers ──────────────────
    // Every cardtable boot runs `sweepOrphans()`, which removes every container
    // matching its name prefix that its own `live` map does not own. That is
    // correct for reclaiming what a restart left behind — and lethal across two
    // servers, because this harness runs on the machine that also runs
    // PRODUCTION cardtable. Sharing the default prefix, this server's boot
    // sweep would delete a real player's streamed room mid-match, and
    // production's next restart would delete this one's containers mid-test.
    // A distinct prefix makes each server's sweep blind to the other's, in both
    // directions; `scripts/stream/container.sh` reads the same variable, so the
    // script and the server cannot disagree about what is ours.
    CARDTABLE_STREAM_NAME_PREFIX: STREAM_NAME_PREFIX,
    // Clear of production's 6100-6199 and of the bench's 6080-6081, so two
    // servers provisioning at once cannot race for a port either.
    CARDTABLE_ROOM_STREAM_PORT: String(STREAM_BASE_PORT),
    // `container.sh` guards the port window a second time, behind the server's
    // constant. Both ends have to move together or every provision is refused.
    CARDTABLE_STREAM_PORT_MIN: String(STREAM_BASE_PORT),
    CARDTABLE_STREAM_PORT_MAX: String(STREAM_PORT_MAX),
    // Deliberately absent: CARDTABLE_INSECURE_NO_EDGE_AUTH, CARDTABLE_FORGE_JAR,
    // CARDTABLE_PLAY_PROBE. This is the production posture, minus Forge, which
    // a draft does not touch. `CARDTABLE_PLAY_SEED` was here too, and that was
    // the wave 20 bug: this server cannot start a Forge match, so the seed it
    // carried seeded nothing. It belongs on the one server that can — see
    // `play/harness.ts`.
    //
    // ONE deliberate deviation from that posture: this server has no jar, so
    // `room/plan.ts`'s own rule ("no jar never passes by default") would
    // refuse every draft's plan forever — `draft.spec`'s "two friends draft a
    // whole pod" never deals (CI run 39715510788). `play/harness.ts`'s server
    // HAS a jar and must keep running the real check, so this flag is set
    // only here, never there. `config.ts` pins that production's own config
    // never reads this var, and `index.ts` warns loudly at boot when it does.
    CARDTABLE_E2E_UNCHECKED_POOLS: '1',
  },
});

server.stdout.pipe(serverLog);
server.stderr.on('data', (chunk: Buffer) => {
  serverLog.write(chunk);
  process.stderr.write(chunk);
});
server.on('exit', (code, signal) => {
  die(`server exited (code ${String(code)}, signal ${String(signal)})`);
});

/** `/health` must be 200 — a 503 means the bundle would render blank. */
async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/health`);
      const body = await res.text();
      if (res.status === 200) return;
      last = `${res.status} ${body}`;
      if (res.status === 503) die(`server is up but degraded: ${body}`);
    } catch (err) {
      last = String(err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  die(`server never became healthy: ${last}`);
}

await waitForHealth();
const edge = await startEdge({ port: EDGE_PORT, upstreamPort: SERVER_PORT, secret });
console.log(`[e2e-harness] server :${SERVER_PORT}, edge :${EDGE_PORT} — ready`);

function shutdown(): void {
  server.removeAllListeners('exit');
  server.kill('SIGTERM');
  edge.close();
  serverLog.end();
  rmSync(WEB_DIR, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
