import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	firstSeen,
	installTelemetry,
	monitoringSink,
	reportingAlerts,
	reportSealRefused,
	siteOf,
	type Level,
	type TelemetryContext,
} from './telemetry.ts';

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
			serviceKeyEnvVar: 'GAME_SERVICE_KEY',
			service: 'game',
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
		expect(posts[0].headers['User-Agent']).toBe('Mozilla/5.0 hadoku-game');
		expect(posts[0].body).toMatchObject({
			level: 'warn',
			message: 'event=rate-limited',
			context: { service: 'game', site: 'prod', act: 'room-create' },
		});
	});

	it('tags every event with its site, and takes an explicit level over the name rule', () => {
		const { fetch, posts } = fakeFetch();
		const sink = monitoringSink({
			baseUrl: 'https://hadoku.me',
			serviceKey: 'k',
			serviceKeyEnvVar: 'GAME_SERVICE_KEY',
			service: 'game',
			site: 'ppe',
			log: () => {},
			fetch,
		});
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
		const sink = monitoringSink({
			baseUrl: 'https://hadoku.me',
			serviceKey: 'k',
			serviceKeyEnvVar: 'GAME_SERVICE_KEY',
			service: 'game',
			site: 'prod',
			log: () => {},
			fetch,
			now: () => 0,
		});
		sink('alert', { key: 'failover:claw-9', text: '🚨 Failover' }, 'critical');
		sink('alert', { key: 'lost:claw-9', text: '🚨 Match lost' }, 'critical');
		sink('alert', { key: 'lost:claw-9', text: '🚨 Match lost' }, 'critical');

		expect(posts.map((p) => p.body.context.key)).toEqual(['failover:claw-9', 'lost:claw-9']);
	});

	it('posts nothing without a service key, and says so once, naming the env var', () => {
		const logged: Record<string, unknown>[] = [];
		const { fetch, posts } = fakeFetch();
		const sink = monitoringSink({
			baseUrl: 'https://hadoku.me',
			serviceKey: '',
			serviceKeyEnvVar: 'GAME_SERVICE_KEY',
			service: 'game',
			site: 'prod',
			log: (e) => logged.push(e),
			fetch,
		});
		sink('caller-first-seen', { userId: '3f2b8c1e-5d4a-4e7b-9a10-6c2d8e4f1a01' });
		expect(posts).toEqual([]);
		expect(logged).toEqual([{ evt: 'telemetry-disabled', reason: 'GAME_SERVICE_KEY is not set' }]);
	});

	it('logs a refused post instead of dropping it silently', async () => {
		const logged: Record<string, unknown>[] = [];
		const { fetch } = fakeFetch(403);
		monitoringSink({
			baseUrl: 'https://hadoku.me',
			serviceKey: 'k',
			serviceKeyEnvVar: 'GAME_SERVICE_KEY',
			service: 'game',
			site: 'prod',
			log: (e) => logged.push(e),
			fetch,
		})('costly-act', { userId: '3f2b8c1e-5d4a-4e7b-9a10-6c2d8e4f1a01' });
		await vi.waitFor(() => expect(logged).toEqual([{ evt: 'telemetry-post-failed', event: 'costly-act', status: 403 }]));
	});
});

describe('siteOf', () => {
	it('reads the deployment from the base path the wrapper sets, by the service id given', () => {
		expect(siteOf('/game', 'game')).toBe('prod');
		expect(siteOf('/game/', 'game')).toBe('prod');
		expect(siteOf('/game-ppe', 'game')).toBe('ppe');
		expect(siteOf('/elsewhere', 'game')).toBe('/elsewhere');
		// A different service id reads the SAME prefix apart — this module knows no one game.
		expect(siteOf('/cardtable', 'cardtable')).toBe('prod');
		expect(siteOf('/cardtable-ppe', 'cardtable')).toBe('ppe');
	});
});

describe('reportingAlerts', () => {
	it('reports every `alert` log entry at the level its mark says, and still logs it, leaving everything else untouched', () => {
		const reported: [string, TelemetryContext, Level | undefined][] = [];
		const logged: Record<string, unknown>[] = [];
		const log = reportingAlerts(
			(e) => logged.push(e),
			(event, context, level) => reported.push([event, context, level]),
		);

		log({ evt: 'alert', key: 'failover:claw-9', text: '🚨 Failover: claw-9 — heartbeat lost.' });
		log({ evt: 'alert', key: 'capacity', text: '⚠️ Capacity: a match is waiting for a host.' });
		log({ evt: 'alert', key: 'capacity:resolved', text: '✅ Capacity: matches are being placed again' });
		log({ evt: 'alert', key: 'a-kind-added-later:claw-1', text: 'Something new' });
		// A non-alert entry is logged, never reported.
		log({ evt: 'something-else', key: 'x', text: 'y' });

		expect(reported.map(([event, c, level]) => [event, c.key, level])).toEqual([
			['alert', 'failover:claw-9', 'critical'],
			['alert', 'capacity', 'warn'],
			['alert', 'capacity:resolved', 'info'],
			['alert', 'a-kind-added-later:claw-1', 'warn'],
		]);
		expect(logged).toHaveLength(5);
	});
});

describe('firstSeen', () => {
	const ids = (r: Request) => (r.headers['x-user-id'] as string | undefined) ?? null;
	const tiers = (r: Request) => (r.headers['x-hadoku-tier'] as string | undefined) ?? 'public';

	it('reports an account once, across restarts, and never an unnamed caller', () => {
		const { events } = recorder();
		const file = join(mkdtempSync(join(tmpdir(), 'seen-')), 'callers-seen.json');
		const run = (mw: ReturnType<typeof firstSeen>, r: Request) => mw(r, {} as Response, () => {});

		const first = firstSeen({ file, userIdOf: ids, tierOf: tiers, log: () => {} });
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
		const restarted = firstSeen({ file, userIdOf: ids, tierOf: tiers, log: () => {} });
		run(restarted, req({ 'x-user-id': 'c41f9e2a-7b3d-4a8e-9c56-2f0d1b8e6a03', 'x-hadoku-tier': 'member' }));
		run(restarted, req({ 'x-user-id': '5a7d3c9e-1f2b-4e48-a6c0-9b8e7d2f4c04', 'x-hadoku-tier': 'friend' }));

		expect(events).toEqual([
			['caller-first-seen', { userId: 'c41f9e2a-7b3d-4a8e-9c56-2f0d1b8e6a03', tier: 'member', ua: 'Firefox', path: '/api/rooms' }],
			['caller-first-seen', { userId: '5a7d3c9e-1f2b-4e48-a6c0-9b8e7d2f4c04', tier: 'friend', ua: null, path: '/api/rooms' }],
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
		firstSeen({ file, userIdOf: ids, tierOf: tiers, log: (e) => logged.push(e) });
		expect(logged).toEqual([{ evt: 'first-seen-unreadable', file, reason: 'not a list of ids' }]);
	});

	it("forgets an account (account erase), and does nothing the second time", () => {
		const file = join(mkdtempSync(join(tmpdir(), 'seen-')), 'callers-seen.json');
		const seen = firstSeen({ file, userIdOf: ids, tierOf: tiers, log: () => {} });
		seen(req({ 'x-user-id': 'u-1', 'x-hadoku-tier': 'member' }), {} as Response, () => {});
		expect(seen.forget('u-1')).toBe(1);
		expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);
		expect(seen.forget('u-1')).toBe(0);
	});
});

describe('reportSealRefused', () => {
	it('names the surface and the sanitized caller — `Surface` is an open string, any label works', () => {
		const { events } = recorder();
		reportSealRefused('play-socket', { 'x-hadoku-tier': 'public', 'user-agent': 'python-requests/2' }, null);
		reportSealRefused('a-new-surface', { 'x-hadoku-tier': 'public' }, '/x');
		expect(events).toEqual([
			['seal-refused', { surface: 'play-socket', path: null, userId: null, tier: 'public', ua: 'python-requests/2' }],
			['seal-refused', { surface: 'a-new-surface', path: '/x', userId: null, tier: 'public', ua: null }],
		]);
	});
});
