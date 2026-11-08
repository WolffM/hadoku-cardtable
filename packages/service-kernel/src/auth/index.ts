/**
 * Edge provenance and the tier floor — the platform's half.
 *
 * An edge-router style gateway resolves a caller's tier once and stamps every
 * request it proxies with a shared-secret header plus tier / user-id /
 * user-key / user-name / verified headers. A game's own tunnel host is
 * reachable DIRECTLY, bypassing that edge — so a direct hit could forge those
 * headers. We believe them only when the shared secret checks out; otherwise
 * we overwrite them with the most restrictive identity.
 *
 * Overwriting rather than deleting is deliberate: a handler that treats an
 * ABSENT tier as "bare local, trust it" would hand a direct caller the keys.
 * An explicit `public` cannot be read that way.
 *
 * Knows no game: every value below is either a pure header read or injected
 * by the app that binds this module (its edge-auth secret, its bare-local
 * dev hatch, its dev tier).
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { NextFunction, Request, Response } from 'express';

/**
 * The platform tier ladder, complete. `wife` sits above `service` and below
 * `admin` deliberately: full reach across the apps, none of the
 * credential-management surface. `member` is a self-signed-up account: a
 * passkey and a name, no key anyone handed out.
 */
export const TIER_ORDER = ['public', 'member', 'friend', 'service', 'wife', 'admin'] as const;
export type Tier = (typeof TIER_ORDER)[number];

export interface AssertFloorOptions {
	/** Named in the refusal message, e.g. `CARDTABLE` for `CARDTABLE_MIN_TIER=…`. */
	envPrefix: string;
	/**
	 * Let the app choose `public` as its own floor. Off by default: a floor an
	 * app never meant to be public should refuse to boot rather than silently
	 * admit everyone. Apps that are genuinely public (the next game might be)
	 * opt in explicitly.
	 */
	allowPublic?: boolean;
}

/**
 * The floor must be a tier this build knows. An unknown name ranks as public
 * in {@link rankOf}, so a floor this build has not heard of would silently
 * admit everyone, the direct tunnel hits included. Refusing to boot is the
 * only safe answer — and, unless the app opts in, `public` itself is refused
 * the same way, since an app that calls this at all is declaring it wants a
 * gate.
 */
export function assertFloor(tier: string, opts: AssertFloorOptions): Tier {
	const allowPublic = opts.allowPublic ?? false;
	if (!(TIER_ORDER as readonly string[]).includes(tier) || (!allowPublic && tier === 'public')) {
		throw new Error(`${opts.envPrefix}_MIN_TIER=${tier} is not a tier floor this build knows`);
	}
	return tier as Tier;
}

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

/**
 * The app's own edge-auth binding: its shared secret and its bare-local dev
 * hatch. Read live (as functions, not snapshotted values) so an app that
 * flips these at runtime — tests do — sees the new value on the very next
 * call, exactly as the single-process `CONFIG` object this used to read
 * directly always did.
 */
export interface EdgeAuthConfig {
	/** The shared secret this build believes `X-Edge-Auth` against. `''` = fail closed. */
	edgeAuthSecret(): string;
	/** The bare-local escape hatch: believe whatever tier a header-less caller claims. */
	allowUnverifiedEdge(): boolean;
	/** The tier granted a header-less caller while the hatch above is open. */
	devTier(): string;
}

export interface EdgeAuth {
	/** Force a public/anon identity unless edge provenance is proven. */
	sanitizeHeaders(headers: Record<string, unknown>): void;
	/**
	 * Did this request carry the edge's own seal? Not the bare-local hatch,
	 * which believes any header: a route only the edge may call asks this
	 * rather than a tier.
	 */
	edgeSealed(req: Request): boolean;
	/** Express middleware: sanitize provenance on every inbound request. */
	edgeProvenance(req: Request, res: Response, next: NextFunction): void;
}

/** Build the three functions that need the app's own edge-auth secret and dev hatch. */
export function createEdgeAuth(config: EdgeAuthConfig): EdgeAuth {
	function edgeProvenanceOk(headers: Record<string, unknown>): boolean {
		const got = headers['x-edge-auth'];
		const secret = config.edgeAuthSecret();
		return secret !== '' && typeof got === 'string' && ctEqual(got, secret);
	}

	function sanitizeHeaders(headers: Record<string, unknown>): void {
		if (config.edgeAuthSecret() === '') {
			if (config.allowUnverifiedEdge()) {
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
					headers['x-hadoku-tier'] = config.devTier();
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

	function edgeSealed(req: Request): boolean {
		return edgeProvenanceOk(req.headers as Record<string, unknown>);
	}

	function edgeProvenance(req: Request, _res: Response, next: NextFunction): void {
		sanitizeHeaders(req.headers as Record<string, unknown>);
		next();
	}

	return { sanitizeHeaders, edgeSealed, edgeProvenance };
}

/**
 * The caller's tier as the app's headers carry it, except that a verified
 * member IS a friend here: an app that admits members alongside the tiers it
 * hands out may choose to treat its own verification the same as a vouch.
 * Never above friend: admin stays admin's. Pure — only `sanitizeHeaders`
 * decides whether a header is trustworthy in the first place.
 */
export function tierOf(req: Request): string {
	const t = req.headers['x-hadoku-tier'];
	const tier = typeof t === 'string' && t !== '' ? t : 'public';
	return tier === 'member' && verifiedOf(req) ? 'friend' : tier;
}

/**
 * Is this caller verified (`X-Hadoku-Verified: 1`)? Absent means not
 * verified. Pure: trustworthiness is `sanitizeHeaders`'s job, done before this
 * is ever read.
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
 * unvouched request. A credential: never log it or store it. null when the
 * edge sent none.
 */
export function userKeyOf(req: Request): string | null {
	const k = req.headers['x-user-key'];
	return typeof k === 'string' && k !== '' ? k : null;
}

/**
 * The caller's registry userId (`X-User-Id`), edge-stamped and stripped from
 * an unvouched request. null when the edge sent none, never a stand-in word.
 */
export function accountIdOf(req: Request): string | null {
	const u = req.headers['x-user-id'];
	return typeof u === 'string' && u !== '' ? u : null;
}

/**
 * The caller's DISPLAY NAME, edge-injected beside `X-User-Id` (same trust
 * class: exclusively edge-set, stripped from unvouched requests). null when
 * the edge sent none — an unnamed key.
 */
export function userNameOf(req: Request): string | null {
	return userNameFromHeaders(req.headers);
}

/** `userNameOf` for a socket's handshake, whose headers went through the same sanitizing. */
export function userNameFromHeaders(headers: IncomingHttpHeaders): string | null {
	const n = headers['x-user-name'];
	return typeof n === 'string' && n !== '' ? n : null;
}

/** The one admin check: `rankOf(tierOf(req)) >= rankOf('admin')`. */
export function isAdmin(req: Request): boolean {
	return rankOf(tierOf(req)) >= rankOf('admin');
}
