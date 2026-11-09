import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import {
	TIER_ORDER,
	accountIdOf,
	assertFloor,
	callerIdOf,
	createEdgeAuth,
	isAdmin,
	rankOf,
	tierOf,
	userIdOf,
	userKeyOf,
	userNameFromHeaders,
	userNameOf,
	verifiedFromHeaders,
	verifiedOf,
} from './index.ts';

const reqOf = (headers: Record<string, unknown>) => ({ headers }) as unknown as Request;

describe('the full platform ladder', () => {
	it('is public < member < friend < service < wife < admin, complete', () => {
		expect(TIER_ORDER).toEqual(['public', 'member', 'friend', 'service', 'wife', 'admin']);
	});

	it('ranks every tier strictly above the one before it', () => {
		for (let i = 1; i < TIER_ORDER.length; i++) {
			expect(rankOf(TIER_ORDER[i])).toBeGreaterThan(rankOf(TIER_ORDER[i - 1]));
		}
	});

	it('ranks an unknown tier as public (rank 0), never higher', () => {
		expect(rankOf('nonsense')).toBe(rankOf('public'));
	});
});

describe('assertFloor', () => {
	it('accepts every tier this build knows (except public, by default)', () => {
		for (const tier of TIER_ORDER) {
			if (tier === 'public') continue;
			expect(assertFloor(tier, { envPrefix: 'GAME' })).toBe(tier);
		}
	});

	it('refuses an unknown tier, naming the app-supplied env prefix in the message', () => {
		expect(() => assertFloor('visitor', { envPrefix: 'GAME' })).toThrow(/^GAME_MIN_TIER=visitor is not a tier floor this build knows$/);
		expect(() => assertFloor('visitor', { envPrefix: 'BOMBERMAN' })).toThrow(/^BOMBERMAN_MIN_TIER=visitor/);
	});

	it('refuses public by default — an app that calls this at all wants a gate', () => {
		expect(() => assertFloor('public', { envPrefix: 'GAME' })).toThrow(/GAME_MIN_TIER=public/);
	});

	it('lets an app that chooses to opt in float at public', () => {
		expect(assertFloor('public', { envPrefix: 'GAME', allowPublic: true })).toBe('public');
	});
});

describe('createEdgeAuth: provenance is believed only behind the shared secret', () => {
	let secret = 'the-secret';
	let hatch = false;
	let devTier = 'member';
	const auth = createEdgeAuth({
		edgeAuthSecret: () => secret,
		allowUnverifiedEdge: () => hatch,
		devTier: () => devTier,
	});

	it('strips a forged header from a direct hit with no edge auth at all', () => {
		secret = 'the-secret';
		hatch = false;
		const headers: Record<string, unknown> = { 'x-user-id': 'u1', 'x-hadoku-verified': '1' };
		auth.sanitizeHeaders(headers);
		expect(headers['x-hadoku-tier']).toBe('public');
		expect(headers['x-user-id']).toBeUndefined();
		expect(headers['x-hadoku-verified']).toBeUndefined();
	});

	it('strips it when the edge auth is wrong', () => {
		secret = 'the-secret';
		const headers: Record<string, unknown> = { 'x-edge-auth': 'nope', 'x-hadoku-verified': '1' };
		auth.sanitizeHeaders(headers);
		expect(headers['x-hadoku-tier']).toBe('public');
	});

	it('keeps every header behind a valid edge auth', () => {
		secret = 'the-secret';
		const headers: Record<string, unknown> = { 'x-edge-auth': 'the-secret', 'x-hadoku-tier': 'friend', 'x-hadoku-verified': '1' };
		auth.sanitizeHeaders(headers);
		expect(headers).toMatchObject({ 'x-hadoku-tier': 'friend', 'x-hadoku-verified': '1' });
	});

	it('edgeSealed is true only behind a valid secret', () => {
		secret = 'the-secret';
		expect(auth.edgeSealed(reqOf({ 'x-edge-auth': 'the-secret' }))).toBe(true);
		expect(auth.edgeSealed(reqOf({ 'x-edge-auth': 'wrong' }))).toBe(false);
		expect(auth.edgeSealed(reqOf({}))).toBe(false);
	});

	it('with no secret configured and the dev hatch shut, degrades every request', () => {
		secret = '';
		hatch = false;
		const headers: Record<string, unknown> = { 'x-hadoku-tier': 'admin' };
		auth.sanitizeHeaders(headers);
		expect(headers['x-hadoku-tier']).toBe('public');
	});

	it('with no secret and the dev hatch open, grants the app-supplied dev tier to a header-less caller', () => {
		secret = '';
		hatch = true;
		devTier = 'friend';
		const headers: Record<string, unknown> = {};
		auth.sanitizeHeaders(headers);
		expect(headers['x-hadoku-tier']).toBe('friend');
		expect(headers['x-user-id']).toBe('local-dev');
		expect(headers['x-user-name']).toBe('local-dev');
	});

	it('with the hatch open, still believes a caller that already claims a tier', () => {
		secret = '';
		hatch = true;
		const headers: Record<string, unknown> = { 'x-hadoku-tier': 'admin' };
		auth.sanitizeHeaders(headers);
		expect(headers['x-hadoku-tier']).toBe('admin');
	});

	it('edgeProvenance middleware sanitizes req.headers in place and calls next', () => {
		secret = 'the-secret';
		hatch = false;
		let called = false;
		const req = reqOf({ 'x-hadoku-tier': 'admin' });
		auth.edgeProvenance(req, undefined as never, () => {
			called = true;
		});
		expect(called).toBe(true);
		expect(req.headers['x-hadoku-tier']).toBe('public');
	});
});

describe('tierOf: a verified member is promoted to friend, nobody else is touched', () => {
	it('promotes a verified member to friend', () => {
		expect(tierOf(reqOf({ 'x-hadoku-tier': 'member', 'x-hadoku-verified': '1' }))).toBe('friend');
	});

	it('leaves an unverified member as member', () => {
		expect(tierOf(reqOf({ 'x-hadoku-tier': 'member' }))).toBe('member');
	});

	it('promotes nobody but a member, and nobody past friend', () => {
		for (const tier of TIER_ORDER) {
			const want = tier === 'member' ? 'friend' : tier;
			expect(tierOf(reqOf({ 'x-hadoku-tier': tier, 'x-hadoku-verified': '1' })), tier).toBe(want);
		}
	});

	it('defaults to public when the header is absent or empty', () => {
		expect(tierOf(reqOf({}))).toBe('public');
		expect(tierOf(reqOf({ 'x-hadoku-tier': '' }))).toBe('public');
	});
});

describe('verifiedOf / verifiedFromHeaders', () => {
	it('is true only for the exact string "1"', () => {
		expect(verifiedOf(reqOf({ 'x-hadoku-verified': '1' }))).toBe(true);
		expect(verifiedOf(reqOf({ 'x-hadoku-verified': 'true' }))).toBe(false);
		expect(verifiedOf(reqOf({}))).toBe(false);
		expect(verifiedFromHeaders({ 'x-hadoku-verified': '1' })).toBe(true);
	});
});

describe('the header readers', () => {
	it('callerIdOf / accountIdOf read x-user-id, null when absent or empty', () => {
		expect(callerIdOf(reqOf({ 'x-user-id': 'u1' }))).toBe('u1');
		expect(callerIdOf(reqOf({}))).toBeNull();
		expect(accountIdOf(reqOf({ 'x-user-id': 'u1' }))).toBe('u1');
		expect(accountIdOf(reqOf({ 'x-user-id': '' }))).toBeNull();
	});

	it('userIdOf defaults to "anon"', () => {
		expect(userIdOf(reqOf({ 'x-user-id': 'u1' }))).toBe('u1');
		expect(userIdOf(reqOf({}))).toBe('anon');
	});

	it('userKeyOf reads x-user-key, null when absent', () => {
		expect(userKeyOf(reqOf({ 'x-user-key': 'k1' }))).toBe('k1');
		expect(userKeyOf(reqOf({}))).toBeNull();
	});

	it('userNameOf / userNameFromHeaders read x-user-name, null when absent', () => {
		expect(userNameOf(reqOf({ 'x-user-name': 'Ada' }))).toBe('Ada');
		expect(userNameOf(reqOf({}))).toBeNull();
		expect(userNameFromHeaders({ 'x-user-name': 'Ada' })).toBe('Ada');
	});

	it('reads a non-ASCII name the edge sent as UTF-8 bytes, which Node hands over as Latin-1', () => {
		const onTheWire = Buffer.from('ohmusama (王蟲様)', 'utf8').toString('latin1');
		expect(userNameFromHeaders({ 'x-user-name': onTheWire })).toBe('ohmusama (王蟲様)');
		expect(userNameFromHeaders({ 'x-user-name': Buffer.from('José', 'utf8').toString('latin1') })).toBe('José');
		// A lone Latin-1 byte is not UTF-8: kept as it came.
		expect(userNameFromHeaders({ 'x-user-name': 'Jos\xe9' })).toBe('Jos\xe9');
	});

	it('isAdmin is the one admin check: rankOf(tierOf(req)) >= rankOf("admin")', () => {
		expect(isAdmin(reqOf({ 'x-hadoku-tier': 'admin' }))).toBe(true);
		expect(isAdmin(reqOf({ 'x-hadoku-tier': 'wife' }))).toBe(false);
		// Even a verified member (promoted to friend) does not reach admin.
		expect(isAdmin(reqOf({ 'x-hadoku-tier': 'member', 'x-hadoku-verified': '1' }))).toBe(false);
	});
});
