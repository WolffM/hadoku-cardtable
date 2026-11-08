/**
 * Edge provenance and the tier floor — cardtable's binding of the platform
 * kernel (`@hadoku/service-kernel/auth`).
 *
 * edge-router resolves the caller's tier once and stamps every request it
 * proxies with X-Edge-Auth: <EDGE_AUTH_SECRET> plus X-Hadoku-Tier / X-User-Id /
 * X-User-Key / X-User-Name / X-Hadoku-Verified. The tunnel hostname is reachable DIRECTLY,
 * bypassing the edge — so a direct hit could forge those headers. We believe
 * them only when the shared secret checks out; otherwise we overwrite them with
 * the most restrictive identity.
 *
 * Every export below keeps its old name and signature; cardtable's values
 * (the `CARDTABLE_MIN_TIER` env name, refusing a `public` floor, `CONFIG`'s
 * live fields) are bound here, once, so the rest of the app needs no edit.
 */

import {
	TIER_ORDER,
	type Tier,
	assertFloor as kernelAssertFloor,
	rankOf,
	createEdgeAuth,
	tierOf,
	verifiedOf,
	verifiedFromHeaders,
	callerIdOf,
	userIdOf,
	userKeyOf,
	accountIdOf,
	userNameOf,
	userNameFromHeaders,
	isAdmin,
} from '@hadoku/service-kernel/auth';
import { createGate, type SealRefusedReporter } from '@hadoku/service-kernel/http';
import { CONFIG } from './config.js';
import { reportSealRefused } from './telemetry.js';

export { TIER_ORDER, rankOf, tierOf, verifiedOf, verifiedFromHeaders, callerIdOf, userIdOf, userKeyOf, accountIdOf, userNameOf, userNameFromHeaders, isAdmin };
export type { Tier };

/**
 * The floor must be a tier this build knows, and never `public` here —
 * cardtable admits members and friends, never the public tier. An unknown
 * name ranks as public in `rankOf`, so a floor this build has not heard of
 * (`CARDTABLE_MIN_TIER=member` on a build without `member`) would silently
 * admit everyone, the direct tunnel hits included. Refusing to boot is the
 * only safe answer.
 */
export function assertFloor(tier: string): Tier {
	return kernelAssertFloor(tier, { envPrefix: 'CARDTABLE', allowPublic: false });
}
assertFloor(CONFIG.minTier);

const edgeAuth = createEdgeAuth({
	edgeAuthSecret: () => CONFIG.edgeAuthSecret,
	allowUnverifiedEdge: () => CONFIG.allowUnverifiedEdge,
	devTier: () => CONFIG.devTier,
});

/** Force a public/anon identity unless edge provenance is proven. */
export const sanitizeHeaders = edgeAuth.sanitizeHeaders;

/**
 * Did this request carry the edge's own seal? Not the bare-local hatch, which
 * believes any header: a route only the edge may call (the account-erase hook)
 * asks this rather than a tier.
 */
export const edgeSealed = edgeAuth.edgeSealed;

/** Express middleware: sanitize provenance on every inbound request. */
export const edgeProvenance = edgeAuth.edgeProvenance;

const gate = createGate({
	sanitizeHeaders,
	edgeProvenance,
	tierOf,
	rankOf,
	// `reportSealRefused`'s own surface type is cardtable's closed set
	// (`telemetry.ts`); the kernel's is an open `string` so it knows no game's
	// surface names. Every surface this gate ever reports is in that set.
	reportSealRefused: reportSealRefused as SealRefusedReporter,
	minTier: () => CONFIG.minTier,
});

/**
 * Express middleware: refuse anything below the configured floor.
 *
 * 404, not 403. A private app should not confirm its own existence to a caller
 * who was never meant to reach it — and a browser that somehow arrives here
 * unauthenticated gets the same answer as a scanner.
 */
export const requireMinTier = gate.requireMinTier;
