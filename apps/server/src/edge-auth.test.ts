import type { Request, Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG } from './config.ts';
import { TIER_ORDER, assertFloor, edgeProvenance, rankOf, requireMinTier, sanitizeHeaders, tierOf, verifiedOf } from './edge-auth.ts';

describe('the tier floor', () => {
	it('admits a member above public and below friend', () => {
		expect(rankOf('member')).toBeGreaterThan(rankOf('public'));
		expect(rankOf('member')).toBeLessThan(rankOf('friend'));
	});

	it('accepts member and friend floors', () => {
		expect(assertFloor('member')).toBe('member');
		expect(assertFloor('friend')).toBe('friend');
	});

	it('refuses to boot on a floor it does not know, or on public', () => {
		// An unknown tier ranks as public, so such a floor would admit everyone.
		expect(() => assertFloor('visitor')).toThrow(/not a tier floor/);
		expect(() => assertFloor('public')).toThrow(/not a tier floor/);
	});
});

describe('X-Hadoku-Verified is believed only behind edge auth', () => {
	const config = CONFIG as { -readonly [K in keyof typeof CONFIG]: (typeof CONFIG)[K] };
	const saved = { secret: config.edgeAuthSecret, hatch: config.allowUnverifiedEdge };
	afterEach(() => {
		config.edgeAuthSecret = saved.secret;
		config.allowUnverifiedEdge = saved.hatch;
	});
	const SECRET = 'edge-secret-for-the-verified-test';
	const reqOf = (headers: Record<string, unknown>) => ({ headers }) as unknown as Request;

	it('strips a forged header from a direct hit with no edge auth', () => {
		config.edgeAuthSecret = SECRET;
		const headers: Record<string, unknown> = { 'x-user-id': 'u1', 'x-hadoku-verified': '1' };
		sanitizeHeaders(headers);
		expect(headers['x-hadoku-verified']).toBeUndefined();
		expect(verifiedOf(reqOf(headers))).toBe(false);
	});

	it('strips it when the edge auth is wrong', () => {
		config.edgeAuthSecret = SECRET;
		const headers: Record<string, unknown> = { 'x-edge-auth': 'nope', 'x-hadoku-verified': '1' };
		sanitizeHeaders(headers);
		expect(verifiedOf(reqOf(headers))).toBe(false);
	});

	it('strips it when no secret is configured and the dev hatch is shut', () => {
		config.edgeAuthSecret = '';
		config.allowUnverifiedEdge = false;
		const headers: Record<string, unknown> = { 'x-hadoku-verified': '1' };
		sanitizeHeaders(headers);
		expect(verifiedOf(reqOf(headers))).toBe(false);
	});

	it('keeps it behind a valid edge auth', () => {
		config.edgeAuthSecret = SECRET;
		const headers: Record<string, unknown> = { 'x-edge-auth': SECRET, 'x-hadoku-verified': '1' };
		sanitizeHeaders(headers);
		expect(verifiedOf(reqOf(headers))).toBe(true);
	});

	it('reads anything but "1" as not verified', () => {
		expect(verifiedOf(reqOf({}))).toBe(false);
		expect(verifiedOf(reqOf({ 'x-hadoku-verified': 'true' }))).toBe(false);
	});

	it('leaves the local-dev hatch as it was: no verification is granted', () => {
		config.edgeAuthSecret = '';
		config.allowUnverifiedEdge = true;
		const headers: Record<string, unknown> = {};
		sanitizeHeaders(headers);
		expect(headers['x-hadoku-tier']).toBe(config.devTier);
		expect(headers['x-user-id']).toBe('local-dev');
		expect(verifiedOf(reqOf(headers))).toBe(false);
	});
});

describe('a verified member is a friend here', () => {
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

	it('reads a verified member as friend, a plain member as member', () => {
		expect(tierOf(sanitized({ 'x-edge-auth': SECRET, 'x-hadoku-tier': 'member', 'x-hadoku-verified': '1' }))).toBe('friend');
		expect(tierOf(sanitized({ 'x-edge-auth': SECRET, 'x-hadoku-tier': 'member' }))).toBe('member');
	});

	it('promotes nobody but a member, and nobody past friend: every other tier stays as the edge said', () => {
		for (const tier of TIER_ORDER) {
			const want = tier === 'member' ? 'friend' : tier;
			expect(tierOf(sanitized({ 'x-edge-auth': SECRET, 'x-hadoku-tier': tier, 'x-hadoku-verified': '1' })), tier).toBe(want);
		}
	});

	it('reads nothing from the old header name: the edge no longer strips X-Hadoku-Vouched, so a member who sends it stays a member', () => {
		expect(tierOf(sanitized({ 'x-edge-auth': SECRET, 'x-hadoku-tier': 'member', 'x-hadoku-vouched': '1' }))).toBe('member');
	});

	it('believes no verification a direct hit forged', () => {
		expect(tierOf(sanitized({ 'x-hadoku-tier': 'member', 'x-hadoku-verified': '1' }))).toBe('public');
	});
});

describe('the floor at friend admits a verified member', () => {
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

	it('passes a verified member, refuses a plain one and a forged verification', () => {
		expect(passes({ 'x-edge-auth': SECRET, 'x-hadoku-tier': 'member', 'x-hadoku-verified': '1' })).toBe(true);
		expect(passes({ 'x-edge-auth': SECRET, 'x-hadoku-tier': 'member' })).toBe(false);
		expect(passes({ 'x-hadoku-tier': 'member', 'x-hadoku-verified': '1' })).toBe(false);
	});
});
