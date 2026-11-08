import express from 'express';
import type { Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { capacitySampler } from './capacity.ts';
import type { TelemetryContext } from '../telemetry/telemetry.ts';

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
		for (const [path, status] of [
			['/api/rooms', 200],
			['/api/rooms', 200],
			['/api/rooms', 503],
		] as const) {
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
			uncounted: 0,
		});
	});

	it('counts an `uncountedPath` request under `uncountedField`, never timing it — the app chooses both', () => {
		const events: [string, TelemetryContext][] = [];
		let t = 0;
		const sampler = capacitySampler({
			gauges: {},
			report: (e, c) => events.push([e, c]),
			now: () => t,
			uncountedPath: (path) => path.startsWith('/api/art/'),
			uncountedField: 'artRedirects',
		});
		for (const path of ['/api/rooms', '/api/art/x', '/api/art/y']) {
			const res = Object.assign(new EventEmitter(), { statusCode: 200 });
			sampler.requests({ path } as Request, res as unknown as Response, () => {});
			res.emit('finish');
		}
		t = 300_000;
		sampler.flush();
		sampler.stop();

		expect(events[0][1]).toMatchObject({ requests: 1, artRedirects: 2 });
		expect(events[0][1].uncounted).toBeUndefined();
	});

	it('serves an express app end to end through the `requests` middleware', async () => {
		const events: [string, TelemetryContext][] = [];
		const sampler = capacitySampler({ gauges: {}, report: (e, c) => events.push([e, c]) });
		const app = express();
		app.use(sampler.requests);
		app.get('/ok', (_req, res) => res.status(204).end());
		const server = app.listen(0);
		await new Promise((r) => server.once('listening', r));
		const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		await fetch(`${base}/ok`);
		sampler.flush();
		sampler.stop();
		await new Promise<void>((r) => server.close(() => r()));

		expect(events[0][1]).toMatchObject({ requests: 1 });
	});
});
