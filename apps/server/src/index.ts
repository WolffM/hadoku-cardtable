/**
 * Cardtable — loopback-UI tunnel server
 *
 * ## Where this sits
 *
 *   browser ──► hadoku.me/cardtable/*
 *            ──► edge-router          tier gate + stripPrefix '/cardtable'
 *            ──► cardtable.hadoku.me  cloudflared
 *            ──► 127.0.0.1:9008    ◄── THIS process
 *
 * Because the edge strips the prefix, this server is handed ROOT paths: `/`,
 * `/assets/…`, `/api/…`, `/health`. The browser is not — see src/base-path.ts,
 * which is the whole reason that file exists.
 *
 * ## What this shape is for
 *
 * An app that owns BOTH its front end and its back end in one repo, with no
 * third-party backend to demux in front of. It publishes no `@wolffm/*` package,
 * has no GitHub-Pages shell, no `registry.json` entry and no `[app].astro` route:
 * the bundle it builds is the bundle it serves.
 *
 * Its neighbours, and why they are not this:
 *   tunnel            API only; the UI is a published micro-frontend on GH Pages.
 *   tunnel-proxy      demuxes a third-party backend; ships NO hadoku chrome.
 *   tunnel-contained  demuxes a third-party backend AND serves its own React UI.
 *   ui-app            a published micro-frontend with no service at all.
 *
 * ## The contract this server keeps
 *
 * 1. `/health` answers unauthenticated, always — the monitoring probe has no key.
 * 2. Everything else is refused below the tier floor, independently of the edge.
 * 3. A bundle that would render blank is replaced by a page that says why.
 *
 * ## The socket, and why express is not enough for it
 *
 * The draft room runs over socket.io on this same server. engine.io takes its
 * handshake off the raw HTTP server, so express middleware — including
 * `requireMinTier` below — never runs for it. `src/room/socket.ts` therefore
 * re-applies the same two steps to the handshake itself, in the same order;
 * read its header before changing anything about how a socket gets in. The
 * socket path stays socket.io's default `/socket.io/` for the same reason every
 * other path here is a root path: the edge strips `/cardtable` before we see it.
 *
 * A SECOND transport shares that same HTTP server: `GET /play/ws`, a plain
 * WebSocket for a browser client that cannot speak socket.io. It re-applies the
 * identical two steps for the identical reason — see `attachBrowserBridge`
 * below and `src/play/browser/index.ts`'s header. Two listeners on one
 * `upgrade` event, each answering only its own path.
 *
 * ## Why this is not built with `tsc`
 *
 * `package.json`'s `build` typechecks with `tsc --noEmit` and then bundles with
 * esbuild, rather than emitting with `tsc`. That is forced, not stylistic:
 * `@hadoku/draft` and `@hadoku/shared` publish TypeScript SOURCE (their
 * `exports` point at `src/index.ts`, because Node 24 strips types natively and
 * they have no build step), and their own imports carry `.ts` extensions. `tsc`
 * refuses to EMIT a program containing those — `allowImportingTsExtensions` is
 * only legal alongside `noEmit` — so the choice is a bundler or no workspace
 * imports at all. The externals passed to esbuild are exactly this package's
 * own `dependencies` minus the `@hadoku/*` ones: anything a workspace package
 * pulls in transitively must be BUNDLED, because pnpm's strict layout does not
 * expose it next to `dist/`. `main` and `start` are unchanged — `dist/index.js`
 * is still a plain file that plain `node` runs.
 */

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketIOServer } from 'socket.io';
import { CONFIG, INDEX_HTML } from './config.js';
import { edgeProvenance, requireMinTier, tierOf, userIdOf } from './edge-auth.js';
import { checkBundle, diagnosticPage, sendIndex } from './base-path.js';
import { createDraftRooms } from './room/draftRooms.js';
import { draftEmitPolicy, emitDraftUpdate } from './room/emit.js';
import { loadPool } from './room/pool.js';
import { attachDraftSocket } from './room/socket.js';
import { attachPlay, jvmHostConfig, jvmHostFactory, type PlayHandle } from './play/index.js';
import { attachStream, attachStreamRoutes, streamLayout, STREAM_BASE_PORT } from './stream/index.js';
import { attachBrowserBridge } from './play/browser/index.js';
import { attachTables } from './http/index.js';
import { attachRooms } from './http/rooms.js';
import { openLobby } from './room/lobby.js';

mkdirSync(CONFIG.logDir, { recursive: true });

const app = express();
app.set('trust proxy', true);
// The edge already sets security headers for hadoku.me; this one is ours because
// the tunnel hostname can be hit directly and must not be framed.
app.disable('x-powered-by');

// ── Boot-time checks ─────────────────────────────────────────────────────────
// Evaluated once. The bundle does not change under a running process — a rebuild
// is a redeploy, which restarts us — so re-reading per request would buy nothing
// and would put a synchronous file read on the hot path.
//
// Awaited before a single route exists, because the verdict decides which
// routes are registered. `checkBundle` is "built right AND servable": it ends by
// fetching index.html through `sendIndex` itself, which is what makes a server
// started under a dot-directory report `unservable` instead of a green probe
// over a 404 on every page. See base-path.ts.
const basePath = await checkBundle(INDEX_HTML, CONFIG.basePrefix);

// ── Provenance + access log ──────────────────────────────────────────────────
app.use(edgeProvenance);
app.use((req, res, next) => {
	const start = process.hrtime.bigint();
	res.on('finish', () => {
		const ms = Number(process.hrtime.bigint() - start) / 1e6;
		// One line per completed request, with the EFFECTIVE identity — what the
		// handlers actually saw, post-sanitize. A spoofed request logs as public.
		console.log(
			JSON.stringify({
				t: new Date().toISOString(),
				svc: 'cardtable',
				method: req.method,
				path: req.path,
				status: res.statusCode,
				ms: Math.round(ms),
				user: userIdOf(req),
				tier: tierOf(req),
			})
		);
	});
	next();
});

// ── Health (public, never gated) ─────────────────────────────────────────────
// The monitoring probe reaches this without a session key, so it must sit ahead
// of requireMinTier. It reports the base-path verdict: a server that is up but
// serving a bundle nobody can load is degraded, not healthy, and saying so here
// is what keeps "green probe, blank page" from being a state this app can be in.
app.get('/health', (_req: Request, res: Response) => {
	res.status(basePath.ok ? 200 : 503).json({
		status: basePath.ok ? 'healthy' : 'degraded',
		service: 'cardtable-tunnel',
		bundle: basePath.reason,
		timestamp: new Date().toISOString(),
	});
});

// ── The tier floor ───────────────────────────────────────────────────────────
// Everything below this line is gated. Register new public routes ABOVE it and
// say why in a comment — this line moving down is the shape of a privilege bug.
app.use(requireMinTier);

// ── API ──────────────────────────────────────────────────────────────────────
// Mount the app's own routes here. They arrive prefix-stripped, so a browser
// call to hadoku.me/cardtable/api/thing lands on `/api/thing`.
const api = express.Router();
api.use(express.json({ limit: '1mb' }));

api.get('/whoami', (req: Request, res: Response) => {
	// Handed straight through from the edge, post-sanitize. Useful as the first
	// thing to curl when wiring the tunnel up: it proves provenance end to end.
	res.json({ userId: userIdOf(req), tier: tierOf(req) });
});

app.use('/api', api);

// ── Static bundle ────────────────────────────────────────────────────────────
// Hashed filenames, so assets are immutable. index.html is handled separately
// below with no-store: it is the one file whose name does not change, and a
// cached copy pointing at bundles that no longer exist is a redeploy that looks
// like it broke the app.
if (basePath.ok) {
	app.use(
		express.static(CONFIG.webDir, {
			index: false,
			maxAge: '1y',
			immutable: true,
			setHeaders: (res, filePath) => {
				if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
			},
		})
	);
}

// ── Streamed Forge, HTTP half ────────────────────────────────────────────────
// noVNC's pages and assets, straight out of websockify in the containers.
// MUST be above the SPA fallback: below it, /stream/0/vnc.html is answered
// with index.html and the link renders the cardtable app instead of noVNC —
// which is what happened to this route's bench predecessor on 2026-09-21.
// Inert unless ~/.local/share/cardtable/stream/STREAMS names containers; see
// stream/index.ts for the gate and the interim limits.
const STREAM_LAYOUT = streamLayout();
attachStreamRoutes(app, { minTier: CONFIG.minTier, streamBasePort: STREAM_BASE_PORT, ...STREAM_LAYOUT });

// ── SPA fallback ─────────────────────────────────────────────────────────────
// Every client-routed path serves the same index.html. Scoped to GET/HEAD: a
// POST to a path that does not exist is a bug in the caller, and answering it
// with an HTML page hides that.
app.get(/.*/, (_req: Request, res: Response, next: NextFunction) => {
	if (!basePath.ok) {
		return res.status(503).type('html').send(diagnosticPage(basePath, CONFIG.basePrefix));
	}
	sendIndex(res, INDEX_HTML, (err) => err && next(err));
});

// ── The draft room ───────────────────────────────────────────────────────────
// The cube the pod is dealt from. Read once at boot, like the base-path check
// and for the same reason: a synchronous read of a 280 kB file does not belong
// on a request path, and a rebuild is a redeploy.
//
// `PKG_ROOT` is computed the way `config.ts` computes it, and it has to be:
// `dist/index.js` and `src/index.ts` are both exactly one directory below the
// package root, which is what makes one expression right for both the bundle
// and `tsx`. A module one level deeper could not do this.
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const POOL_FILE = process.env.CARDTABLE_POOL_FILE
	? resolve(process.env.CARDTABLE_POOL_FILE)
	: resolve(PKG_ROOT, '../ui/src/draft/pool.json');
const poolLoad = loadPool(POOL_FILE);

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
	// The default path. The browser asks for `/cardtable/socket.io/` and the
	// edge strips the prefix, so setting one here would break it — see
	// `apps/ui/src/draft/socket.ts`'s `socketPath`.
	serveClient: false,
});

// A disconnected drafter keeps their seat for DISCONNECT_GRACE_MS before it is
// vacated and held, so a browser refresh — whose old socket closes BEFORE the
// new one joins — is invisible to the rest of the pod instead of a seat that
// blinks `held` and back. Wave 10 measured that close-to-join gap at ~36 ms on
// loopback; five seconds covers a reload through the edge and a slow bundle
// fetch with room to spare, and delays announcing a genuine drop by an amount
// nobody waiting on a pick will notice. See draftRooms.ts's header.
const DISCONNECT_GRACE_MS = 5_000;
const draftPolicy = draftEmitPolicy((line) =>
	console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'cardtable-draft', ...line }))
);
const draftRooms = poolLoad.ok
	? createDraftRooms({
			pool: poolLoad.pool.cards,
			cube: poolLoad.pool.meta,
			params: { disconnectGraceMs: DISCONNECT_GRACE_MS },
			// The grace ran out: the seat was vacated on a timer, with no socket
			// event to answer, so the broadcast is made here.
			onDeferredChange: (room) => emitDraftUpdate(io, room, draftPolicy),
		})
	: null;
attachDraftSocket(io, { rooms: draftRooms, minTier: CONFIG.minTier });

// ── Rooms ───────────────────────────────────────────────────────────────────
// The room list the front page shows, and the per-player state a table reads.
// Persisted, because this repo redeploys several times a day and an in-memory
// room would take its members and its password with it every time. `data/` is
// gitignored, so a `git pull` deploy leaves it alone; e2e sets CARDTABLE_LOG_DIR
// and therefore gets its own directory rather than production's.
const lobby = await openLobby({
	dir: process.env.CARDTABLE_ROOMS_DIR ?? resolve(CONFIG.logDir, '../data/rooms'),
	log: (entry) => console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'cardtable-rooms', ...entry })),
});
attachRooms(api, { lobby });

// ── Constructed ──────────────────────────────────────────────────────────────
// Formats, the deck library, and the deck gate on POST /api/play/matches. MUST
// come before attachPlay: the gate is a handler on play's own path and runs
// only if it is registered first. See src/http/README.md.
// `matches` is read lazily: the gate binds each player to the seat their own
// deck is in, and play's registry does not exist until attachPlay below — which
// must stay after this call for the gate to answer first at all.
let play: PlayHandle | null = null;
attachTables(api, {
	repoRoot: resolve(PKG_ROOT, '../..'),
	draftRooms,
	rooms: lobby,
	matches: () => play?.matches ?? null,
});

// ── Matches ──────────────────────────────────────────────────────────────────
// One child JVM per match; see src/play/README.md. Without a configured Forge
// build the route answers 503 and nothing else changes.
const forge = jvmHostConfig();
if (!forge.ok) console.warn(`[cardtable] play: no Forge (${forge.reason}) — POST /api/play/matches answers 503`);
play = attachPlay(io, api, {
	minTier: CONFIG.minTier,
	host: forge.ok ? jvmHostFactory(forge.config) : null,
	// Diagnostics for a live check only. Never set in production (see play/socket.ts).
	probe: process.env.CARDTABLE_PLAY_PROBE === '1',
	devIdentity: CONFIG.allowUnverifiedEdge && CONFIG.edgeAuthSecret === '',
});

// ── The browser bridge ───────────────────────────────────────────────────────
// `GET /play/ws`: the SECOND client type for the same matches — a plain
// WebSocket, for a browser client that is not our React app and cannot speak
// socket.io (the CheerpJ page binds a browser `WebSocket` into Forge's
// `IToServer`). It is not a second play stack: every byte it serves comes out
// of the registry `attachPlay` built above, already projected for one seat.
//
// `matches` is read LAZILY, as `attachTables`'s is and for the same reason —
// `play` does not exist until the call above returns, and a lazy read is what
// lets this mount sit anywhere in the file without an ordering dependency.
//
// It shares `httpServer` with engine.io. socket.io's own `upgrade` listener
// ignores a path that is not `/socket.io/` and then ends the socket only if
// nothing was written to it; this handler writes its 101 synchronously, so both
// listeners run and each answers only its own path. See play/browser/index.ts.
//
// The gate is `CONFIG.minTier` — the same floor `requireMinTier` and both
// socket attaches enforce, re-applied a third time because an `upgrade` event
// runs no express middleware. No new tier, no anonymous path, no token.
const browserBridge = attachBrowserBridge(httpServer, {
	minTier: CONFIG.minTier,
	matches: () => play?.matches ?? null,
	// Dev-only, and checked against CONFIG inside — same hatch as play's.
	devIdentity: CONFIG.allowUnverifiedEdge && CONFIG.edgeAuthSecret === '',
});

// ── Streamed Forge, websocket half ───────────────────────────────────────────
// noVNC's RFB socket, proxied to the same containers. Inert unless STREAMS
// names containers, and the floor is re-applied at the upgrade because an
// `upgrade` runs no express middleware — the same two steps, in the same
// order, as the bridge above.
const streamHandle = attachStream(httpServer, {
	minTier: CONFIG.minTier,
	streamBasePort: STREAM_BASE_PORT,
	...STREAM_LAYOUT,
});
if (streamHandle !== null) {
	console.warn(
		`[cardtable] streamed Forge LIVE — ${STREAM_LAYOUT.streamCount} container(s) at /stream/** (interim form; see stream/index.ts)`,
	);
}

// ── Listen ───────────────────────────────────────────────────────────────────
httpServer.listen(CONFIG.port, CONFIG.host, () => {
	console.log(`[cardtable] listening on ${CONFIG.host}:${CONFIG.port}`);
	console.log(`[cardtable] tier floor: ${CONFIG.minTier}`);
	console.log(`[cardtable] browser bridge on ${browserBridge.path} (same floor, re-applied at the upgrade)`);
	if (poolLoad.ok) {
		console.log(`[cardtable] draft socket ready — ${poolLoad.detail}`);
	} else {
		// Same register as the bundle check: the server is up and one feature is
		// not, and saying which is what keeps "it just does nothing" from being
		// a state anyone has to debug from the outside.
		console.error(
			`[cardtable] NO CUBE POOL (${poolLoad.reason}): ${poolLoad.detail} — every draft join will answer unknown-draft`
		);
	}
	if (CONFIG.edgeAuthSecret === '') {
		console.warn(
			CONFIG.allowUnverifiedEdge
				? '[cardtable] EDGE_AUTH_SECRET unset and INSECURE_NO_EDGE_AUTH=1 — identity headers are TRUSTED UNVERIFIED. Local dev only.'
				: '[cardtable] EDGE_AUTH_SECRET unset — failing closed, every request degraded to public/anon.'
		);
	}
	if (!basePath.ok) {
		// Loud, because the alternative failure mode is a blank page nobody can
		// diagnose from the outside.
		console.error(`[cardtable] BUNDLE NOT SERVABLE (${basePath.reason}): ${basePath.detail}`);
	} else {
		console.log(`[cardtable] ${basePath.detail}`);
	}
});
