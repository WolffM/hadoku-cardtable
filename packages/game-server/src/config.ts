/**
 * Runtime config for a game-server app — the PLATFORM half (w119 §C).
 *
 * `createConfig` is a factory: every value it returns comes from the `env` object and `envPrefix`
 * it is called with (defaults: `process.env` and `'CARDTABLE'`), read when the factory RUNS, never
 * cached at this module's import. Two calls in one process, with different prefixes and/or
 * env objects, build two independent configs — which is what lets a second game on
 * `@hadoku/game-server` (bomberman) set its own `BOMBERMAN_*` variables instead of cardtable's.
 *
 * `export const CONFIG = createConfig()` below is cardtable's own instance, built the moment this
 * module is first imported — kept for every file that already does `import { CONFIG } from
 * '@hadoku/game-server/config'` and must keep working unchanged.
 *
 * What is NOT here any more: Magic-only settings (catalog, art mirror, draft bot, tournaments,
 * sounds, draft timing, the Forge-hosting envs, the room-stream envs) moved to
 * `games/magic/server/src/config.ts`'s `createMagicConfig`/`MAGIC_CONFIG` — a game with no Forge
 * engine has no business reading `CARDTABLE_DRAFT_BOT_PICK_MS`. Cardtable's deployment-only ArchiveBot
 * settings moved there too (not to `apps/server`): the only two readers,
 * `games/magic/server/src/plugins/{listen,routes}.ts`, are in the `magic` layer, which may not
 * import `apps/server` (the `site` layer) — see `scripts/layers/layers.json`'s allowed directions.
 * Survey: `~/.cache/cardtable-manager/bomberman-survey-2026-11-16.md` §3 has the classification
 * with the original line numbers.
 */

import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { assertFloor as kernelAssertFloor, type Tier } from '@hadoku/service-kernel/auth';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The site's own directory (`apps/server`, whose `dist/` PM2 runs), whatever the process's working directory — PM2
 * starts us from the repo root, `pnpm start` from the package dir, and the two must agree. Bundled,
 * this module is part of `apps/server/dist/*.js`, so it is `dist/`'s parent; run as source (tests,
 * tsx) it is `packages/game-server/src/`, and the app it configures is `apps/server` beside it.
 */
export const APP_ROOT = basename(HERE) === 'dist' ? dirname(HERE) : resolve(HERE, '../../../apps/server');

/** Resolve a configured path against the package root unless it is absolute. */
const resolveDir = (value: string): string => (isAbsolute(value) ? value : resolve(APP_ROOT, value));

/** The in-clone paths a state dir replaces, for the boot move (`state-dir.ts`). */
export const LEGACY_STATE = { dataDir: resolve(APP_ROOT, 'data'), logDir: resolve(APP_ROOT, 'logs') } as const;

export interface CreateConfigOptions {
	/** Every env var this factory reads is `<envPrefix>_<NAME>`. Default `'CARDTABLE'`. */
	envPrefix?: string;
	/** The environment to read. Default `process.env` — override to build a second config in one process (a test, or a second game). */
	env?: NodeJS.ProcessEnv;
}

export interface GameServerConfig {
	/** Port this server listens on. cloudflared points the tunnel hostname here. */
	readonly port: number;
	/**
	 * Loopback only. The tunnel is the single ingress; binding 0.0.0.0 would put
	 * this on the LAN with no gate in front of it, because the gate is at the edge.
	 */
	readonly host: string;
	/**
	 * The public prefix the BROWSER sees: hadoku.me/cardtable/…
	 *
	 * Edge-router stripPrefixes it before forwarding, so THIS process is served
	 * root paths — but every URL the built bundle emits must still carry the
	 * prefix, or the browser requests /assets/x.js instead of /cardtable/assets/x.js
	 * and the page loads blank. assertBasePath() checks that at boot.
	 */
	readonly basePrefix: string;
	/**
	 * The built SPA this server serves off local disk. There is no GitHub-Pages
	 * shell and no published micro-frontend bundle for a loopback-UI app — this
	 * directory IS the front end, and `pnpm build` in the child repo produces it.
	 */
	readonly webDir: string;
	/**
	 * Tier floor enforced here as a SECOND seal, independent of route-tiers.ts.
	 *
	 * The edge gate is the real one, but it lives in another repo on another
	 * deploy cadence, and the tunnel hostname is reachable without it. A floor
	 * here means a route-tiers edit cannot silently widen this app on its own.
	 *
	 * Validated at factory-call time (`kernelAssertFloor`, moved here from
	 * `edge-auth.ts`'s former import-time self-check, w119 §C.4): a floor this
	 * build does not know, or `public`, throws out of `createConfig` itself —
	 * fails closed exactly as before, just at the one deterministic place that
	 * builds the config, not as a side effect of any file happening to import
	 * `edge-auth.ts`.
	 */
	readonly minTier: Tier;
	/**
	 * Shared secret edge-router stamps as X-Edge-Auth on everything it proxies
	 * (workers/shared/edgeAuth.ts). Identity headers are believed ONLY when this
	 * matches. Unset = FAIL CLOSED: every request is degraded to public/anon.
	 *
	 * Not prefixed: `EDGE_AUTH_SECRET` is the edge's own shared secret, common to
	 * every app behind it, never per-game.
	 */
	readonly edgeAuthSecret: string;
	/**
	 * Bare-local dev escape hatch. With EDGE_AUTH_SECRET unset this server fails
	 * closed and strips tier/identity from every request, which locks a local
	 * browser out of its own app. Never set where the tunnel host is reachable.
	 */
	readonly allowUnverifiedEdge: boolean;
	/**
	 * Identity granted to a header-less caller while allowUnverifiedEdge is on.
	 * Defaults to the floor, so `pnpm dev` serves the app to a local browser
	 * instead of 404ing it. Read ONLY on that path — it grants nothing in
	 * production, where the hatch is off and provenance decides.
	 */
	readonly devTier: string;
	/**
	 * This server's own service-tier key for the game-stats store and for
	 * people's prefs rows, from the vault via the PM2 wrapper. Unset = match
	 * stats are off (logged once), and a music-review read or write is refused
	 * by prefs-api and answers 502.
	 */
	readonly serviceKey: string;
	/** The prefs mount people's own rows are read and written on, without `/api/v1`, with the same service key. */
	readonly prefsBaseUrl: string;
	/** Where security telemetry is posted (`/health/api/telemetry` under it), with the same service key as the stats. Unset key = telemetry is off (logged once). */
	readonly monitoringBaseUrl: string;
	/** Watchparty's origin, whose sprites draw a member's character on a room's link preview. */
	readonly watchpartyBaseUrl: string;
	/** Every user id this server has admitted, so `caller-first-seen` fires once per account. */
	readonly callersSeenFile: string;
	/** The prefs mount the stats are reported to, without `/api/v1`. */
	readonly statsBaseUrl: string;
	/** The resolved state dir; empty when unset (the in-clone layout). */
	readonly stateDir: string;
	/** Structured access log destination (gitignored, created on boot). */
	readonly logDir: string;
	/**
	 * The server's persisted state: the state dir itself when one is set, else
	 * `data/` beside the log directory. `data/` is gitignored, so a `git pull`
	 * deploy leaves it alone; e2e sets the log dir var and therefore gets its
	 * own directory rather than production's.
	 */
	readonly dataDir: string;
	/** The front page's scheduled events — a generic room-list feature, not Magic's own. */
	readonly eventsFile: string;
	/** The lobby's rooms, one file each. */
	readonly roomsDir: string;
	/** The hosting alerts' Discord webhook, from the vault via the PM2 wrapper. Unset = alerts are logged, not posted. */
	readonly alertWebhook: string;
	/** The operator's time-boxed force of the backstop host onto the Forge backstop: a JSON file `{"until":"<ISO>"}`. */
	readonly backstopForceFile: string;
	/**
	 * Both e2e stacks' escape from the per-caller limits on making rooms, organizing events and
	 * starting matches (`http/request.ts`'s `perCallerLimit`). Never set by the deploy path.
	 */
	readonly testNoRateLimits: boolean;
	/**
	 * Look people up without a service key, from the e2e edge's prefs-api stand-in. Never set by
	 * the deploy path.
	 */
	readonly testPeopleStandIn: boolean;
}

/** Everything a game-server app needs that is not specific to any one game (w119 §C). */
export function createConfig(options: CreateConfigOptions = {}): GameServerConfig {
	const prefix = options.envPrefix ?? 'CARDTABLE';
	const env = options.env ?? process.env;
	const read = (name: string): string | undefined => env[`${prefix}_${name}`];

	const stateDirRaw = read('STATE_DIR');
	const stateDir = stateDirRaw ? resolveDir(stateDirRaw) : '';
	const logDir = resolveDir(read('LOG_DIR') || (stateDir ? join(stateDir, 'logs') : 'logs'));
	const dataDir = stateDir || resolve(logDir, '../data');

	const minTierRaw = read('MIN_TIER') || 'friend';
	const minTier = kernelAssertFloor(minTierRaw, { envPrefix: prefix, allowPublic: false });

	return {
		port: parseInt(read('PORT') || '9008', 10),
		host: read('HOST') || '127.0.0.1',
		basePrefix: read('BASE_PREFIX') || '/cardtable',
		// `../ui/dist` because this repo splits the halves across workspace members: apps/ui builds
		// the SPA, apps/server hands it out. The PM2 wrapper passes an absolute WEB_DIR in
		// production; this default is what makes `pnpm --filter @hadoku/server dev` work straight
		// after `pnpm -r build`.
		webDir: resolveDir(read('WEB_DIR') || '../ui/dist'),
		minTier,
		edgeAuthSecret: env.EDGE_AUTH_SECRET || '',
		allowUnverifiedEdge: read('INSECURE_NO_EDGE_AUTH') === '1',
		devTier: read('DEV_TIER') || minTierRaw,
		serviceKey: read('SERVICE_KEY') || '',
		prefsBaseUrl: read('PREFS_BASE_URL') || 'https://hadoku.me/prefs',
		monitoringBaseUrl: read('MONITORING_BASE_URL') || 'https://hadoku.me',
		watchpartyBaseUrl: read('WATCHPARTY_BASE_URL') || 'https://hadoku.me/watchparty',
		callersSeenFile: read('CALLERS_SEEN_FILE') ?? join(dataDir, 'callers-seen.json'),
		statsBaseUrl: read('STATS_BASE_URL') || 'https://hadoku.me/prefs',
		stateDir,
		logDir,
		dataDir,
		eventsFile: read('EVENTS_FILE') ?? join(dataDir, 'events.json'),
		roomsDir: read('ROOMS_DIR') ?? join(dataDir, 'rooms'),
		alertWebhook: env[`DISCORD_${prefix}_ALERT_WEBHOOK`] || '',
		backstopForceFile: read('BACKSTOP_FORCE_FILE') ?? join(dataDir, 'backstop-force.json'),
		testNoRateLimits: read('E2E_NO_RATE_LIMITS') === '1',
		testPeopleStandIn: read('E2E_PEOPLE_STAND_IN') === '1',
	};
}

/**
 * Cardtable's own instance, built once at this module's first import (every existing
 * `import { CONFIG } from '@hadoku/game-server/config'` keeps working unchanged). Not `as const`:
 * several test suites (`edge-auth.test.ts`) cast this to a mutable mapped type and swap individual
 * fields for a case, then restore them — that only works on a plain object, which this is.
 */
export const CONFIG = createConfig();

/**
 * Where a Forge match's run directories go (`CARDTABLE_PLAY_WORK_DIR`). Takes the
 * environment as an argument, as `play/host.ts`'s `jvmHostConfig` does, so a test
 * can point one host at its own directory.
 *
 * Stays here rather than moving to Magic's config (w119 §C survey calls this Forge-match specific)
 * because `play/local-jvm.ts` — out of this lane's ownership — imports it directly from this
 * module; moving it would break that file's import with no file in this wave's briefs allowed to
 * fix it. `local-jvm.ts` itself is written generic over "any JVM-hosted engine", so this is
 * defensible as the local JVM launcher's own platform-level default, not only Forge's.
 */
export function playWorkDir(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.CARDTABLE_PLAY_WORK_DIR ?? join(tmpdir(), 'cardtable-play'));
}

export const INDEX_HTML = join(CONFIG.webDir, 'index.html');
