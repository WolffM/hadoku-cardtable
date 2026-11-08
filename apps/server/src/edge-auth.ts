/**
 * Edge provenance and the tier floor — cardtable's binding of the platform
 * kernel (`@hadoku/service-kernel/auth`). The shared `createEdgeAuth`/`createGate`
 * instances live in `kernel.ts` (w93-Z); this file keeps every export's old
 * name and signature, so the rest of the app needs no edit.
 *
 * edge-router resolves the caller's tier once and stamps every request it
 * proxies with X-Edge-Auth: <EDGE_AUTH_SECRET> plus X-Hadoku-Tier / X-User-Id /
 * X-User-Key / X-User-Name / X-Hadoku-Verified. The tunnel hostname is reachable DIRECTLY,
 * bypassing the edge — so a direct hit could forge those headers. We believe
 * them only when the shared secret checks out; otherwise we overwrite them with
 * the most restrictive identity.
 */

import {
	TIER_ORDER,
	type Tier,
	assertFloor as kernelAssertFloor,
	rankOf,
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
import { CONFIG } from './config.js';
import { ENV_PREFIX, edgeAuth, gate } from './kernel.js';

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
	return kernelAssertFloor(tier, { envPrefix: ENV_PREFIX, allowPublic: false });
}
assertFloor(CONFIG.minTier);

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

/**
 * Express middleware: refuse anything below the configured floor.
 *
 * 404, not 403. A private app should not confirm its own existence to a caller
 * who was never meant to reach it — and a browser that somehow arrives here
 * unauthenticated gets the same answer as a scanner.
 */
export const requireMinTier = gate.requireMinTier;
