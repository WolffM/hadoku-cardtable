/**
 * `attachUsage` end to end through a real express app. Schema, path, tier/user lookups are all
 * parameters here — never `@hadoku/shared`, which this module does not import.
 */
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { TelemetryContext } from '../telemetry/telemetry.ts';
import { attachUsage, MAX_BATCHES_PER_MINUTE, type UsageEntry, type UsageSchema } from './usage.ts';

interface UsageBatch {
	entries: readonly UsageEntry[];
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

async function usageApp(clock: { t: number }) {
	const events: [string, TelemetryContext][] = [];
	const api = express.Router();
	api.use(express.json());
	const counter = attachUsage(api, {
		schema,
		path: 'usage',
		tierOf: (req) => (req.headers['x-hadoku-tier'] as string) ?? 'public',
		userIdOf: (req) => (req.headers['x-user-id'] as string) ?? '',
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
			headers: { 'content-type': 'application/json', 'x-user-id': user, 'x-hadoku-tier': tier },
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
