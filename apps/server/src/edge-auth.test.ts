import type { Request } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG } from './config.ts';
import { assertFloor, rankOf, sanitizeHeaders, vouchedOf } from './edge-auth.ts';

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

describe('X-Hadoku-Vouched is believed only behind edge auth', () => {
	const config = CONFIG as { -readonly [K in keyof typeof CONFIG]: (typeof CONFIG)[K] };
	const saved = { secret: config.edgeAuthSecret, hatch: config.allowUnverifiedEdge };
	afterEach(() => {
		config.edgeAuthSecret = saved.secret;
		config.allowUnverifiedEdge = saved.hatch;
	});
	const SECRET = 'edge-secret-for-the-vouched-test';
	const reqOf = (headers: Record<string, unknown>) => ({ headers }) as unknown as Request;

	it('strips a forged header from a direct hit with no edge auth', () => {
		config.edgeAuthSecret = SECRET;
		const headers: Record<string, unknown> = { 'x-user-id': 'u1', 'x-hadoku-vouched': '1' };
		sanitizeHeaders(headers);
		expect(headers['x-hadoku-vouched']).toBeUndefined();
		expect(vouchedOf(reqOf(headers))).toBe(false);
	});

	it('strips it when the edge auth is wrong', () => {
		config.edgeAuthSecret = SECRET;
		const headers: Record<string, unknown> = { 'x-edge-auth': 'nope', 'x-hadoku-vouched': '1' };
		sanitizeHeaders(headers);
		expect(vouchedOf(reqOf(headers))).toBe(false);
	});

	it('strips it when no secret is configured and the dev hatch is shut', () => {
		config.edgeAuthSecret = '';
		config.allowUnverifiedEdge = false;
		const headers: Record<string, unknown> = { 'x-hadoku-vouched': '1' };
		sanitizeHeaders(headers);
		expect(vouchedOf(reqOf(headers))).toBe(false);
	});

	it('keeps it behind a valid edge auth', () => {
		config.edgeAuthSecret = SECRET;
		const headers: Record<string, unknown> = { 'x-edge-auth': SECRET, 'x-hadoku-vouched': '1' };
		sanitizeHeaders(headers);
		expect(vouchedOf(reqOf(headers))).toBe(true);
	});

	it('reads anything but "1" as not vouched', () => {
		expect(vouchedOf(reqOf({}))).toBe(false);
		expect(vouchedOf(reqOf({ 'x-hadoku-vouched': 'true' }))).toBe(false);
	});

	it('leaves the local-dev hatch as it was: no vouch is granted', () => {
		config.edgeAuthSecret = '';
		config.allowUnverifiedEdge = true;
		const headers: Record<string, unknown> = {};
		sanitizeHeaders(headers);
		expect(headers['x-hadoku-tier']).toBe(config.devTier);
		expect(headers['x-user-id']).toBe('local-dev');
		expect(vouchedOf(reqOf(headers))).toBe(false);
	});
});
