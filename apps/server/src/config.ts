/**
 * Runtime config for the Cardtable loopback-UI tunnel server.
 *
 * Every value is env-overridable so the PM2 wrapper (which pulls them from the
 * vault broker) can inject them without a code edit.
 */

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
	/** Port this server listens on. cloudflared points cardtable.hadoku.me here. */
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

	/** Structured access log destination (gitignored, created on boot). */
	logDir: resolveDir(process.env.CARDTABLE_LOG_DIR || 'logs'),
} as const;

export const INDEX_HTML = join(CONFIG.webDir, 'index.html');
