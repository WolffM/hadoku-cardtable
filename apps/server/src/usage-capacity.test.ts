import express from 'express';
import type { Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { capacitySampler as kernelCapacitySampler, type CapacityDeps } from '@hadoku/service-kernel/capacity';
import { ART_REDIRECTS } from './capacity.js';

/** The sampler as cardtable's server builds it: card art counted as `artRedirects`. */
const capacitySampler = (deps: CapacityDeps) => kernelCapacitySampler({ ...deps, uncountedPath: ART_REDIRECTS.path, uncountedField: ART_REDIRECTS.field });
import { attachUsage, MAX_BATCHES_PER_MINUTE } from './http/usage.js';
import type { TelemetryContext } from './telemetry.js';

const servers: Server[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.close();
});

async function usageApp(clock: { t: number }) {
	const events: [string, TelemetryContext][] = [];
	const api = express.Router();
	api.use(express.json());
	const counter = attachUsage(api, {
		report: (e, c) => events.push([e, c]),
		now: () => clock.t,
		windowMs: 3_600_000,
	});
	const app = express();
	app.use('/api', api);
	const server = createServer(app).listen(0);
	servers.push(server);
	await new Promise((r) => server.once('listening', r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/usage`;
	const post = (body: unknown, user = '3f2b8c1e-5d4a-4e7b-9a10-6c2d8e4f1a01', tier = 'member') =>
		fetch(base, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-user-id': user,
				'x-hadoku-tier': tier,
			},
			body: JSON.stringify(body),
		});
	return { events, counter, post };
}

describe('POST /api/usage', () => {
	it('counts views and clicks by screen and target, people by tier, and posts one event per window', async () => {
		const clock = { t: 0 };
		const u = await usageApp(clock);
		expect(
			(
				await u.post({
					entries: [
						{ kind: 'view', screen: 'lobby' },
						{ kind: 'click', screen: 'lobby', target: 'room-card' },
					],
				})
			).status,
		).toBe(204);
		expect(
			(
				await u.post(
					{
						entries: [{ kind: 'click', screen: 'lobby', target: 'room-card' }],
					},
					'8d0e4a7c-2b19-4f63-b8d5-1e9a6c3b7f02',
					'friend',
				)
			).status,
		).toBe(204);
		clock.t = 300_000;
		u.counter.flush();
		u.counter.flush();
		u.counter.stop();

		expect(u.events).toEqual([
			[
				'usage',
				{
					from: new Date(0).toISOString(),
					minutes: 5,
					users: 2,
					tiers: { member: 1, friend: 1 },
					batches: 2,
					dropped: 0,
					views: 1,
					clicks: 2,
					top: { 'click lobby room-card': 2, 'view lobby': 1 },
				},
			],
		]);
	});

	it('refuses a label or free text as a name, and drops a flood past the per-minute cap', async () => {
		const u = await usageApp({ t: 0 });
		expect(
			(
				await u.post({
					entries: [{ kind: 'click', screen: 'lobby', target: 'Lightning Bolt' }],
				})
			).status,
		).toBe(400);
		for (let i = 0; i < MAX_BATCHES_PER_MINUTE + 3; i++) await u.post({ entries: [{ kind: 'view', screen: 'lobby' }] });
		u.counter.flush();
		u.counter.stop();
		expect(u.events[0][1]).toMatchObject({
			batches: MAX_BATCHES_PER_MINUTE,
			dropped: 3,
		});
	});
});

describe('capacitySampler', () => {
	it('reports each gauge peak, the latest reading, and request rate and latency for the window', () => {
		const events: [string, TelemetryContext][] = [];
		let t = 0;
		let rooms = 3;
		const sampler = capacitySampler({
			gauges: { rooms: () => rooms },
			report: (e, c) => events.push([e, c]),
			now: () => t,
			memory: () => ({ rss: 300 * 1024 * 1024, heapUsed: 100 * 1024 * 1024 }),
		});
		sampler.sample();
		rooms = 9;
		sampler.sample();
		rooms = 4;
		sampler.sample();
		for (const [path, status] of [['/api/rooms', 200], ['/api/rooms', 200], ['/api/rooms', 503], ['/api/art/x', 302], ['/api/art/y/back', 302]] as const) {
			const res = Object.assign(new EventEmitter(), { statusCode: status });
			sampler.requests({ path } as Request, res as unknown as Response, () => {});
			res.emit('finish');
		}
		t = 300_000;
		sampler.flush();
		sampler.stop();

		expect(events).toHaveLength(1);
		expect(events[0][1]).toMatchObject({
			minutes: 5,
			samples: 3,
			peak: { rooms: 9, rssMb: 300, heapMb: 100 },
			now: { rooms: 4 },
			requests: 3,
			perMin: 1,
			errors5xx: 1,
			artRedirects: 2,
		});
	});
});
