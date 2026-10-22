/**
 * Runtime config for the Cardtable loopback-UI tunnel server.
 *
 * Every value is env-overridable so the PM2 wrapper (which pulls them from the
 * vault broker) can inject them without a code edit.
 */

import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// dist/config.js → package root (one dir up from dist/). Lets webDir resolve
// regardless of the process's working directory — PM2 starts us from the repo
// root, `pnpm start` from the package dir, and the two must agree.
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Resolve a configured path against the package root unless it is absolute. */
const resolveDir = (value: string): string =>
	isAbsolute(value) ? value : resolve(PKG_ROOT, value);

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
	 * This server's own service-tier key for the game-stats store, from the
	 * vault via the PM2 wrapper. Unset = match stats are off (logged once).
	 */
	statsServiceKey: process.env.CARDTABLE_SERVICE_KEY || '',

	/** The prefs mount the stats are reported to, without `/api/v1`. */
	statsBaseUrl: process.env.CARDTABLE_STATS_BASE_URL || 'https://hadoku.me/prefs',

	/** Structured access log destination (gitignored, created on boot). */
	logDir: resolveDir(process.env.CARDTABLE_LOG_DIR || 'logs'),

	/** `CARDTABLE_PLAY_PROBE=1`: the e2e harness's dev diagnostics — the scenario routes and the frame and stop traces. Never on in production. */
	playProbe: process.env.CARDTABLE_PLAY_PROBE === '1',

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
