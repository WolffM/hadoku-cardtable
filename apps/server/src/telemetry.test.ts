import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { perCallerLimit } from './http/request.js';
import { firstSeen, installTelemetry, monitoringSink, reportSealRefused, type TelemetryContext } from './telemetry.js';

type Posted = {
	url: string;
	headers: Record<string, string>;
	body: { level: string; message: string; context: Record<string, unknown> };
};

function fakeFetch(status = 200): { fetch: typeof fetch; posts: Posted[] } {
	const posts: Posted[] = [];
	const f = (async (url: string, init: RequestInit) => {
		posts.push({
			url,
			headers: init.headers as Record<string, string>,
			body: JSON.parse(String(init.body)),
		});
		return new Response(null, { status });
	}) as unknown as typeof fetch;
	return { fetch: f, posts };
}

function recorder(): { events: [string, TelemetryContext][] } {
	const events: [string, TelemetryContext][] = [];
	installTelemetry((event, context) => events.push([event, context]));
	return { events };
}

function req(headers: Record<string, string>, path = '/api/rooms'): Request {
	return { headers, path } as unknown as Request;
}

afterEach(() => installTelemetry(() => {}));

describe('monitoringSink', () => {
	it('posts one event per caller per window and carries the suppressed count on the next', async () => {
		let t = 0;
		const { fetch, posts } = fakeFetch();
		const sink = monitoringSink({
			baseUrl: 'https://hadoku.me',
			serviceKey: 'k',
			log: () => {},
			fetch,
			now: () => t,
		});
		sink('rate-limited', { userId: '3f2b8c1e-5d4a-4e7b-9a10-6c2d8e4f1a01', act: 'room-create' });
		sink('rate-limited', { userId: '3f2b8c1e-5d4a-4e7b-9a10-6c2d8e4f1a01', act: 'room-create' });
		sink('rate-limited', { userId: '3f2b8c1e-5d4a-4e7b-9a10-6c2d8e4f1a01', act: 'room-create' });
		sink('rate-limited', { userId: '8d0e4a7c-2b19-4f63-b8d5-1e9a6c3b7f02', act: 'room-create' });
		t = 60_000;
		sink('rate-limited', { userId: '3f2b8c1e-5d4a-4e7b-9a10-6c2d8e4f1a01', act: 'room-create' });

		expect(posts.map((p) => [p.body.context.userId, p.body.context.suppressed])).toEqual([
			['3f2b8c1e-5d4a-4e7b-9a10-6c2d8e4f1a01', undefined],
			['8d0e4a7c-2b19-4f63-b8d5-1e9a6c3b7f02', undefined],
			['3f2b8c1e-5d4a-4e7b-9a10-6c2d8e4f1a01', 2],
		]);
		expect(posts[0].url).toBe('https://hadoku.me/health/api/telemetry');
		expect(posts[0].headers['X-User-Key']).toBe('k');
		expect(posts[0].body).toMatchObject({
			level: 'warn',
			message: 'event=rate-limited',
			context: { service: 'cardtable', act: 'room-create' },
		});
	});

	it('posts nothing without a service key, and says so once', () => {
		const logged: Record<string, unknown>[] = [];
		const { fetch, posts } = fakeFetch();
		const sink = monitoringSink({
			baseUrl: 'https://hadoku.me',
			serviceKey: '',
			log: (e) => logged.push(e),
			fetch,
		});
		sink('caller-first-seen', { userId: '3f2b8c1e-5d4a-4e7b-9a10-6c2d8e4f1a01' });
		expect(posts).toEqual([]);
		expect(logged).toEqual([{ evt: 'telemetry-disabled', reason: 'CARDTABLE_SERVICE_KEY is not set' }]);
	});

	it('logs a refused post instead of dropping it silently', async () => {
		const logged: Record<string, unknown>[] = [];
		const { fetch } = fakeFetch(403);
		monitoringSink({
			baseUrl: 'https://hadoku.me',
			serviceKey: 'k',
			log: (e) => logged.push(e),
			fetch,
		})('costly-act', { userId: '3f2b8c1e-5d4a-4e7b-9a10-6c2d8e4f1a01' });
		await vi.waitFor(() =>
			expect(logged).toEqual([{ evt: 'telemetry-post-failed', event: 'costly-act', status: 403 }]),
		);
	});
});

describe('firstSeen', () => {
	const ids = (r: Request) => (r.headers['x-user-id'] as string | undefined) ?? null;
	const tiers = (r: Request) => (r.headers['x-hadoku-tier'] as string | undefined) ?? 'public';

	it('reports an account once, across restarts, and never an unnamed caller', () => {
		const { events } = recorder();
		const file = join(mkdtempSync(join(tmpdir(), 'seen-')), 'callers-seen.json');
		const run = (mw: ReturnType<typeof firstSeen>, r: Request) => mw(r, {} as Response, () => {});

		const first = firstSeen({
			file,
			userIdOf: ids,
			tierOf: tiers,
			log: () => {},
		});
		run(
			first,
			req({
				'x-user-id': 'c41f9e2a-7b3d-4a8e-9c56-2f0d1b8e6a03',
				'x-hadoku-tier': 'member',
				'user-agent': 'Firefox',
			}),
		);
		run(first, req({ 'x-user-id': 'c41f9e2a-7b3d-4a8e-9c56-2f0d1b8e6a03', 'x-hadoku-tier': 'member' }));
		run(first, req({}));
		const restarted = firstSeen({
			file,
			userIdOf: ids,
			tierOf: tiers,
			log: () => {},
		});
		run(restarted, req({ 'x-user-id': 'c41f9e2a-7b3d-4a8e-9c56-2f0d1b8e6a03', 'x-hadoku-tier': 'member' }));
		run(restarted, req({ 'x-user-id': '5a7d3c9e-1f2b-4e48-a6c0-9b8e7d2f4c04', 'x-hadoku-tier': 'friend' }));

		expect(events).toEqual([
			[
				'caller-first-seen',
				{ userId: 'c41f9e2a-7b3d-4a8e-9c56-2f0d1b8e6a03', tier: 'member', ua: 'Firefox', path: '/api/rooms' },
			],
			[
				'caller-first-seen',
				{ userId: '5a7d3c9e-1f2b-4e48-a6c0-9b8e7d2f4c04', tier: 'friend', ua: null, path: '/api/rooms' },
			],
		]);
		expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([
			'c41f9e2a-7b3d-4a8e-9c56-2f0d1b8e6a03',
			'5a7d3c9e-1f2b-4e48-a6c0-9b8e7d2f4c04',
		]);
	});

	it('starts empty from an unreadable file, and says why', () => {
		const file = join(mkdtempSync(join(tmpdir(), 'seen-')), 'callers-seen.json');
		writeFileSync(file, '{"not":"a list"}');
		const logged: Record<string, unknown>[] = [];
		firstSeen({
			file,
			userIdOf: ids,
			tierOf: tiers,
			log: (e) => logged.push(e),
		});
		expect(logged).toEqual([{ evt: 'first-seen-unreadable', file, reason: 'not a list of ids' }]);
	});
});

describe('what the seals and limiters report', () => {
	it('a rate limiter reports each pass as a costly act and each refusal as rate-limited', () => {
		const { events } = recorder();
		const limit = perCallerLimit({ capacity: 1, refillAmount: 1, refillIntervalMs: 60_000 }, 'slow down', {
			act: 'room-create',
			now: () => 0,
		});
		const res = {
			setHeader: () => {},
			status: () => ({ json: () => {} }),
		} as unknown as Response;
		const caller = req({
			'x-user-id': '7a6e2deb-cc0a-4342-9334-02c701fcabb4',
			'x-hadoku-tier': 'member',
			'user-agent': 'curl/8',
		});

		expect(limit(caller, res)).toBe(true);
		expect(limit(caller, res)).toBe(false);
		const who = {
			userId: '7a6e2deb-cc0a-4342-9334-02c701fcabb4',
			tier: 'member',
			ua: 'curl/8',
		};
		expect(events).toEqual([
			['costly-act', { act: 'room-create', ...who }],
			['rate-limited', { act: 'room-create', ...who }],
		]);
	});

	it('a seal refusal names the surface and the sanitized caller', () => {
		const { events } = recorder();
		reportSealRefused('play-socket', { 'x-hadoku-tier': 'public', 'user-agent': 'python-requests/2' }, null);
		expect(events).toEqual([
			[
				'seal-refused',
				{
					surface: 'play-socket',
					path: null,
					userId: null,
					tier: 'public',
					ua: 'python-requests/2',
				},
			],
		]);
	});
});
