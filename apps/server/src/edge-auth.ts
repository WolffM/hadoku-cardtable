/**
 * Edge provenance and the tier floor.
 *
 * edge-router resolves the caller's tier once and stamps every request it
 * proxies with X-Edge-Auth: <EDGE_AUTH_SECRET> plus X-Hadoku-Tier / X-User-Id /
 * X-User-Key / X-User-Name / X-Hadoku-Verified. The tunnel hostname is reachable DIRECTLY,
 * bypassing the edge — so a direct hit could forge those headers. We believe
 * them only when the shared secret checks out; otherwise we overwrite them with
 * the most restrictive identity.
 *
 * Overwriting rather than deleting is deliberate: a handler that treats an
 * ABSENT tier as "bare local, trust it" would hand a direct caller the keys.
 * An explicit `public` cannot be read that way.
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { CONFIG } from './config.js';
import { floor } from './gate.js';
import { reportSealRefused } from './telemetry.js';

/**
 * The platform tier ladder. Mirrors TIER_RANK in @wolffm/worker-utils — `wife`
 * sits above `service` and below `admin` deliberately: full reach across the
 * apps, none of the credential-management surface. `member` (2026-10-29) is a
 * self-signed-up account: a passkey and a name, no key anyone handed out.
 * Cardtable is the one app that admits them, as players exactly like friends.
 */
export const TIER_ORDER = ['public', 'member', 'friend', 'service', 'wife', 'admin'] as const;
export type Tier = (typeof TIER_ORDER)[number];

/**
 * The floor must be a tier this build knows, and never `public`. An unknown
 * name ranks as public in `rankOf`, so a floor this build has not heard of
 * (`CARDTABLE_MIN_TIER=member` on a build without `member`) would silently
 * admit everyone, the direct tunnel hits included. Refusing to boot is the
 * only safe answer.
 */
export function assertFloor(tier: string): Tier {
	if (!(TIER_ORDER as readonly string[]).includes(tier) || tier === 'public') {
		throw new Error(`CARDTABLE_MIN_TIER=${tier} is not a tier floor this build knows`);
	}
	return tier as Tier;
}
assertFloor(CONFIG.minTier);

export function rankOf(tier: string): number {
	const i = TIER_ORDER.indexOf(tier as Tier);
	// An unknown tier is not a high one. A future tier name this build has never
	// heard of must not out-rank the floor by accident.
	return i === -1 ? 0 : i;
}

/** Constant-time compare. Length is not secret (the token is fixed-length). */
function ctEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function edgeProvenanceOk(headers: Record<string, unknown>): boolean {
	const got = headers['x-edge-auth'];
	return (
		CONFIG.edgeAuthSecret !== '' && typeof got === 'string' && ctEqual(got, CONFIG.edgeAuthSecret)
	);
}

/** Force a public/anon identity unless edge provenance is proven. */
export function sanitizeHeaders(headers: Record<string, unknown>): void {
	if (CONFIG.edgeAuthSecret === '') {
		if (CONFIG.allowUnverifiedEdge) {
			// Explicit bare-local opt-out (warned at boot). Believe whatever tier
			// the caller claims — and, when it claims none, GRANT the dev tier
			// rather than leaving the header absent.
			//
			// That second half is the whole point. Without it the escape hatch does
			// not open anything: a browser at localhost sends no X-Hadoku-Tier, so
			// the floor below reads it as `public` and 404s every route including
			// the app's own index.html. The hatch would be a flag that changes
			// nothing observable, which is worse than not having one.
			if (typeof headers['x-hadoku-tier'] !== 'string' || headers['x-hadoku-tier'] === '') {
				headers['x-hadoku-tier'] = CONFIG.devTier;
				headers['x-user-id'] ??= 'local-dev';
				headers['x-user-name'] ??= 'local-dev';
			}
			return;
		}
		// else fall through: nothing can prove provenance → degrade every request
	} else if (edgeProvenanceOk(headers)) {
		return;
	}
	headers['x-hadoku-tier'] = 'public';
	// Content visibility is stamped by the edge from the user's prefs row, so it
	// is exactly as forgeable as the tier and gets pinned the same way. Level 1
	// is the platform's SFW floor.
	headers['x-hadoku-content-level'] = '1';
	delete headers['x-user-id'];
	delete headers['x-user-name'];
	delete headers['x-user-key'];
	delete headers['x-hadoku-verified'];
}

/**
 * Did this request carry the edge's own seal? Not the bare-local hatch, which
 * believes any header: a route only the edge may call (the account-erase hook)
 * asks this rather than a tier.
 */
export function edgeSealed(req: Request): boolean {
	return edgeProvenanceOk(req.headers as Record<string, unknown>);
}

/**
 * The caller's tier as cardtable treats it: the edge's `X-Hadoku-Tier`, except
 * that a member the operator verifies IS a friend here. The operator,
 * 2026-11-05: *"the only difference between vouched members and friends is the
 * auth gate on other websites. for cardtable they will be equivalent."* Every
 * gate reads this (the floor, the friend and admin checks, each socket's
 * handshake), so the equivalence lives in this one line. Never above friend:
 * admin stays admin's. Only after `sanitizeHeaders`, which strips a forged verification.
 */
export function tierOf(req: Request): string {
	const t = req.headers['x-hadoku-tier'];
	const tier = typeof t === 'string' && t !== '' ? t : 'public';
	return tier === 'member' && verifiedOf(req) ? 'friend' : tier;
}

/**
 * The operator verifies this caller (`X-Hadoku-Verified: 1`, stamped by the
 * edge from the same registry row as `X-User-Id`): every tier above member,
 * and a member the operator made or verified. Absent means not verified.
 */
export function verifiedOf(req: Request): boolean {
	return verifiedFromHeaders(req.headers);
}

/** `verifiedOf` for a socket's handshake, whose headers went through the same sanitizing. */
export function verifiedFromHeaders(headers: IncomingHttpHeaders): boolean {
	return headers['x-hadoku-verified'] === '1';
}

/** The caller's userId as the edge stamped it; null when the edge named nobody. */
export function callerIdOf(req: Request): string | null {
	const u = req.headers['x-user-id'];
	return typeof u === 'string' && u !== '' ? u : null;
}

export function userIdOf(req: Request): string {
	return callerIdOf(req) ?? 'anon';
}

/**
 * The caller's own live key (`X-User-Key`), edge-stamped and stripped from an
 * unvouched request. A credential: pass it to prefs-api to name the caller's
 * own row, never log it or store it. null when the edge sent none.
 */
export function userKeyOf(req: Request): string | null {
	const k = req.headers['x-user-key'];
	return typeof k === 'string' && k !== '' ? k : null;
}

/**
 * The caller's registry userId (`X-User-Id`), edge-stamped and stripped from an
 * unvouched request: what a saved room names a person by (R12). null when the
 * edge sent none, never a stand-in word.
 */
export function accountIdOf(req: Request): string | null {
	const u = req.headers['x-user-id'];
	return typeof u === 'string' && u !== '' ? u : null;
}

/**
 * The caller's DISPLAY NAME, edge-injected from the registry beside
 * `X-User-Id` (same trust class: exclusively edge-set, stripped from
 * unvouched requests). null when the edge sent none — an unnamed key.
 */
export function userNameOf(req: Request): string | null {
	return userNameFromHeaders(req.headers);
}

/** `userNameOf` for a socket's handshake, whose headers went through the same sanitizing. */
export function userNameFromHeaders(headers: IncomingHttpHeaders): string | null {
	const n = headers['x-user-name'];
	return typeof n === 'string' && n !== '' ? n : null;
}

/**
 * The one admin check: `rankOf(tierOf(req)) >= rankOf('admin')`. Used by
 * `http/sounds.ts`'s write gate and by the testing-room guard
 * (`http/rooms.ts`, `http/routes.ts`) — both read this rather than
 * re-deriving the comparison, so the ladder has exactly one place that knows
 * what "admin" means.
 */
export function isAdmin(req: Request): boolean {
	return rankOf(tierOf(req)) >= rankOf('admin');
}

/** Express middleware: sanitize provenance on every inbound request. */
export function edgeProvenance(req: Request, _res: Response, next: NextFunction): void {
	sanitizeHeaders(req.headers as Record<string, unknown>);
	next();
}

/**
 * Express middleware: refuse anything below the configured floor.
 *
 * 404, not 403. A private app should not confirm its own existence to a caller
 * who was never meant to reach it — and a browser that somehow arrives here
 * unauthenticated gets the same answer as a scanner.
 */
export function requireMinTier(req: Request, res: Response, next: NextFunction): void {
	if (floor(req.headers as Record<string, unknown>, CONFIG.minTier).ok) return next();
	reportSealRefused('http', req.headers, req.path);
	res.status(404).type('text/plain').send('not found');
}
