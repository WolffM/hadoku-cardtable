import type { Request, Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG } from './config.ts';
import { TIER_ORDER, type Tier, assertFloor, edgeProvenance, rankOf, requireMinTier, sanitizeHeaders, tierOf } from './edge-auth.ts';

describe('the tier floor', () => {
	it('admits a member above public and below friend', () => {
		expect(rankOf('member')).toBeGreaterThan(rankOf('public'));
		expect(rankOf('member')).toBeLessThan(rankOf('friend'));
	});

	it('admits a guest above public and below member', () => {
		expect(rankOf('guest')).toBeGreaterThan(rankOf('public'));
		expect(rankOf('guest')).toBeLessThan(rankOf('member'));
	});

	it('accepts guest, member and friend floors', () => {
		expect(assertFloor('guest')).toBe('guest');
		expect(assertFloor('member')).toBe('member');
		expect(assertFloor('friend')).toBe('friend');
	});

	it('refuses to boot on a floor it does not know, or on public', () => {
		// An unknown tier ranks as public, so such a floor would admit everyone.
		expect(() => assertFloor('visitor')).toThrow(/not a tier floor/);
		expect(() => assertFloor('public')).toThrow(/not a tier floor/);
	});

	it('pins the refusal message byte-identical: CARDTABLE_MIN_TIER, never the kernel\'s own generic wording', () => {
		// hadoku_site's wrapper sets CARDTABLE_MIN_TIER; a kernel refactor that
		// changes this text or the env name breaks that wrapper silently.
		expect(() => assertFloor('visitor')).toThrow('CARDTABLE_MIN_TIER=visitor is not a tier floor this build knows');
		expect(() => assertFloor('public')).toThrow('CARDTABLE_MIN_TIER=public is not a tier floor this build knows');
	});
});

// Nothing reads X-Hadoku-Verified (the tier says it), but the edge still sends it until every repo
// stops reading it, so a forged copy must still never survive an unproven request.
describe('a forged X-Hadoku-Verified never survives an unproven request', () => {
	const config = CONFIG as { -readonly [K in keyof typeof CONFIG]: (typeof CONFIG)[K] };
	const saved = { secret: config.edgeAuthSecret, hatch: config.allowUnverifiedEdge };
	afterEach(() => {
		config.edgeAuthSecret = saved.secret;
		config.allowUnverifiedEdge = saved.hatch;
	});
	const SECRET = 'edge-secret-for-the-verified-test';

	it('strips it from a direct hit with no edge auth', () => {
		config.edgeAuthSecret = SECRET;
		const headers: Record<string, unknown> = { 'x-user-id': 'u1', 'x-hadoku-verified': '1' };
		sanitizeHeaders(headers);
		expect(headers['x-hadoku-verified']).toBeUndefined();
	});

	it('strips it when the edge auth is wrong', () => {
		config.edgeAuthSecret = SECRET;
		const headers: Record<string, unknown> = { 'x-edge-auth': 'nope', 'x-hadoku-verified': '1' };
		sanitizeHeaders(headers);
		expect(headers['x-hadoku-verified']).toBeUndefined();
	});

	it('strips it when no secret is configured and the dev hatch is shut', () => {
		config.edgeAuthSecret = '';
		config.allowUnverifiedEdge = false;
		const headers: Record<string, unknown> = { 'x-hadoku-verified': '1' };
		sanitizeHeaders(headers);
		expect(headers['x-hadoku-verified']).toBeUndefined();
	});

	it('leaves the local-dev hatch as it was: no verification is granted', () => {
		config.edgeAuthSecret = '';
		config.allowUnverifiedEdge = true;
		const headers: Record<string, unknown> = {};
		sanitizeHeaders(headers);
		expect(headers['x-hadoku-tier']).toBe(config.devTier);
		expect(headers['x-user-id']).toBe('local-dev');
		expect(headers['x-hadoku-verified']).toBeUndefined();
	});
});

describe('a member (a guest the operator verified) is a friend here', () => {
	const config = CONFIG as { -readonly [K in keyof typeof CONFIG]: (typeof CONFIG)[K] };
	const saved = config.edgeAuthSecret;
	afterEach(() => {
		config.edgeAuthSecret = saved;
	});
	const SECRET = 'edge-secret-for-the-tier-test';
	const sanitized = (headers: Record<string, unknown>) => {
		config.edgeAuthSecret = SECRET;
		sanitizeHeaders(headers);
		return { headers } as unknown as Request;
	};

	it('reads a member as friend, with or without X-Hadoku-Verified', () => {
		expect(tierOf(sanitized({ 'x-edge-auth': SECRET, 'x-hadoku-tier': 'member' }))).toBe('friend');
		expect(tierOf(sanitized({ 'x-edge-auth': SECRET, 'x-hadoku-tier': 'member', 'x-hadoku-verified': '1' }))).toBe('friend');
	});

	it('never promotes a guest, with or without X-Hadoku-Verified', () => {
		expect(tierOf(sanitized({ 'x-edge-auth': SECRET, 'x-hadoku-tier': 'guest' }))).toBe('guest');
		expect(tierOf(sanitized({ 'x-edge-auth': SECRET, 'x-hadoku-tier': 'guest', 'x-hadoku-verified': '1' }))).toBe('guest');
	});

	it('promotes nobody but a member, and nobody past friend: every other tier stays as the edge said', () => {
		for (const tier of TIER_ORDER) {
			const want = tier === 'member' ? 'friend' : tier;
			expect(tierOf(sanitized({ 'x-edge-auth': SECRET, 'x-hadoku-tier': tier })), tier).toBe(want);
			expect(tierOf(sanitized({ 'x-edge-auth': SECRET, 'x-hadoku-tier': tier, 'x-hadoku-verified': '1' })), tier).toBe(want);
		}
	});

	it('reads nothing from the old header name: a guest who sends X-Hadoku-Vouched stays a guest', () => {
		expect(tierOf(sanitized({ 'x-edge-auth': SECRET, 'x-hadoku-tier': 'guest', 'x-hadoku-vouched': '1' }))).toBe('guest');
	});

	it('believes no tier a direct hit forged', () => {
		expect(tierOf(sanitized({ 'x-hadoku-tier': 'member', 'x-hadoku-verified': '1' }))).toBe('public');
	});
});

describe('the floor at friend admits a member', () => {
	const config = CONFIG as { -readonly [K in keyof typeof CONFIG]: (typeof CONFIG)[K] };
	const saved = { secret: config.edgeAuthSecret, floor: config.minTier };
	afterEach(() => {
		config.edgeAuthSecret = saved.secret;
		config.minTier = saved.floor;
	});
	const SECRET = 'edge-secret-for-the-floor-test';
	const passes = (headers: Record<string, unknown>): boolean => {
		config.edgeAuthSecret = SECRET;
		config.minTier = 'friend';
		const req = { headers, path: '/x' } as unknown as Request;
		edgeProvenance(req, {} as Response, () => undefined);
		let passed = false;
		const res = { status: () => res, type: () => res, send: () => res } as unknown as Response;
		requireMinTier(req, res, () => {
			passed = true;
		});
		return passed;
	};

	it('passes a member, refuses a guest (flag or not) and a forged member', () => {
		expect(passes({ 'x-edge-auth': SECRET, 'x-hadoku-tier': 'member' })).toBe(true);
		expect(passes({ 'x-edge-auth': SECRET, 'x-hadoku-tier': 'guest' })).toBe(false);
		expect(passes({ 'x-edge-auth': SECRET, 'x-hadoku-tier': 'guest', 'x-hadoku-verified': '1' })).toBe(false);
		expect(passes({ 'x-hadoku-tier': 'member', 'x-hadoku-verified': '1' })).toBe(false);
	});
});

describe('a guest gets what an unverified member got', () => {
	const config = CONFIG as { -readonly [K in keyof typeof CONFIG]: (typeof CONFIG)[K] };
	const saved = { secret: config.edgeAuthSecret, floor: config.minTier };
	afterEach(() => {
		config.edgeAuthSecret = saved.secret;
		config.minTier = saved.floor;
	});
	const SECRET = 'edge-secret-for-the-guest-test';
	const passesAt = (floor: Tier, headers: Record<string, unknown>): boolean => {
		config.edgeAuthSecret = SECRET;
		config.minTier = floor;
		const req = { headers, path: '/x' } as unknown as Request;
		edgeProvenance(req, {} as Response, () => undefined);
		let passed = false;
		const res = { status: () => res, type: () => res, send: () => res } as unknown as Response;
		requireMinTier(req, res, () => {
			passed = true;
		});
		return passed;
	};
	const guest = () => ({ 'x-edge-auth': SECRET, 'x-hadoku-tier': 'guest' });
	const member = () => ({ 'x-edge-auth': SECRET, 'x-hadoku-tier': 'member' });

	it('at the guest floor a guest and a member pass; public and a forged guest do not', () => {
		expect(passesAt('guest', guest())).toBe(true);
		expect(passesAt('guest', member())).toBe(true);
		expect(passesAt('guest', { 'x-edge-auth': SECRET, 'x-hadoku-tier': 'public' })).toBe(false);
		expect(passesAt('guest', { 'x-hadoku-tier': 'guest' })).toBe(false);
	});

	it('at the friend floor a guest is refused, and a verification flag does not lift it', () => {
		expect(passesAt('friend', guest())).toBe(false);
		expect(passesAt('friend', { ...guest(), 'x-hadoku-verified': '1' })).toBe(false);
	});

	it('a member floor refuses a guest: hadoku_site moves the floor and the edge together', () => {
		expect(passesAt('member', member())).toBe(true);
		expect(passesAt('member', guest())).toBe(false);
	});

	it('a guest is read as a guest, never promoted', () => {
		config.edgeAuthSecret = SECRET;
		const headers: Record<string, unknown> = { ...guest(), 'x-hadoku-verified': '1' };
		sanitizeHeaders(headers);
		expect(tierOf({ headers } as unknown as Request)).toBe('guest');
	});
});
