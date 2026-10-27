import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { EMPTY_SHA, ReplayGuard, SKEW_MS, checkRequest, openFrame, privateKeyFrom, publicPemOf, sha256Hex, signFrame, signRequest } from './wire.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const T = 1_800_000_000_000;

const req = (headers: Record<string, string>, method = 'GET', path = '/status') => ({ method, path, headers });

describe('signed requests', () => {
	it('accepts the coordinator, once', () => {
		const guard = new ReplayGuard(() => T);
		const h = { ...signRequest(privateKey, 'GET', '/status', EMPTY_SHA, T) };
		expect(checkRequest(publicKey, guard, req(h), T)).toBeNull();
		expect(checkRequest(publicKey, guard, req(h), T + 1)).toBe('replayed signature');
	});

	it('refuses an unsigned request, as loopback CI would send it', () => {
		expect(checkRequest(publicKey, new ReplayGuard(), req({}), T)).toBe('stale or missing x-agent-ts');
		expect(checkRequest(publicKey, new ReplayGuard(), req({ 'x-agent-ts': String(T), 'x-agent-body': EMPTY_SHA }), T)).toBe('unsigned');
	});

	it('refuses a bad signature: another key, another path, another body, garbage', () => {
		const g = new ReplayGuard();
		expect(checkRequest(publicKey, g, req({ ...signRequest(other.privateKey, 'GET', '/status', EMPTY_SHA, T) }), T)).toBe('bad signature');
		expect(checkRequest(publicKey, g, req({ ...signRequest(privateKey, 'GET', '/status', EMPTY_SHA, T) }, 'POST', '/install'), T)).toBe('bad signature');
		const body = sha256Hex('{"kind":"jar"}');
		expect(checkRequest(publicKey, g, req({ ...signRequest(privateKey, 'GET', '/status', EMPTY_SHA, T), 'x-agent-body': body }), T)).toBe('bad signature');
		expect(checkRequest(publicKey, g, req({ 'x-agent-ts': String(T), 'x-agent-body': EMPTY_SHA, 'x-agent-sig': 'AAAA' }), T)).toBe('bad signature');
	});

	it('refuses a stale timestamp either side of the agent clock', () => {
		const g = new ReplayGuard();
		expect(checkRequest(publicKey, g, req({ ...signRequest(privateKey, 'GET', '/status', EMPTY_SHA, T - SKEW_MS - 1) }), T)).toBe('stale or missing x-agent-ts');
		expect(checkRequest(publicKey, g, req({ ...signRequest(privateKey, 'GET', '/status', EMPTY_SHA, T + SKEW_MS + 1) }), T)).toBe('stale or missing x-agent-ts');
		expect(checkRequest(publicKey, g, req({ ...signRequest(privateKey, 'GET', '/status', EMPTY_SHA, T - SKEW_MS + 1) }), T)).toBeNull();
	});

	it('forgets a signature only after it could no longer pass the skew check', () => {
		let now = T;
		const g = new ReplayGuard(() => now);
		const h = { ...signRequest(privateKey, 'GET', '/status', EMPTY_SHA, T) };
		expect(checkRequest(publicKey, g, req(h), now)).toBeNull();
		now = T + SKEW_MS;
		expect(checkRequest(publicKey, g, req(h), now)).toBe('replayed signature');
		now = T + 2 * SKEW_MS + 1;
		expect(checkRequest(publicKey, g, req(h), now)).toBe('stale or missing x-agent-ts');
	});
});

describe('relay frames', () => {
	const m = { op: 'line' as const, h: 'h1', line: '{"t":"start","match":"m1","config":{"a":"b\\n"}}' };

	it('open in order, in their own session only', () => {
		const f1 = signFrame(privateKey, 'nonce-a', 1, m);
		expect(openFrame(publicKey, 'nonce-a', 1, f1)).toEqual({ m });
		expect(openFrame(publicKey, 'nonce-a', 2, f1)).toEqual({ error: 'frame 1, expected 2' });
		expect(openFrame(publicKey, 'nonce-b', 1, f1)).toEqual({ error: 'bad frame signature' });
	});

	it('refuses a tampered body or another key', () => {
		const f = signFrame(privateKey, 'n', 1, m);
		expect(openFrame(publicKey, 'n', 1, f.replace('m1', 'm2'))).toEqual({ error: 'bad frame signature' });
		expect(openFrame(publicKey, 'n', 1, signFrame(other.privateKey, 'n', 1, m))).toEqual({ error: 'bad frame signature' });
		expect(openFrame(publicKey, 'n', 1, '{"m":{"op":"kill","h":"h1"}}')).toEqual({ error: 'malformed frame' });
	});
});

describe('keys', () => {
	it('reads a PEM or one line of base64 PKCS#8, and gives the public PEM the build embeds', () => {
		const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
		const der = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
		const fromPem = privateKeyFrom(pem);
		const fromDer = privateKeyFrom(der);
		expect(publicPemOf(fromPem)).toBe(publicPemOf(fromDer));
		expect(publicPemOf(fromPem)).toBe(publicKey.export({ type: 'spki', format: 'pem' }).toString());
	});
});
