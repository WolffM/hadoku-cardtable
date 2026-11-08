/*
 * The frozen pin: cardtable's `serviceIdOf` fallback, and `/health`'s exact key
 * list — `{"status","service","commit","bundle","timestamp"}` today on PPE's ok
 * path, plus `commit_error`/`reason` on the degraded path. The generic logic
 * (readCommit, healthResponse's shape) is tested in `@hadoku/service-kernel`'s
 * own suite; this pins only what is cardtable's.
 */
import { describe, expect, it } from 'vitest';
import { healthResponse, serviceIdOf } from './health.ts';

describe('cardtable health v1', () => {
	it('names each instance by its child-apps id, falling back to cardtable when the prefix is empty', () => {
		expect(serviceIdOf('/cardtable')).toBe('cardtable');
		expect(serviceIdOf('/cardtable-ppe')).toBe('cardtable-ppe');
		expect(serviceIdOf('/cardtable-ppe/')).toBe('cardtable-ppe');
		expect(serviceIdOf('')).toBe('cardtable');
	});

	it('answers 200 ok with exactly {status, service, commit, bundle, timestamp}', () => {
		const now = new Date('2026-11-04T00:00:00Z');
		const { code, body } = healthResponse({ service: 'cardtable-ppe', commit: { commit: 'a'.repeat(40) }, bundle: { ok: true, reason: 'ok' } }, now);
		expect(code).toBe(200);
		expect(Object.keys(body).sort()).toEqual(['bundle', 'commit', 'service', 'status', 'timestamp']);
		expect(body).toEqual({ status: 'ok', service: 'cardtable-ppe', commit: 'a'.repeat(40), bundle: 'ok', timestamp: now.toISOString() });
	});

	it('answers 503 degraded with exactly {status, service, commit, commit_error, reason, bundle, timestamp}', () => {
		const { code, body } = healthResponse({ service: 'cardtable', commit: { commit: null, commit_error: 'no git' }, bundle: { ok: false, reason: 'unprefixed' } });
		expect(code).toBe(503);
		expect(Object.keys(body).sort()).toEqual(['bundle', 'commit', 'commit_error', 'reason', 'service', 'status', 'timestamp']);
		expect(body).toMatchObject({ status: 'degraded', service: 'cardtable', commit: null, commit_error: 'no git', bundle: 'unprefixed' });
		expect(body.reason).toContain('unprefixed');
	});
});
