/**
 * `attachClientEvents` end to end through a real express app: a page's telemetry lands in the
 * log as a `client` event keyed by page and user, a malformed one is refused and named, and a
 * flood is cut at the injected per-second cap. Schema, path and cap are all parameters here —
 * never `@hadoku/shared`, which this module does not import.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { attachClientEvents, malformedFacts, type PageEventSchema } from './client-events.ts';

interface PageEvent {
	page: string;
	kind: string;
	data: Record<string, unknown>;
}

/** A minimal structural stand-in for `@hadoku/shared`'s `PageEventSchema` — never imported here. */
const schema: PageEventSchema<PageEvent> = {
	safeParse: (body) => {
		const b = body as Partial<PageEvent> | null;
		if (typeof b !== 'object' || b === null || typeof b.page !== 'string' || typeof b.kind !== 'string' || typeof b.data !== 'object') {
			return { success: false, error: { issues: [{ path: [], message: 'not a page event' }] } };
		}
		return { success: true, data: b as PageEvent };
	},
};

const servers: HttpServer[] = [];
let logged: Record<string, unknown>[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
	logged = [];
});

async function openApp(now: () => number = Date.now, maxPerSecond = 20): Promise<string> {
	const app = express();
	const api = express.Router();
	api.use(express.json({ limit: '1mb' }));
	attachClientEvents(api, { schema, path: 'client-events', maxPerSecond, userIdOf: () => 'u-1', log: (entry) => logged.push(entry), now });
	app.use('/api', api);
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function post(base: string, body: unknown): Promise<number> {
	const res = await fetch(`${base}/api/client-events`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	return res.status;
}

const scroll = { page: 'front', kind: 'perf', data: { what: 'scroll', frames: 120 } };

describe('attachClientEvents', () => {
	it('logs a page event as a client event, keyed by page and user', async () => {
		const base = await openApp();
		expect(await post(base, scroll)).toBe(204);
		expect(logged).toEqual([{ evt: 'client', page: 'front', userId: 'u-1', kind: 'perf', what: 'scroll', frames: 120 }]);
	});

	it('refuses a body that is not a page event, and says why in the log', async () => {
		const base = await openApp();
		expect(await post(base, { page: 'front', kind: 'perf' })).toBe(400);
		expect(logged).toEqual([{ evt: 'client-malformed', userId: 'u-1', kind: 'perf', what: undefined, errors: ['(event): not a page event'] }]);
	});

	it("keeps at most the injected per-second cap from one user", async () => {
		let t = 5_000;
		const base = await openApp(() => t, 20);
		for (let i = 0; i < 25; i += 1) expect(await post(base, scroll)).toBe(204);
		expect(logged).toHaveLength(20);
		t += 1_000;
		expect(await post(base, scroll)).toBe(204);
		expect(logged).toHaveLength(21);
	});
});

describe('malformedFacts', () => {
	it('keeps the event kind and data.what, and names each failing field without its value', () => {
		expect(malformedFacts({ kind: 'perf', data: { what: 'scroll', secret: 'x' } }, [{ path: ['data', 'secret'], message: 'Invalid input' }])).toEqual({
			kind: 'perf',
			what: 'scroll',
			errors: ['data.secret: Invalid input'],
		});
	});

	it('is safe against a raw body with no shape at all', () => {
		expect(malformedFacts(null, [{ path: [], message: 'not an object' }])).toEqual({
			kind: undefined,
			what: undefined,
			errors: ['(event): not an object'],
		});
	});
});
