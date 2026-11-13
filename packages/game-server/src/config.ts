/**
 * Runtime config for the Cardtable loopback-UI tunnel server.
 *
 * Every value is env-overridable so the PM2 wrapper (which pulls them from the
 * vault broker) can inject them without a code edit.
 */

import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The site's own directory (`apps/server`, whose `dist/` PM2 runs), whatever the process's working directory — PM2
 * starts us from the repo root, `pnpm start` from the package dir, and the two must agree. Bundled,
 * this module is part of `apps/server/dist/*.js`, so it is `dist/`'s parent; run as source (tests,
 * tsx) it is `packages/game-server/src/`, and the app it configures is `apps/server` beside it.
 */
export const APP_ROOT = basename(HERE) === 'dist' ? dirname(HERE) : resolve(HERE, '../../../apps/server');

/** Resolve a configured path against the package root unless it is absolute. */
const resolveDir = (value: string): string =>
	isAbsolute(value) ? value : resolve(APP_ROOT, value);

/**
 * Where the server keeps what it writes (`CARDTABLE_STATE_DIR`): rooms, drafts,
 * recordings and the rest of `data/` directly in it, and `logs/` beside them.
 * Outside the clone, so a deploy can build a new clone aside and swap it in
 * while this one serves. Unset (dev, tests, e2e) = the old in-clone layout,
 * `logs/` and `data/` in the package. `state-dir.ts` moves the in-clone copy
 * here on the first boot that has it.
 */
const STATE_DIR = process.env.CARDTABLE_STATE_DIR ? resolveDir(process.env.CARDTABLE_STATE_DIR) : '';
const LOG_DIR = resolveDir(process.env.CARDTABLE_LOG_DIR || (STATE_DIR ? join(STATE_DIR, 'logs') : 'logs'));
const DATA_DIR = STATE_DIR || resolve(LOG_DIR, '../data');

/** The in-clone paths a state dir replaces, for the boot move (`state-dir.ts`). */
export const LEGACY_STATE = { dataDir: resolve(APP_ROOT, 'data'), logDir: resolve(APP_ROOT, 'logs') } as const;

export const CONFIG = {
	/** Port this server listens on. cloudflared points the tunnel hostname here. */
	port: parseInt(process.env.CARDTABLE_PORT || '9008', 10),

	/**
	 * Loopback only. The tunnel is the single ingress; binding 0.0.0.0 would put
	 * this on the LAN with no gate in front of it, because the gate is at the edge.
	 */
	host: process.env.CARDTABLE_HOST || '127.0.0.1',

	/**
	 * The public prefix the BROWSER sees: hadoku.me/cardtable/…
	 *
	 * Edge-router stripPrefixes it before forwarding, so THIS process is served
	 * root paths — but every URL the built bundle emits must still carry the
	 * prefix, or the browser requests /assets/x.js instead of /cardtable/assets/x.js
	 * and the page loads blank. assertBasePath() checks that at boot.
	 */
	basePrefix: process.env.CARDTABLE_BASE_PREFIX || '/cardtable',

	/**
	 * The built SPA this server serves off local disk. There is no GitHub-Pages
	 * shell and no published micro-frontend bundle for a loopback-UI app — this
	 * directory IS the front end, and `pnpm build` in the child repo produces it.
	 */
	// `../ui/dist` because this repo splits the halves across workspace members:
	// apps/ui builds the SPA, apps/server hands it out. The PM2 wrapper passes an
	// absolute CARDTABLE_WEB_DIR in production; this default is what makes
	// `pnpm --filter @hadoku/server dev` work straight after `pnpm -r build`.
	webDir: resolveDir(process.env.CARDTABLE_WEB_DIR || '../ui/dist'),

	/**
	 * Tier floor enforced here as a SECOND seal, independent of route-tiers.ts.
	 *
	 * The edge gate is the real one, but it lives in another repo on another
	 * deploy cadence, and the tunnel hostname is reachable without it. A floor
	 * here means a route-tiers edit cannot silently widen this app on its own.
	 */
	minTier: process.env.CARDTABLE_MIN_TIER || 'friend',

	/**
	 * Shared secret edge-router stamps as X-Edge-Auth on everything it proxies
	 * (workers/shared/edgeAuth.ts). Identity headers are believed ONLY when this
	 * matches. Unset = FAIL CLOSED: every request is degraded to public/anon.
	 */
	edgeAuthSecret: process.env.EDGE_AUTH_SECRET || '',

	/**
	 * Bare-local dev escape hatch. With EDGE_AUTH_SECRET unset this server fails
	 * closed and strips tier/identity from every request, which locks a local
	 * browser out of its own app. Never set where the tunnel host is reachable.
	 */
	allowUnverifiedEdge: process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH === '1',

	/**
	 * Identity granted to a header-less caller while allowUnverifiedEdge is on.
	 * Defaults to the floor, so `pnpm dev` serves the app to a local browser
	 * instead of 404ing it. Read ONLY on that path — it grants nothing in
	 * production, where the hatch is off and provenance decides.
	 */
	devTier: process.env.CARDTABLE_DEV_TIER || process.env.CARDTABLE_MIN_TIER || 'friend',

	/**
	 * This server's own service-tier key for the game-stats store and for
	 * people's prefs rows, from the vault via the PM2 wrapper. Unset = match
	 * stats are off (logged once), and a music-review read or write is refused
	 * by prefs-api and answers 502.
	 */
	serviceKey: process.env.CARDTABLE_SERVICE_KEY || '',

	/**
	 * The prefs mount people's own rows are read and written on (`http/musicReviewStore.ts`),
	 * without `/api/v1`, with the same service key.
	 */
	prefsBaseUrl: process.env.CARDTABLE_PREFS_BASE_URL || 'https://hadoku.me/prefs',

	/**
	 * Where security telemetry is posted (`/health/api/telemetry` under it), with
	 * the same service key as the stats. Unset key = telemetry is off (logged once).
	 */
	monitoringBaseUrl: process.env.CARDTABLE_MONITORING_BASE_URL || 'https://hadoku.me',
	/** Watchparty's origin, whose sprites draw a member's character on a room's link preview (`http/preview.ts`). */
	watchpartyBaseUrl: process.env.CARDTABLE_WATCHPARTY_BASE_URL || 'https://hadoku.me/watchparty',

	/** Every user id this server has admitted, so `caller-first-seen` fires once per account. */
	callersSeenFile: process.env.CARDTABLE_CALLERS_SEEN_FILE ?? join(DATA_DIR, 'callers-seen.json'),

	/** The prefs mount the stats are reported to, without `/api/v1`. */
	statsBaseUrl: process.env.CARDTABLE_STATS_BASE_URL || 'https://hadoku.me/prefs',

	/**
	 * ArchiveBot's webhook secret for this app, from the vault via the PM2 wrapper. Prod's wrapper
	 * holds it and PPE's does not, which is what keeps release notes a prod-only post. Unset = the
	 * boot announcement is skipped (`announce.ts`).
	 */
	archivebotSecret: process.env.ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET || '',

	/** ArchiveBot's webhook server, on loopback beside this one. */
	archivebotUrl: process.env.CARDTABLE_ARCHIVEBOT_URL || 'http://127.0.0.1:3004',

	/** `CARDTABLE_STATE_DIR`, resolved; empty when unset (the in-clone layout). */
	stateDir: STATE_DIR,

	/** Structured access log destination (gitignored, created on boot). */
	logDir: LOG_DIR,

	/**
	 * The server's persisted state: the state dir itself when one is set, else
	 * `data/` beside the log directory. `data/` is gitignored, so a `git pull`
	 * deploy leaves it alone; e2e sets CARDTABLE_LOG_DIR and therefore gets its
	 * own directory rather than production's.
	 */
	dataDir: DATA_DIR,

	/** Every pod that played a round, kept past its room (`CARDTABLE_TOURNAMENTS_FILE`). */
	tournamentsFile: process.env.CARDTABLE_TOURNAMENTS_FILE ?? join(DATA_DIR, 'tournaments.json'),

	/** The front page's scheduled events (`CARDTABLE_EVENTS_FILE`). */
	eventsFile: process.env.CARDTABLE_EVENTS_FILE ?? join(DATA_DIR, 'events.json'),

	/** The lobby's rooms, one file each (`CARDTABLE_ROOMS_DIR`). */
	roomsDir: process.env.CARDTABLE_ROOMS_DIR ?? join(DATA_DIR, 'rooms'),

	/** The sound builder's uploads and assignments (`CARDTABLE_SOUNDS_DIR`). */
	soundsDir: process.env.CARDTABLE_SOUNDS_DIR ?? join(DATA_DIR, 'sounds'),

	/**
	 * How long a draft bot takes over a pick (`CARDTABLE_DRAFT_BOT_PICK_MS`): every
	 * bot holding a pack takes one card per turn. Long enough that bots do not
	 * drain a pod into the slowest human's pile at once, short enough that a
	 * quick drafter rarely waits on one.
	 */
	draftBotPickMs: parseInt(process.env.CARDTABLE_DRAFT_BOT_PICK_MS || '1200', 10),

	/**
	 * A CubeCobra draftbot service for the bots' picks (`room/draftbot.ts`), and its
	 * `X-Internal-Token`. Unset: no draftbot, every bot pick is the heuristic's.
	 */
	draftbotUrl: process.env.CARDTABLE_DRAFTBOT_URL || '',
	draftbotToken: process.env.CARDTABLE_DRAFTBOT_TOKEN || '',

	/** Each draft's state, so a pod survives a restart (`CARDTABLE_DRAFTS_DIR`). */
	draftsDir: process.env.CARDTABLE_DRAFTS_DIR ?? join(DATA_DIR, 'drafts'),

	/** A friend's Cube Cobra imports, flat `<id>.json` (`CARDTABLE_CUBES_DIR`). */
	cubesDir: process.env.CARDTABLE_CUBES_DIR ?? join(DATA_DIR, 'cubes'),

	/** Every match's action log and public stream (`play/recording/`, `CARDTABLE_RECORDINGS_DIR`). */
	recordingsDir: process.env.CARDTABLE_RECORDINGS_DIR ?? join(DATA_DIR, 'recordings'),

	/** Every game both players walked away from, kept to be resumed (`play/parked.ts`, `CARDTABLE_PARKED_DIR`). */
	parkedDir: process.env.CARDTABLE_PARKED_DIR ?? join(DATA_DIR, 'parked'),

	/** The card catalog the pools resolve against (`CARDTABLE_CATALOG`). */
	catalogPath: process.env.CARDTABLE_CATALOG ?? resolve(homedir(), '.local/share/cardtable/catalog/cards.json'),

	/** The art mirror's log (`upload-art`, `CARDTABLE_ART_MIRROR`): which CDN object holds each card image. Missing, every image is Scryfall's. */
	artMirrorPath: process.env.CARDTABLE_ART_MIRROR ?? resolve(homedir(), '.local/share/cardtable/art/mirror.jsonl'),

	/**
	 * `CARDTABLE_NEW_ROOM_FORMAT=newest` pins every new room to the newest
	 * Standard era instead of a random one: the e2e harnesses set it, because
	 * their specs read a fresh room's pool and a run must not depend on a draw.
	 */
	newRoomFormat: process.env.CARDTABLE_NEW_ROOM_FORMAT,

	/**
	 * Where Forge matches run (`CARDTABLE_PLAY_HOSTS`): `local`, this machine, as always (the
	 * default until the claw acceptance run passes), or `claws`, placed across the hosting claws'
	 * agents with this machine as the backstop (`play/placement/`). Anything else is `local`.
	 */
	playHosts: process.env.CARDTABLE_PLAY_HOSTS === 'claws' ? ('claws' as const) : ('local' as const),

	/**
	 * The hosting alerts' Discord webhook, from the vault via the PM2 wrapper
	 * (`.devvault.json`: `DISCORD_CARDTABLE_ALERT_WEBHOOK`). Unset = alerts are logged, not posted.
	 */
	alertWebhook: process.env.DISCORD_CARDTABLE_ALERT_WEBHOOK || '',

	/** How long, past the fencing window, the claws' agents hold their JVMs for the next server on a restart. */
	restartGraceMs: parseInt(process.env.CARDTABLE_PLAY_RESTART_GRACE_MS || '90000', 10),

	/** The operator's time-boxed force of hokon onto the Forge backstop: a JSON file `{"until":"<ISO>"}`. */
	backstopForceFile: process.env.CARDTABLE_BACKSTOP_FORCE_FILE ?? join(DATA_DIR, 'backstop-force.json'),

	/** `CARDTABLE_PLAY_PROBE=1`: the e2e harness's dev diagnostics — the scenario routes and the frame and stop traces. Never on in production. */
	playProbe: process.env.CARDTABLE_PLAY_PROBE === '1',

	/**
	 * `CARDTABLE_PLAY_REJOIN_GRACE_MS`: how long a match nobody is at waits before it is parked
	 * (`play/socket.ts`'s `PlayDeps.rejoinGraceMs`). Unset is play's own five minutes; a spec that
	 * parks a game sets it shorter. Never set by the deploy path.
	 */
	playRejoinGraceMs: process.env.CARDTABLE_PLAY_REJOIN_GRACE_MS === undefined ? undefined : parseInt(process.env.CARDTABLE_PLAY_REJOIN_GRACE_MS, 10),

	/**
	 * `CARDTABLE_E2E_UNCHECKED_POOLS=1`: the jar-less e2e stack's own escape
	 * hatch, wave 73 §A follow-up (CI `check` run 39715510788: a jar-less
	 * server can never pass a plan's verdict, so `Lobby.startDraft` refused
	 * `plan-not-ready` forever and `draft.spec`'s "two friends draft a whole
	 * pod" never dealt).
	 *
	 * With it, `room/plan.ts`'s `checkCards` answers OK for a source whose
	 * cards all resolved (`missingText` still refuses — this is an escape from
	 * "no jar", never from "no catalog text") instead of refusing with "Forge
	 * is not available". A source checked WITH a jar is unaffected either way:
	 * nothing here ever stands in for a real `forge.check`.
	 *
	 * Nothing in this repo's own deploy path (the PM2 wrapper, the vault
	 * broker) ever sets this — `config.test.ts` pins that a config built from
	 * a bare `process.env` (nothing set) reads `false`. `e2e/harness.ts` sets
	 * it on its OWN jar-less server only (never `e2e/play/harness.ts`'s,
	 * which has a real jar and keeps running the real check regardless of
	 * this flag). `index.ts` logs a boot warning whenever it reads true, the
	 * same register `EDGE_AUTH_SECRET`'s own dev hatch warns at.
	 */
	testUncheckedPools: process.env.CARDTABLE_E2E_UNCHECKED_POOLS === '1',

	/**
	 * `CARDTABLE_E2E_NO_RATE_LIMITS=1`: both e2e stacks' escape from the
	 * per-caller limits on making rooms, organizing events and starting matches
	 * (`http/request.ts`'s `perCallerLimit`). One test identity makes every room
	 * and starts every match of a whole run, far past any limit a person meets.
	 * Never set by the deploy path; `config.test.ts` pins it false from a bare
	 * environment, and `index.ts` warns at boot whenever it reads true.
	 */
	testNoRateLimits: process.env.CARDTABLE_E2E_NO_RATE_LIMITS === '1',

	/**
	 * `CARDTABLE_E2E_PEOPLE_STAND_IN=1`: look people up (`people.ts`) without a
	 * service key, from the e2e edge's prefs-api stand-in at `prefsBaseUrl`. The
	 * e2e stacks hold no key, which is what keeps match stats off there, and
	 * without this no spec could see a look. Never set by the deploy path.
	 */
	testPeopleStandIn: process.env.CARDTABLE_E2E_PEOPLE_STAND_IN === '1',

	/**
	 * `CARDTABLE_CATALOG_REFRESH`: on by default, so production needs no
	 * cross-repo change to keep its catalog current with Scryfall's daily
	 * bulk file (`pools/refresh.ts`, wave 74 §G). `index.ts` starts the job
	 * only when this reads `true`.
	 *
	 * Off (`'0'`) is for every server that is NOT production: CI's forge-e2e
	 * on the claws, every dev/e2e server a session boots, and a lane's own
	 * manual smoke-boot. Each of those would otherwise run `createCatalogRefresh`
	 * against `CARDTABLE_SCRYFALL_DIR ?? ~/.local/share/cardtable/scryfall` at
	 * its own boot — a real Scryfall download, every time, into land.sh's
	 * SHARED art cache when the default path is in play (`e2e/harness.ts` and
	 * `e2e/play/harness.ts` set this to `'0'` in the server env they spawn,
	 * for exactly this reason — one lane's `.partial` file there is what
	 * found this).
	 */
	catalogRefresh: process.env.CARDTABLE_CATALOG_REFRESH !== '0',

	/**
	 * `CARDTABLE_PLAY_SEED`: fixes Forge's shuffles, the coin toss and the precon
	 * pick for every match this server starts, or undefined (production) for an
	 * unseeded one. Read at each start, not at boot, so a test can set it.
	 */
	get playSeed(): number | undefined {
		const raw = process.env.CARDTABLE_PLAY_SEED;
		const seed = raw === undefined || raw === '' ? Number.NaN : Number(raw);
		return Number.isFinite(seed) ? seed : undefined;
	},

	/** Container n's noVNC port is this plus n (the static bench publishes 127.0.0.1:6080+n). */
	streamBasePort: Number(process.env.CARDTABLE_STREAM_PORT ?? 6080),

	/** The first host port a room's seat stream may take — see `stream/alloc.ts`. */
	roomStreamBasePort: Number(process.env.CARDTABLE_ROOM_STREAM_PORT ?? 6100),

	/** The name every room stream container this server owns starts with; `scripts/stream/container.sh` reads the same variable. */
	streamNamePrefix: process.env.CARDTABLE_STREAM_NAME_PREFIX ?? 'cardtable-room',
} as const;

/**
 * Where a Forge match's run directories go (`CARDTABLE_PLAY_WORK_DIR`). Takes the
 * environment as an argument, as `play/host.ts`'s `jvmHostConfig` does, so a test
 * can point one host at its own directory.
 */
export function playWorkDir(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.CARDTABLE_PLAY_WORK_DIR ?? join(tmpdir(), 'cardtable-play'));
}

export const INDEX_HTML = join(CONFIG.webDir, 'index.html');
