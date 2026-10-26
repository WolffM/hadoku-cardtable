/**
 * Cardtable — loopback-UI tunnel server
 *
 * ## Where this sits
 *
 *   browser ──► hadoku.me/cardtable/*
 *            ──► edge-router          tier gate + stripPrefix '/cardtable'
 *            ──► tunnel hostname      cloudflared
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
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketIOServer } from 'socket.io';
import { podPickNumber } from '@hadoku/draft';
import { CONFIG, INDEX_HTML } from './config.js';
import { edgeProvenance, requireMinTier, tierOf, userIdOf } from './edge-auth.js';
import { checkBundle, diagnosticPage, isEmbedEntry, sendIndex } from './base-path.js';
import { announceRelease } from './announce.js';
import { restoreRooms, sweepRooms } from './boot.js';
import { DEFAULT_CUBE_ID, DEFAULT_PLAN, stateOf, type PoolSourceResolver } from './room/draftRooms.js';
import { checkCards, checkPlan } from './room/plan.js';
import type { DraftPlan, PoolVerdict, TableGame } from '@hadoku/shared';
import { busyHandler } from './busy.js';
import { draftEmitPolicy, emitDraftUpdate } from './room/emit.js';
import { attachDraftSocket } from './room/socket.js';
import { attachRoomFeed } from './room/feed.js';
import { attachPlay, jvmHostConfig, jvmHostFactory, roomDeckCosts, roomFormatNames, spellCopierLookup, tableGame, type PlayHandle } from './play/index.js';
import { attachStream, attachStreamRoutes, streamLayout } from './stream/index.js';
import { createRoomStreams, findContainerScript, scriptRunner, MAX_ROOM_SEATS } from './stream/alloc.js';
import { attachBrowserBridge } from './play/browser/index.js';
import { attachTables, loadTablesLibrary } from './http/index.js';
import { attachDecks } from './http/decks.js';
import { attachDrafts } from './http/drafts.js';
import { attachRooms } from './http/rooms.js';
import { attachTableActions } from './http/table-actions.js';
import { seedTestingRooms } from './room/testing-rooms.js';
import { attachTournaments } from './http/tournaments.js';
import { attachSounds } from './http/sounds.js';
import { attachTrim } from './http/trim.js';
import { attachCubeRoutes, createCubeStore } from './pools/cubes.js';
import { attachSetRoutes, createSetsStore, warmSetsStore } from './pools/sets.js';
import { attachPresetRoutes, createPresetStore } from './pools/presets.js';
import { createCatalogRefresh } from './pools/refresh.js';
import { loadCardCatalog } from './pools/catalog.js';
import { createForgePools, type ForgePools } from './pools/forge.js';
import { serveCover } from './cover.js';
import { newestFormat } from './room/lobby.js';
import { openTournaments } from './room/tournaments.js';
import { jsonLogger } from './log.js';
import { createKeyBook, createMatchStats, createStatsReporter } from './stats/index.js';
import { recordMatch } from '@wolffm/prefs-client/games';

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

// ── Busy (LOCAL ONLY: not a public route, and not a tier) ────────────────────
// hadoku_site's deploy asks this before it stops us, so a release waits for a live
// match instead of SIGKILLing it. The caller is the deploy runner on this host,
// which holds no session key — hence above the floor, like /health. It answers
// ONLY a genuinely local caller and is a bare 404 to everything else, so it does
// not become the anonymous tier the friend gate forbids. busy.ts has the why.
app.get(
	'/health/busy',
	busyHandler({
		matches: () => play?.matches.active() ?? [],
		drafts: () =>
			(draftRooms?.all() ?? []).map((r) => ({
				id: r.roomId,
				status: r.app.state?.status,
				packNumber: r.app.state?.packNumber,
				pickNumber: r.app.state === null ? undefined : podPickNumber(r.app.state),
			})),
	})
);

// ── The tier floor ───────────────────────────────────────────────────────────
// Everything below this line is gated. Register new public routes ABOVE it and
// say why in a comment — this line moving down is the shape of a privilege bug.
app.use(requireMinTier);

// ── API ──────────────────────────────────────────────────────────────────────
// Mount the app's own routes here. They arrive prefix-stripped, so a browser
// call to hadoku.me/cardtable/api/thing lands on `/api/thing`.
const api = express.Router();
api.use(express.json({ limit: '1mb' }));

// ── Match stats' keys ────────────────────────────────────────────────────────
// Every api request and every play-socket handshake leaves its player's key in
// an in-memory book (play is handed it below), so a finished room match can
// name BOTH players to the game-stats store by their own keys
// (the store resolves and discards them). The stats themselves are built once
// the table routes exist, below. See src/stats/.
const statsKeys = createKeyBook();
api.use(statsKeys.remember);

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
				else if (isEmbedEntry(filePath)) res.setHeader('Cache-Control', 'no-cache');
			},
		})
	);
}

// The game picker's tile in watchparty: our own drawing of card backs.
app.get('/cover', serveCover);

// The embed bundle watchparty imports (D21). Its two entry files keep their
// names across builds, so they revalidate (`no-cache`, answered 304 by ETag);
// their hashed chunks under `embed/assets/` stay immutable like every other
// asset. A path under `/embed/` that is not on disk is a 404, never the SPA
// page: an `import()` handed HTML fails with a MIME error that names nothing.
app.use('/embed', (_req: Request, res: Response) => {
	res.status(404).type('text').send('no such embed file');
});

// ── Streamed Forge, HTTP half ────────────────────────────────────────────────
// noVNC's pages and assets, straight out of websockify in the containers.
// MUST be above the SPA fallback: below it, /stream/0/vnc.html is answered
// with index.html and the link renders the cardtable app instead of noVNC —
// which is what happened to this route's bench predecessor on 2026-09-21.
// Inert unless ~/.local/share/cardtable/stream/STREAMS names containers; see
// stream/index.ts for the gate and the interim limits.
const STREAM_LAYOUT = streamLayout();

// ── Streamed Forge, the containers a ROOM owns ───────────────────────────────
// D19: the client is the ROOM's choice, made once at create. A room in
// `streamed` mode gets one container per seat, provisioned on first request
// and reclaimed when the room dies or nobody watches it for 30 minutes.
//
// It is built HERE, above the SPA fallback, because its HTTP half must be —
// and it closes over `lobby` and `draftRooms`, which are built further down.
// A closure, not a read: nothing below is called until a request arrives.
const CONTAINER_SCRIPT = findContainerScript();
if (CONTAINER_SCRIPT === null) {
	console.warn('[cardtable] no scripts/stream/container.sh — room-keyed streams are OFF (the static bench is unaffected)');
}
const streamLog = jsonLogger('cardtable-stream');
const roomStreams =
	CONTAINER_SCRIPT === null
		? null
		: createRoomStreams({
				// A lobby room or a draft pod. Neither has a delete path today
				// (see lobby.ts and draftRooms.ts), so this is the sweep's only
				// honest question: can anyone still reach this room?
				roomExists: (roomKey) => lobby.get(roomKey) !== undefined || draftRooms?.find(roomKey) !== undefined,
				script: scriptRunner(CONTAINER_SCRIPT),
				log: streamLog,
			});

/**
 * Seats to provision for a room, or null for a room that wants no containers.
 *
 * `clientMode` is the room's own, chosen at create and immutable after (D19,
 * `room/lobby.ts`). A builtin room never reaches this and never costs a
 * container, which is the whole point of the toggle.
 */
const streamedSeats = (roomKey: string): number | null => {
	const room = lobby.get(roomKey);
	if (room === undefined) return null;
	if (room.clientMode !== 'streamed') return null;
	const seats = room.gameType === 'draft' ? (draftRooms?.params.seatCount ?? MAX_ROOM_SEATS) : 2;
	return Math.min(seats, MAX_ROOM_SEATS);
};

// Fire-and-forget: a cold container is ~18 s to a usable window, so the
// request that triggered this is answered honestly ("not up yet") rather than
// held open for it. `allocate` is idempotent, so a reloading browser asks for
// the same room over and over without stacking containers.
const ensureRoomStreams = (roomKey: string): void => {
	if (roomStreams === null || roomStreams.find(roomKey) !== undefined) return;
	const seats = streamedSeats(roomKey);
	if (seats === null) return;
	void roomStreams.allocate(roomKey, seats).then((result) => {
		if (!result.ok) streamLog({ evt: 'stream-allocate-refused', room: roomKey, reason: result.reason, detail: result.detail });
	});
};

attachStreamRoutes(app, {
	minTier: CONFIG.minTier,
	streamBasePort: CONFIG.streamBasePort,
	...STREAM_LAYOUT,
	rooms: roomStreams,
	ensureRoom: ensureRoomStreams,
	log: streamLog,
});

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

// ── Rooms ───────────────────────────────────────────────────────────────────
// ── The library ──────────────────────────────────────────────────────────────
// Every catalogued era's frozen pool and every library deck, read once, here,
// before the server listens: ~16 MB of JSON parsed synchronously, which on a
// request path blocks every room, match and socket for most of a second. Both
// readers share this one copy — the lobby draws a new room's era from its
// `formats` (so a pool fixture that failed to parse, which lands in `faults`,
// is never a room's era), and `attachTables` serves it.
//
// `PKG_ROOT` is computed the way `config.ts` computes it, and it has to be:
// `dist/index.js` and `src/index.ts` are both exactly one directory below the
// package root, which is what makes one expression right for both the bundle
// and `tsx`. A module one level deeper could not do this.
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(PKG_ROOT, '../..');
const library = loadTablesLibrary(REPO_ROOT);

// ── Forge availability ───────────────────────────────────────────────────────
// Read once, here rather than down by `attachPlay` where it used to live:
// `createForgePools` (the draft pool service's own JVM, below) needs the same
// jar/res config `attachPlay`'s match JVMs do, and it is wired before
// `attachRooms` so `checkPlan` has a real `ForgePools` from the start.
const forge = jvmHostConfig();
if (!forge.ok) {
	console.warn(`[cardtable] play: no Forge (${forge.reason}) — POST /api/play/matches answers 503, and every draft plan is refused until one is`);
}

// The room list the front page shows, and the per-player state a table reads.
// Persisted, because this repo redeploys several times a day and an in-memory
// room would take its members and its password with it every time (`CONFIG.dataDir`).
//
// **Above the draft socket, and it has to be.** The socket's readiness gate is
// a lobby read: a `join` deals a pod only for a room whose draft the lobby says
// has started (wave 23, `room/socket.ts`), so `attachDraftSocket` takes the
// lobby as a required dep and cannot be wired before it exists.
//
// A new room opens on a random era (`randomFormat`) unless `CONFIG.newRoomFormat` pins it.
const newRoomFormat = CONFIG.newRoomFormat;
if (newRoomFormat !== undefined && newRoomFormat !== 'newest') {
	throw new Error(`CARDTABLE_NEW_ROOM_FORMAT must be 'newest' or unset, not ${JSON.stringify(newRoomFormat)}`);
}
const roomsLog = jsonLogger('cardtable-rooms');
// Every pod that played a round, kept past its room for the stats popout's Tournaments tab.
const tournaments = await openTournaments(
	CONFIG.tournamentsFile,
	roomsLog,
);
// ── Match stats ──────────────────────────────────────────────────────────────
// A finished room match is reported with this server's service key; without
// one, nothing is recorded. Its start is read from the room and the match at
// game over (`tables.matchStart`), so a match taken back after a restart is
// reported too. Built before the lobby, which reports every series result
// (`onSeriesEnd`) from its first sweep on; `tables` exists before any game ends.
const statsLog = jsonLogger('cardtable-stats');
const matchStats = createMatchStats({
	keys: statsKeys,
	log: statsLog,
	startOf: (match) => tables.matchStart(match),
	reporter: createStatsReporter({
		log: statsLog,
		record:
			CONFIG.statsServiceKey === ''
				? null
				: (report) => recordMatch({ gameId: 'cardtable', baseUrl: CONFIG.statsBaseUrl, serviceKey: CONFIG.statsServiceKey }, report),
	}),
});

// ── The draft room's cube pools: shortlist + imports + Forge playability ───
// Step 6 (wave73 §A): C's `CubeStore` and D's `ForgePools`, wired for real —
// this replaces the interim shortlist map/`CubeLookup` object steps 1-5 built
// here directly. Built before `attachRooms` below, which needs `checkPlan`
// for `PUT …/pod/plan`, and before `attachCubeRoutes`, which needs the store.
//
// `shortlistDir` is the committed, generated 8-cube list
// (`packages/carddata/src/cli/build-pool.ts --out-dir=`) — read-only, never
// `CARDTABLE_*`-overridden, because it ships with the bundle like any other
// asset. `importDir` (`CARDTABLE_CUBES_DIR`) is writable: a friend's Cube
// Cobra imports, flat `<id>.json`, alongside `CARDTABLE_ROOMS_DIR`'s
// `data/rooms` — lane B's e2e harness already sets this env var and expects
// it to be the import dir directly, not a parent of one.
const SHORTLIST_DIR = resolve(PKG_ROOT, 'pools/cubes');
const catalog = loadCardCatalog(CONFIG.catalogPath);
const cubeStore = createCubeStore({ shortlistDir: SHORTLIST_DIR, importDir: CONFIG.cubesDir, catalog });
if (cubeStore.list().length === 0) console.warn(`[cardtable] draft pool: no shortlist cubes loaded from ${SHORTLIST_DIR} — draft rooms are disabled`);

// The pool service's own long-lived JVM (`play/bridge/PoolService.java`),
// never the match bridge — a pool request can never stall a game. `null`
// without a configured Forge build, same gate `attachPlay`'s match host uses.
const forgePools: ForgePools | null = forge.ok
	? createForgePools(forge.config, jsonLogger('cardtable-pools'))
	: null;

// Every set Forge has a draft template for, plus each one's resolved card
// list (set-cube size) and name — `createSetsStore`'s own cache. Warmed in
// the background from here, never awaited: on a slow host it is tens of
// seconds of pool-JVM round-trips, and nothing optional may keep the server
// from listening. Started this early so `sets()` is the pool JVM's first
// call — every name is known from that one answer (`setsStore.onNamed`, wired
// to the lobby below), and a restored room's plan check asking for a set the
// warm-up is resolving shares its round-trip (`cardsFor`). Until then
// `poolResolver.name` shows the bare code, and `GET /api/pools/sets` waits
// for the warm-up it joins. `[]` without a jar, no warming to do.
const setsStore = createSetsStore({ forge: forgePools, catalog, log: jsonLogger('cardtable-pools') });
void warmSetsStore(setsStore);

const poolResolver: PoolSourceResolver = {
	cards(src) {
		if (src.kind === 'cube') return cubeStore.cards(src.cubeId) ?? [];
		// Both set styles answer with the SAME card list (`setsStore.cachedCards`,
		// the set's non-basic singletons) — `deal()` never calls this for a
		// realistic round (its packs come from `cacheRealisticRound`, wired by
		// `http/rooms.ts`'s `/start`) and `poolShortfall` already skips it, so
		// this is purely for `cubeMetaOf`'s wire-facing size: answering `[]`
		// here made `CubeMeta.size` 0, which fails `CubeMetaSchema`'s
		// `positive()` and rejects the browser's whole `state` message — the
		// production incident this line fixes. `cubeMetaOf` itself also never
		// forwards a non-positive size now, belt and suspenders.
		return setsStore.cachedCards(src.code) ?? [];
	},
	name(src) {
		if (src.kind === 'cube') return cubeStore.list().find((c) => c.id === src.cubeId)?.name ?? src.cubeId;
		return setsStore.nameOf(src.code) ?? src.code;
	},
};
const defaultCubeCards = cubeStore.cards(DEFAULT_CUBE_ID) ?? null;

// Without a jar, `room/plan.ts`'s own rule applies: every source not already
// checked at this pin is refused, with a reason. It never passes by default —
// unless CONFIG.testUncheckedPools (the jar-less e2e stack's own escape
// hatch; see config.ts's own doc). Warned at boot, grouped with the other
// boot warnings, below.
const checkDraftPlan = (plan: DraftPlan): Promise<PoolVerdict> =>
	checkPlan(plan, { cubes: cubeStore, sets: setsStore, forge: forgePools, uncheckedWithoutJar: CONFIG.testUncheckedPools });

// A disconnected drafter keeps their seat for DISCONNECT_GRACE_MS before it is
// vacated and held, so a browser refresh — whose old socket closes BEFORE the
// new one joins — is invisible to the rest of the pod instead of a seat that
// blinks `held` and back. Wave 10 measured that close-to-join gap at ~36 ms on
// loopback; five seconds covers a reload through the edge and a slow bundle
// fetch with room to spare, and delays announcing a genuine drop by an amount
// nobody waiting on a pick will notice. See draftRooms.ts's header.
const DISCONNECT_GRACE_MS = 5_000;
const draftPolicy = draftEmitPolicy(jsonLogger('cardtable-draft'));
// The rooms and drafts an earlier process left, read back and settled (`boot.ts`): a deploy
// mid-pod resumes it, a draft room whose draft did not come back goes back to its lobby, and the
// idle rooms are swept.
const { lobby, draftRooms } = await restoreRooms({
	lobby: {
		dir: CONFIG.roomsDir,
		formats: library.formats,
		...(newRoomFormat === 'newest' ? { defaultFormat: newestFormat(library.formats) } : {}),
		log: roomsLog,
		onTournament: (t) => tournaments.record(t),
		onSeriesEnd: (end) => matchStats.seriesEnd(end),
		// A room's plan checks itself in the background (new; restored with a null
		// verdict) — the same function PUT …/pod/plan runs. See lobby.ts's
		// OpenLobbyOptions.checkPlan and #ensurePlanChecked.
		checkPlan: checkDraftPlan,
	},
	drafts:
		cubeStore.list().length > 0
			? {
					resolver: poolResolver,
					defaultPlan: DEFAULT_PLAN,
					params: { disconnectGraceMs: DISCONNECT_GRACE_MS },
					// The grace ran out: the seat was vacated on a timer, with no socket
					// event to answer, so the broadcast is made here.
					onDeferredChange: (room) => emitDraftUpdate(io, room, draftPolicy),
					// Same convention as CARDTABLE_ROOMS_DIR/CARDTABLE_SOUNDS_DIR below: a
					// 45-minute draft must survive this process restarting on every push
					// to main. `storeDir`'s own doc on why the default is OFF rather than
					// computing this inline.
					storeDir: CONFIG.draftsDir,
				}
			: null,
	log: roomsLog,
});
// A plan name read before the set names warmed showed the bare code; every
// draft room is read again once they arrive. Wired before `listen`, so no
// view can have been served without this listener in place.
setsStore.onNamed(() => lobby.poolNamesChanged());
// The seeded, admin-only testing rooms (the operator: "set up some testing
// rooms for me … in a separate room section … admin only visible"). Idempotent
// by name (`seedTestingRooms`'s own doc), so calling it again — at boot, and
// after an admin closes one (`reseedTesting` below) — recreates only what is
// now missing. `newestSetCode` and `checkPlan` need the same `setsStore`/
// `checkDraftPlan` this file already built for `attachRooms` and
// `attachSetRoutes`; without a jar `setsStore.list()` answers `[]` and the
// set-draft room is skipped and logged, never created with no pool.
//
// Never awaited on the boot path, same discipline as `warmSetsStore` right
// above: the set-draft room's own check can be a slow pool-JVM round trip,
// and nothing optional may keep `httpServer.listen` waiting on it
// (`index.test.ts`'s own boot test: the server must listen with the pool JVM
// unresponsive). The four rooms that need no catalog are created within a
// tick either way — `Lobby.create` is synchronous — so the gap a request
// could race is only ever the fifth room.
//
// `library` (below) is what the two "round 2" tournament rooms need to seat
// a legal Classic deck before their lock — the call itself moves to AFTER
// `attachTables`, which is where `rooms.setPodChecks` actually wires the
// REAL `PodChecks.hasLegalSeatDeck` onto this same `lobby`; calling it here,
// at this line, would lock against `NO_POD_CHECKS`'s own always-`false`
// stub and never seat anyone.
const runTestingRoomSeed = (): Promise<void> =>
	seedTestingRooms({
		lobby,
		log: roomsLog,
		newestSetCode: async () => (await setsStore.list())[0]?.code ?? null,
		checkPlan: checkDraftPlan,
		library,
	});

attachRooms(api, {
	lobby,
	checkPlan: checkDraftPlan,
	closed: (roomId, matches) => {
		for (const id of matches) play?.matches.get(id)?.stop();
		// An unfinished draft has no deck to keep; a finished one stays on its drafters' Decks page.
		const draft = draftRooms?.find(roomId);
		if (draft !== undefined && stateOf(draft).status !== 'complete') draftRooms?.delete(roomId);
	},
	// "Reset = Close": the testing room `/:id/close` just forgot is recreated
	// fresh under the same name, the moment the close answers — not a
	// separate reset feature.
	reseedTesting: () => void runTestingRoomSeed(),
	// Each table's game for the table card: the decks its latest match was started with and, while it
	// runs, where it stands (`play/table-game.ts`). A finished match still answers for its decks.
	tableGames: (room) => {
		const games: Record<string, TableGame> = {};
		for (const table of room.tables) {
			const matchId = table.matchId ?? table.series.games.at(-1)?.matchId;
			const match = matchId === undefined ? undefined : play?.matches.get(matchId);
			if (match !== undefined) games[table.id] = tableGame(match, deckCosts);
		}
		return games;
	},
	// Wave 74 §E step 2: `POST …/start` fetches a realistic round's boosters
	// and caches them on `draftRooms` BEFORE `lobby.startDraft` ever runs, so
	// `draftRooms.open()` (the first socket `join`'s own call) stays
	// synchronous.
	realistic: {
		forge: forgePools,
		catalog,
		get draftRooms() {
			if (draftRooms === null) throw new Error('draftRooms is not wired — no shortlist cube loaded');
			return draftRooms;
		},
	},
});
attachTournaments(api, { tournaments });

// ── Sounds ───────────────────────────────────────────────────────────────────
// The sound-builder's catalogue, take audio, and assignment matrix. Same
// gitignored-`data/` reasoning as rooms above: a redeploy must not wipe an
// admin's assignments. No in-memory open step — `attachSounds` reads and
// writes the directory per request, same as `attachTables` reads `decks/`.
attachSounds(api, {
	dir: CONFIG.soundsDir,
});
attachTrim(api, { file: resolve(CONFIG.dataDir, 'trim.json') });

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
	// The default path. The browser asks for `/cardtable/socket.io/` and the
	// edge strips the prefix, so setting one here would break it — see
	// `apps/ui/src/draft/socket.ts`'s `socketPath`.
	serveClient: false,
});

attachDraftSocket(io, { rooms: draftRooms, lobby, minTier: CONFIG.minTier, botPickMs: CONFIG.draftBotPickMs });
// Every room write, pushed to the screens that have the room (or the list) open,
// so none of them reads it on a timer. Behind the gate attachDraftSocket installed.
const roomFeed = attachRoomFeed(io, { lobby });
// A table's game resolved from its card: concede, abandon, drop match (`http/table-actions.ts`).
attachTableActions(api, { lobby, match: (id) => play?.matches.get(id), seriesEnded: (roomId, tableId) => tables.seriesEnded(roomId, tableId) });

// ── Rooms are not immortal ───────────────────────────────────────────────────
// `create` had no opposite for its whole life: no leave, no close, no expiry,
// so every room ever made stayed on the front page. A room untouched for
// `ROOM_IDLE_MS` is forgotten, on disk as well as in memory — at boot, because
// this process restarts on every deploy and again at 08:00 UTC, and hourly so
// a long-running process is not the exception.
const ROOM_SWEEP_MS = 60 * 60_000;
setInterval(() => sweepRooms(lobby, roomsLog), ROOM_SWEEP_MS).unref();

// ── Constructed ──────────────────────────────────────────────────────────────
// Formats, the deck library, and the deck gate on POST /api/play/matches. MUST
// come before attachPlay: the gate is a handler on play's own path and runs
// only if it is registered first. See src/http/README.md.
// `matches` is read lazily: the gate binds each player to the seat their own
// deck is in, and play's registry does not exist until attachPlay below — which
// must stay after this call for the gate to answer first at all.
let play: PlayHandle | null = null;
const tables = attachTables(api, {
	library,
	draftRooms,
	rooms: lobby,
	matches: () => play?.matches ?? null,
});
// Now that `rooms.setPodChecks` above has wired the REAL `PodChecks` onto
// `lobby`, the seeded testing rooms can run: two of them (`testing-rooms.ts`'s
// `TESTING_CLASSIC_ROUND2_NAME`/`TESTING_GAUNTLET_ROUND2_NAME`) lock a
// tournament, which needs that wiring in place first (`runTestingRoomSeed`'s
// own doc, above). Never awaited, same discipline as `warmSetsStore`.
void runTestingRoomSeed();

// GET/PUT /api/drafts/:podId/{mine,deck} — a drafter's own pool and the
// build saved against it. Friend-gated like every other `/api` route, by
// the same `requireMinTier` above `api`.
attachDrafts(api, { draftRooms });

// GET/PATCH/DELETE /api/decks — every finished draft as the drafter's deck.
attachDecks(api, { draftRooms, room: (id) => lobby.get(id) });

// GET/POST/DELETE /api/pools/cubes — the cube picker's own data: the
// shortlist plus any Cube Cobra import. `check` re-verifies fresh at import
// and at refresh (never a cached verdict — "An import is checked when it is
// saved"), the same `checkCards` `room/plan.ts`'s own `checkSource` runs.
attachCubeRoutes(api, { store: cubeStore, check: (cards) => checkCards(cards, forgePools, { uncheckedWithoutJar: CONFIG.testUncheckedPools }) });

// GET /api/pools/sets — every set Forge can draft (ruling 8), newest first,
// each with its set-cube size and a cache-only verdict (wave 74 §E step 4).
attachSetRoutes(api, { store: setsStore });

// GET/POST/DELETE /api/pools/presets — G's named custom plans, shared with
// the group (wave 74 §G). `data/presets.json`, alongside `data/cubes`.
const presetStore = createPresetStore({ path: join(CONFIG.dataDir, 'presets.json') });
attachPresetRoutes(api, { store: presetStore });

// Keep the catalog current with Scryfall's daily bulk file, with no restart
// (wave 74 §G). `CARDTABLE_SCRYFALL_DIR`, same shared cache land.sh's art
// pipeline uses (`fdc3aaf5`) — never a lane's own fixture dir outside a test.
// `onSwap` is wave 74 §E's own half: a catalog swap can turn a `missingText`
// refusal into a pass, so every cached SET verdict refused for missing text
// is dropped (`pools/sets.ts`'s own cache; a cube's verdict lives in
// `cubeStore`, C's module, unowned and untouched this wave).
//
// `CONFIG.catalogRefresh` gates whether this starts AT ALL: on by default
// (production), off (`CARDTABLE_CATALOG_REFRESH=0`) for every server that
// is not production — every one of those would otherwise run a real
// Scryfall download at its own boot, into the shared cache when the
// default `scryfallDir` is in play. `e2e/harness.ts` and
// `e2e/play/harness.ts` set the flag off in the server env they spawn.
const SCRYFALL_DIR = process.env.CARDTABLE_SCRYFALL_DIR ?? resolve(homedir(), '.local/share/cardtable/scryfall');
const catalogRefresh = createCatalogRefresh({
	catalog,
	scryfallDir: SCRYFALL_DIR,
	catalogPath: CONFIG.catalogPath,
	onSwap: () => setsStore.clearMissingTextVerdicts(),
	log: jsonLogger('cardtable-pools'),
});
const stopCatalogRefresh = CONFIG.catalogRefresh ? catalogRefresh.start() : (): void => undefined;
if (!CONFIG.catalogRefresh) console.log('[cardtable] catalog refresh disabled (CARDTABLE_CATALOG_REFRESH=0)');

// ── Matches ──────────────────────────────────────────────────────────────────
// One child JVM per match; see src/play/README.md. Without a configured Forge
// build the route answers 503 and nothing else changes. `forge` itself is
// read once, up top (see its own header), because the draft pool service
// needs it before this point.
const deckCosts = roomDeckCosts(tables.library, defaultCubeCards);
play = attachPlay(io, api, {
	minTier: CONFIG.minTier,
	host: forge.ok ? jvmHostFactory(forge.config) : null,
	// Diagnostics for a live check only. Never set in production (see play/socket.ts).
	probe: CONFIG.playProbe,
	devIdentity: CONFIG.allowUnverifiedEdge && CONFIG.edgeAuthSecret === '',
	// Two listeners on one event: the stats report (`matchStats.gameOver`) and
	// the room's own series ledger, recorded AT ONCE rather than waiting for a
	// `/api/tables` read to notice the match is over (wave 72 §P step 1,
	// `http/routes.ts`'s `TablesHandle.gameOver`). `play/**` itself is
	// untouched — this is still the one hook it already exposed.
	onGameOver: (match) => {
		matchStats.gameOver(match);
		tables.gameOver(match);
	},
	keys: statsKeys,
	// A card-name ask offers the names of the room's pool (`play/names.ts`).
	// Not per-room (unlike a pod's own packs): these two are a static reference
	// set for autocomplete/costs across every constructed table, unrelated to
	// which cube a given pod drafted — the DEFAULT shortlisted cube serves that
	// same role the one bundled pool always did.
	formatNames: roomFormatNames(tables.library, defaultCubeCards),
	// A seat's own spell is held while it can play a card that copies it (`play/spell-copiers.ts`).
	...(forge.ok ? { spellCopiers: spellCopierLookup(forge.config.res, jsonLogger('cardtable-play')) } : {}),
	// A seat's face is its holder's avatar in the room that started the match.
	seatAvatar: tables.seatAvatar,
	// A seat's deck colours pick the match's music (`play/deck-colors.ts`).
	deckCosts,
	// A table's game moved on: its room's screens read the room again for the table card.
	liveChanged: (match) => {
		const room = lobby.roomOfMatch(match.id);
		if (room !== undefined) roomFeed.changed(room.id);
	},
});
// `attachPlay` has adopted every match an earlier server left running, so a
// room still pointing at one that did not come back can let go of it now.
tables.releaseGoneMatches();

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
	streamBasePort: CONFIG.streamBasePort,
	...STREAM_LAYOUT,
	rooms: roomStreams,
	ensureRoom: ensureRoomStreams,
	log: streamLog,
});
if (streamHandle !== null) {
	console.warn(
		`[cardtable] streamed Forge LIVE — ${STREAM_LAYOUT.streamCount} static container(s) at /stream/**${roomStreams === null ? '' : ', plus room-keyed streams at /stream/<room>/<seat>/'} (see stream/index.ts)`,
	);
}

// ── Reclaim ──────────────────────────────────────────────────────────────────
// Containers outlive this process, so the first thing a new one does is take
// back what the old one left; after that a room is reclaimed when it stops
// existing or when nobody has watched it for the idle window. One minute is
// far finer than the 30-minute window it enforces, and costs a `docker ps`.
const STREAM_SWEEP_MS = 60_000;
if (roomStreams !== null) {
	void roomStreams.sweepOrphans();
	setInterval(() => void roomStreams.sweep(), STREAM_SWEEP_MS).unref();
}

// ── Going down on purpose ────────────────────────────────────────────────────
// Until Wave 22 there was NO signal handler here at all, and that absence was
// the bug behind the operator's items #5 and #8. A deploy is: mgmt-api pulls,
// builds, and `pm2 restart cardtable`; pm2 sends SIGTERM; with no handler the
// default disposition killed this process outright, and `play/host.ts`'s exit
// hook SIGKILLed every match JVM on the way out. Every live game ended and
// every socket dropped, so the client's reconnect was answered
// `unknown-match`. The same thing happened at 08:00 UTC every night.
//
// What a deploy does now, in this order:
//
//   1. Start nothing new. `play.shutdown` refuses `POST /api/play/matches` with
//      a sentence rather than a 500, so a click during a deploy is not a bug.
//   2. Leave every live match RUNNING. Its JVM is detached with its transport
//      on disk (`host.ts`, "A match outlives its server"), and the next process
//      re-attaches and replays it. A match that CANNOT be left running has its
//      seats told so in words instead — the honest half of the same fix.
//   2a. And kill the JVM of every match we are NOT leaving running, before we
//      go. Lane U: a game that FINISHED during the run was neither handed over
//      nor stopped, and `{"t":"stop"}` takes ~9.3 s on a real match anyway, so
//      an `-Xmx1g` Forge JVM survived every restart. `host.ts`, "Going down".
//   3. Let the clients go: no new upgrades, existing sockets closed. The client
//      already survives a dropped socket; what it could not survive was the
//      match ceasing to exist.
//   4. Exit within `SHUTDOWN_DEADLINE_MS` no matter what. pm2 waits
//      `kill_timeout` (1.6 s by default) before SIGKILL, so a handler that can
//      hang buys nothing: the deadline is what makes the ordering above
//      reliable rather than hopeful.
//
// SIGINT gets the same treatment, for `pnpm dev` and for a ^C in a live check.
const SHUTDOWN_DEADLINE_MS = 5_000;
const SHUTDOWN_WORDS = 'The server is restarting for a deploy.';
let shuttingDown = false;

function shutdown(signal: string): void {
	// A second signal is pm2 being impatient, not a second shutdown.
	if (shuttingDown) return;
	shuttingDown = true;
	const startedAt = Date.now();
	const say = jsonLogger('cardtable');
	say({ evt: 'shutdown-begin', signal });

	// Spelled through `PlayHandle` rather than importing `ReapResult`: the barrel
	// `./play/index.js` is not this lane's to widen, and this is the same type.
	let outcome: ReturnType<PlayHandle['shutdown']> = { handed: [], ended: [], reaped: { killed: [], kept: [], left: [] } };
	try {
		outcome = play?.shutdown(SHUTDOWN_WORDS) ?? outcome;
	} catch (err) {
		// A match that will not let go must not stop the rest of the shutdown.
		say({ evt: 'shutdown-matches-failed', error: (err as Error).message });
	}
	say({ evt: 'shutdown-matches', handed: outcome.handed, ended: outcome.ended });
	// What is left of Forge. `killed` is the leak wave 22 lane U closed: a game
	// that finished during the run was neither handed over nor stopped, so its
	// `-Xmx1g` JVM sat there until the next boot swept it. `left` would be that
	// leak still happening and is the line to grep for if it ever comes back.
	say({ evt: 'shutdown-jvms', ...outcome.reaped });
	// The pool service's own JVM, separate from every match host above —
	// best-effort: the deadline below still bounds the whole shutdown even if
	// this never resolves.
	forgePools?.close().catch((err: unknown) => say({ evt: 'shutdown-pool-service-failed', error: (err as Error).message }));
	// Stops the 24 h timer; an in-flight run (if any) finishes on its own — `start()`'s own doc.
	stopCatalogRefresh();

	const finish = (why: string): void => {
		say({ evt: 'shutdown-done', signal, why, ms: Date.now() - startedAt, handed: outcome.handed.length, ended: outcome.ended.length });
		process.exit(0);
	};
	// Referenced on purpose: it is what holds the process up long enough for the
	// closes below, and what ends it if one of them never comes back.
	const deadline = setTimeout(() => finish('deadline'), SHUTDOWN_DEADLINE_MS);

	browserBridge.close();
	// `io.close` disconnects every socket AND closes the HTTP server it was given.
	io.close(() => {
		clearTimeout(deadline);
		finish('closed');
	});
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Listen ───────────────────────────────────────────────────────────────────
httpServer.listen(CONFIG.port, CONFIG.host, () => {
	console.log(`[cardtable] listening on ${CONFIG.host}:${CONFIG.port}`);
	console.log(`[cardtable] tier floor: ${CONFIG.minTier}`);
	console.log(`[cardtable] browser bridge on ${browserBridge.path} (same floor, re-applied at the upgrade)`);
	if (cubeStore.list().length > 0) {
		console.log(`[cardtable] draft socket ready — ${cubeStore.list().length} cube(s) in the store`);
	} else {
		// Same register as the bundle check: the server is up and one feature is
		// not, and saying which is what keeps "it just does nothing" from being
		// a state anyone has to debug from the outside.
		console.error(`[cardtable] NO CUBE SHORTLIST at ${SHORTLIST_DIR} — every draft join will answer unknown-draft`);
	}
	if (CONFIG.edgeAuthSecret === '') {
		console.warn(
			CONFIG.allowUnverifiedEdge
				? '[cardtable] EDGE_AUTH_SECRET unset and INSECURE_NO_EDGE_AUTH=1 — identity headers are TRUSTED UNVERIFIED. Local dev only.'
				: '[cardtable] EDGE_AUTH_SECRET unset — failing closed, every request degraded to public/anon.'
		);
	}
	if (CONFIG.testUncheckedPools) {
		console.warn('[cardtable] CARDTABLE_E2E_UNCHECKED_POOLS=1 — a plan with no jar passes unchecked (missingText still refuses). e2e/harness.ts only, never production.');
	}
	if (!basePath.ok) {
		// Loud, because the alternative failure mode is a blank page nobody can
		// diagnose from the outside.
		console.error(`[cardtable] BUNDLE NOT SERVABLE (${basePath.reason}): ${basePath.detail}`);
	} else {
		console.log(`[cardtable] ${basePath.detail}`);
	}
	void announceRelease({
		releasesDir: resolve(REPO_ROOT, 'docs/releases'),
		secret: CONFIG.archivebotSecret,
		archivebotUrl: CONFIG.archivebotUrl,
		appUrl: `https://hadoku.me${CONFIG.basePrefix}/`,
		log: jsonLogger('cardtable-release'),
	});
});
