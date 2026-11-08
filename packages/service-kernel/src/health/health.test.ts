import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { healthResponse, readCommit, serviceIdOf } from './health.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('hadoku health v1', () => {
	it('names each instance by its child-apps id, falling back to the app id when the prefix is empty', () => {
		expect(serviceIdOf('/cardtable', 'cardtable')).toBe('cardtable');
		expect(serviceIdOf('/cardtable-ppe', 'cardtable')).toBe('cardtable-ppe');
		expect(serviceIdOf('/cardtable-ppe/', 'cardtable')).toBe('cardtable-ppe');
		expect(serviceIdOf('', 'bomberman')).toBe('bomberman');
		expect(serviceIdOf('///', 'bomberman')).toBe('bomberman');
	});

	it('reads the checkout HEAD it is given', () => {
		expect(readCommit(REPO_ROOT)).toEqual({ commit: execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() });
	});

	it('reports null and why when there is no checkout, never a made-up sha', () => {
		const dir = mkdtempSync(join(tmpdir(), 'service-kernel-no-git-'));
		try {
			const got = readCommit(dir);
			expect(got.commit).toBeNull();
			expect(got.commit_error).toMatch(/rev-parse HEAD .* failed/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('answers 200 ok with service and commit while the bundle is servable', () => {
		const now = new Date('2026-11-04T00:00:00Z');
		expect(healthResponse({ service: 'some-app-ppe', commit: { commit: 'a'.repeat(40) }, bundle: { ok: true, reason: 'ok' } }, now)).toEqual({
			code: 200,
			body: { status: 'ok', service: 'some-app-ppe', commit: 'a'.repeat(40), bundle: 'ok', timestamp: now.toISOString() },
		});
	});

	it('answers 503 degraded with a reason when the bundle is not, and carries commit_error', () => {
		const { code, body } = healthResponse({ service: 'some-app', commit: { commit: null, commit_error: 'no git' }, bundle: { ok: false, reason: 'unprefixed' } });
		expect(code).toBe(503);
		expect(body).toMatchObject({ status: 'degraded', service: 'some-app', commit: null, commit_error: 'no git', bundle: 'unprefixed' });
		expect(body.reason).toContain('unprefixed');
	});
});
