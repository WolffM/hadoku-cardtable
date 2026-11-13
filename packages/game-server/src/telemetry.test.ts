import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { perCallerLimit } from './http/request.js';
import { Alerts } from './play/placement/alerts.js';
import { firstSeen } from '@hadoku/service-kernel/telemetry';
import {
	installTelemetry,
	monitoringSink,
	reportingAlerts,
	reportSealRefused,
	siteOf,
	type Level,
	type TelemetryContext,
} from './telemetry.js';

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
			site: 'prod',
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
			context: { service: 'cardtable', site: 'prod', act: 'room-create' },
		});
	});

	it('tags every event with its site, and takes an explicit level over the name rule', () => {
		const { fetch, posts } = fakeFetch();
		const sink = monitoringSink({ baseUrl: 'https://hadoku.me', serviceKey: 'k', site: 'ppe', log: () => {}, fetch });
		sink('capacity', { perMin: 3 });
		sink('seal-refused', { surface: 'http' });
		sink('capacity', { perMin: 4, userId: 'x' }, 'warn');
		sink('alert', { key: 'failover:claw-9', text: '🚨 Failover' }, 'critical');
		sink('alert', { key: 'capacity', text: '⚠️ Capacity' }, 'warn');

		expect(posts.map((p) => [p.body.level, p.body.context.site, p.body.context.severity])).toEqual([
			['info', 'ppe', undefined],
			['warn', 'ppe', undefined],
			['warn', 'ppe', undefined],
			// monitoring-api refuses `critical`: it goes out as `error`, the context says critical.
			['error', 'ppe', 'critical'],
			['warn', 'ppe', undefined],
		]);
	});

	it('throttles per incident key, so two alerts in one minute both go out', () => {
		const { fetch, posts } = fakeFetch();
		const sink = monitoringSink({ baseUrl: 'https://hadoku.me', serviceKey: 'k', site: 'prod', log: () => {}, fetch, now: () => 0 });
		sink('alert', { key: 'failover:claw-9', text: '🚨 Failover' }, 'critical');
		sink('alert', { key: 'lost:claw-9', text: '🚨 Match lost' }, 'critical');
		sink('alert', { key: 'lost:claw-9', text: '🚨 Match lost' }, 'critical');

		expect(posts.map((p) => p.body.context.key)).toEqual(['failover:claw-9', 'lost:claw-9']);
	});

	it('posts nothing without a service key, and says so once', () => {
		const logged: Record<string, unknown>[] = [];
		const { fetch, posts } = fakeFetch();
		const sink = monitoringSink({
			baseUrl: 'https://hadoku.me',
			serviceKey: '',
			site: 'prod',
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
			site: 'prod',
			log: (e) => logged.push(e),
			fetch,
		})('costly-act', { userId: '3f2b8c1e-5d4a-4e7b-9a10-6c2d8e4f1a01' });
		await vi.waitFor(() =>
			expect(logged).toEqual([{ evt: 'telemetry-post-failed', event: 'costly-act', status: 403 }]),
		);
	});
});

describe('siteOf', () => {
	it('reads the deployment from the base path the wrapper sets', () => {
		expect(siteOf('/cardtable')).toBe('prod');
		expect(siteOf('/cardtable/')).toBe('prod');
		expect(siteOf('/cardtable-ppe')).toBe('ppe');
		expect(siteOf('/elsewhere')).toBe('/elsewhere');
	});
});

describe('reportingAlerts', () => {
	it('reports every alert the hosting alerts post, at the level its mark says, and still logs it', () => {
		const reported: [string, TelemetryContext, Level | undefined][] = [];
		const logged: Record<string, unknown>[] = [];
		let t = 0;
		const alerts = new Alerts({
			sink: null,
			now: () => t,
			log: reportingAlerts((e) => logged.push(e), (event, context, level) => reported.push([event, context, level])),
		});
		alerts.fire('failover:claw-9', '🚨 Failover: claw-9 — heartbeat lost. Moved 1: m-1 → claw-2.');
		alerts.fire('capacity', '⚠️ Capacity: a Forge match is waiting for a host.');
		alerts.fire('capacity', '⚠️ Capacity: still waiting');
		alerts.fire('backstop', '🔺 hokon promoted to the Forge backstop: claws full.');
		alerts.note('fenced:claw-3', '🔁 Fenced: claw-3 — this server was silent.');
		t = 30_000;
		alerts.resolve('capacity', 'Capacity: Forge matches are being placed again');
		alerts.resolve('backstop', '🔻 hokon stood down as the Forge backstop: claws free.', '');
		alerts.fire('a-kind-added-later:claw-1', 'Something new');

		expect(reported.map(([event, c, level]) => [event, c.key, level])).toEqual([
			['alert', 'failover:claw-9', 'critical'],
			['alert', 'capacity', 'warn'],
			['alert', 'backstop', 'warn'],
			['alert', 'fenced:claw-3', 'warn'],
			['alert', 'capacity:resolved', 'info'],
			['alert', 'backstop:resolved', 'info'],
			['alert', 'a-kind-added-later:claw-1', 'warn'],
		]);
		expect(reported[4][1].text).toBe('✅ Capacity: Forge matches are being placed again (open 30 s)');
		// The held repeat is logged, not reported: Discord never saw it either.
		expect(logged.filter((e) => e.evt === 'alert-held').map((e) => e.key)).toEqual(['capacity']);
		expect(logged.filter((e) => e.evt === 'alert')).toHaveLength(7);
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
