/**
 * `attachUsage` end to end through a real express app. Schema, path, tier/user lookups are all
 * parameters here — never `@hadoku/shared`, which this module does not import.
 */
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { TelemetryContext } from '../telemetry/telemetry.ts';
import { attachUsage, MAX_BATCHES_PER_MINUTE, placed, type UsageEntry, type UsageSchema } from './usage.ts';

interface UsageBatch {
	entries: readonly UsageEntry[];
	sentAt?: number;
}

/** A minimal structural stand-in for `@hadoku/shared`'s `UsageBatchSchema` — never imported here. */
const schema: UsageSchema<UsageBatch> = {
	safeParse: (body) => {
		const b = body as Partial<UsageBatch> | null;
		if (typeof b !== 'object' || b === null || !Array.isArray(b.entries)) return { success: false };
		for (const e of b.entries) {
			if (typeof (e as UsageEntry).kind !== 'string' || typeof (e as UsageEntry).screen !== 'string') return { success: false };
			if ((e as UsageEntry).target !== undefined && !/^[a-z0-9-]+$/.test((e as UsageEntry).target as string)) return { success: false };
		}
		return { success: true, data: b as UsageBatch };
	},
};

const servers: Server[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.close();
});

async function usageApp(clock: { t: number }, trailMax?: number) {
	const events: [string, TelemetryContext][] = [];
	const api = express.Router();
	api.use(express.json());
	const counter = attachUsage(api, {
		schema,
		path: 'usage',
		tierOf: (req) => (req.headers['x-hadoku-tier'] as string) ?? 'public',
		userIdOf: (req) => (req.headers['x-user-id'] as string) ?? '',
		nameOf: (req) => (req.headers['x-user-name'] as string) ?? null,
		report: (e, c) => events.push([e, c]),
		now: () => clock.t,
		windowMs: 3_600_000,
		trailMax,
	});
	const app = express();
	app.use('/api', api);
	const server = createServer(app).listen(0);
	servers.push(server);
	await new Promise((r) => server.once('listening', r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/usage`;
	const post = (body: unknown, user = '3f2b8c1e-5d4a-4e7b-9a10-6c2d8e4f1a01', tier = 'member', name = 'Player 80583') =>
		fetch(base, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-user-id': user, 'x-hadoku-tier': tier, 'x-user-name': name },
			body: JSON.stringify(body),
		});
	return { events, counter, post };
}

describe('attachUsage', () => {
	it('counts views and clicks by screen and target, people by tier, and posts one event per window', async () => {
		const clock = { t: 0 };
		const u = await usageApp(clock);
		expect((await u.post({ entries: [{ kind: 'view', screen: 'lobby' }, { kind: 'click', screen: 'lobby', target: 'room-card' }] })).status).toBe(204);
		expect((await u.post({ entries: [{ kind: 'click', screen: 'lobby', target: 'room-card' }] }, '8d0e4a7c-2b19-4f63-b8d5-1e9a6c3b7f02', 'friend')).status).toBe(204);
		clock.t = 300_000;
		u.counter.flush();
		u.counter.flush();
		u.counter.stop();

		expect(u.events.filter(([e]) => e === 'usage')).toEqual([
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

	it('posts each person their own trail: placed by the page clock, in order across batches, with their name and tier', async () => {
		const clock = { t: 0 };
		const u = await usageApp(clock);
		const alice = '3f2b8c1e-5d4a-4e7b-9a10-6c2d8e4f1a01';
		const bob = '8d0e4a7c-2b19-4f63-b8d5-1e9a6c3b7f02';
		// The page clock is 1 000 000 ms ahead of the server's: only `sentAt - at` is read.
		clock.t = 30_000;
		await u.post({ sentAt: 1_030_000, entries: [{ kind: 'view', screen: 'room', at: 1_000_000 }, { kind: 'click', screen: 'room', target: 'pick', at: 1_020_000 }] }, alice, 'guest', 'Player 80583');
		await u.post({ entries: [{ kind: 'click', screen: 'lobby', target: 'room-card' }] }, bob, 'friend', 'ohmusama');
		// A second tab of alice's, sent later but holding a press made between the first two.
		clock.t = 40_000;
		await u.post({ sentAt: 5_040_000, entries: [{ kind: 'click', screen: 'room', target: 'pack', at: 5_030_000 }] }, alice, 'guest', 'Player 80583');
		clock.t = 300_000;
		u.counter.flush();
		u.counter.stop();

		const people = u.events.filter(([e]) => e === 'usage-user').map(([, c]) => c);
		expect(people).toEqual([
			{
				from: new Date(0).toISOString(),
				minutes: 5,
				userId: alice,
				name: 'Player 80583',
				tier: 'guest',
				views: 1,
				clicks: 2,
				trail: ['00:00:00 view room', '00:00:20 click room pick', '00:00:30 click room pack'],
			},
			{ from: new Date(0).toISOString(), minutes: 5, userId: bob, name: 'ohmusama', tier: 'friend', views: 0, clicks: 1, trail: ['00:00:30 click lobby room-card'] },
		]);
	});

	it("keeps a trail's first lines past trailMax and says how many it dropped", async () => {
		const u = await usageApp({ t: 0 }, 2);
		await u.post({ entries: [{ kind: 'view', screen: 'a' }, { kind: 'view', screen: 'b' }, { kind: 'view', screen: 'c' }] });
		u.counter.flush();
		u.counter.stop();
		const [, person] = u.events.find(([e]) => e === 'usage-user')!;
		expect(person).toMatchObject({ views: 3, trail: ['00:00:00 view a', '00:00:00 view b'], trailDropped: 1 });
	});

	it('places an entry at receipt less its age on the page, never after receipt, and at receipt with no page clock', () => {
		expect(placed(10_000, 1_005_000, 1_002_000)).toBe(7_000);
		expect(placed(10_000, 1_000_000, 1_002_000)).toBe(10_000);
		expect(placed(10_000, undefined, 5)).toBe(10_000);
		expect(placed(10_000, 5, undefined)).toBe(10_000);
	});

	it('refuses a label or free text as a name, and drops a flood past the per-minute cap', async () => {
		const u = await usageApp({ t: 0 });
		expect((await u.post({ entries: [{ kind: 'click', screen: 'lobby', target: 'Lightning Bolt' }] })).status).toBe(400);
		for (let i = 0; i < MAX_BATCHES_PER_MINUTE + 3; i++) await u.post({ entries: [{ kind: 'view', screen: 'lobby' }] });
		u.counter.flush();
		u.counter.stop();
		expect(u.events[0][1]).toMatchObject({ batches: MAX_BATCHES_PER_MINUTE, dropped: 3 });
	});

	it('an injected `maxBatchesPerMinute` overrides the default', async () => {
		const events: [string, TelemetryContext][] = [];
		const api = express.Router();
		api.use(express.json());
		const counter = attachUsage(api, {
			schema,
			path: 'usage',
			tierOf: () => 'member',
			userIdOf: () => 'u-1',
			report: (e, c) => events.push([e, c]),
			maxBatchesPerMinute: 2,
		});
		const app = express();
		app.use('/api', api);
		const server = createServer(app).listen(0);
		servers.push(server);
		await new Promise((r) => server.once('listening', r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/usage`;
		for (let i = 0; i < 4; i++) await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries: [{ kind: 'view', screen: 'x' }] }) });
		counter.flush();
		counter.stop();
		expect(events[0][1]).toMatchObject({ batches: 2, dropped: 2 });
	});
});
