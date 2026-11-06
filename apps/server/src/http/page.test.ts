/**
 * The page itself, per caller: one browser reloading `/cardtable/` in a loop must not cost the
 * server, its log and the edge's log a whole boot's requests every half second.
 *
 * What it pins: on 2026-11-06 one signed-in caller loaded the page ~120 times a minute for eight
 * hours, every load fanning out into eight more requests, until the pm2 log rotated the morning
 * away and the edge's log query failed under the volume. Real callers peak at 20 loads a minute.
 */

import express from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BasePathVerdict } from '../base-path.js';
import { attachPage, PAGE_LOAD_RATE_LIMIT } from './page.js';

const SERVABLE: BasePathVerdict = { ok: true, reason: 'ok', offenders: [], detail: '' };
const INDEX = '<!doctype html><html><body><div id="root"></div></body></html>';

let dir: string;
let indexHtml: string;
const servers: Server[] = [];

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'cardtable-page-'));
	indexHtml = join(dir, 'index.html');
	writeFileSync(indexHtml, INDEX);
});

afterAll(async () => {
	await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
	rmSync(dir, { recursive: true, force: true });
});

async function openPage(opts: Omit<Parameters<typeof attachPage>[1], 'indexHtml' | 'basePath' | 'basePrefix'>): Promise<string> {
	const app = express();
	attachPage(app, { indexHtml, basePath: SERVABLE, basePrefix: '/cardtable', ...opts });
	const server = createServer(app);
	servers.push(server);
	await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const load = (base: string, user: string, path = '/') => fetch(`${base}${path}`, { headers: { 'x-user-id': user } });

describe('page loads, per caller', () => {
	it('refuses a caller reloading in a loop, with Retry-After, and nobody else', async () => {
		const clock = { now: Date.UTC(2026, 10, 6, 16, 20) };
		const base = await openPage({ now: () => clock.now });
		const { capacity } = PAGE_LOAD_RATE_LIMIT;

		const statuses: number[] = [];
		for (let i = 0; i < capacity + 5; i++) statuses.push((await load(base, 'looper', i % 2 === 0 ? '/' : '/match/m-1')).status);
		expect(statuses).toEqual([...Array.from({ length: capacity }, () => 200), 429, 429, 429, 429, 429]);

		const refused = await load(base, 'looper');
		expect(refused.status).toBe(429);
		expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);

		expect((await load(base, 'someone-else')).status).toBe(200);
	});

	it('lets every caller seen on prod through: 20 loads a minute, all day', async () => {
		const clock = { now: Date.UTC(2026, 10, 6, 0, 0) };
		const base = await openPage({ now: () => clock.now });
		for (let minute = 0; minute < 30; minute++) {
			for (let i = 0; i < 20; i++) {
				expect((await load(base, 'busy-but-human')).status).toBe(200);
				clock.now += 3_000;
			}
		}
	});

	it('the loop that hammered prod gets most of its loads refused', async () => {
		const clock = { now: Date.UTC(2026, 10, 6, 0, 0) };
		const base = await openPage({ now: () => clock.now });
		let served = 0;
		const loads = 120 * 10;
		for (let i = 0; i < loads; i++) {
			if ((await load(base, 'looper')).status === 200) served++;
			clock.now += 500;
		}
		expect(served).toBeLessThan(loads / 3);
	});

	it('has no limit where the e2e stacks turn limits off', async () => {
		const base = await openPage({ rateLimit: null });
		for (let i = 0; i < PAGE_LOAD_RATE_LIMIT.capacity * 3; i++) expect((await load(base, 'e2e')).status).toBe(200);
	});

	it('still answers the diagnostic page, not a refusal, when the bundle cannot be served', async () => {
		const app = express();
		attachPage(app, { indexHtml, basePath: { ok: false, reason: 'missing', offenders: [], detail: 'no bundle' }, basePrefix: '/cardtable' });
		const server = createServer(app);
		servers.push(server);
		await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
		const res = await load(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'anyone');
		expect(res.status).toBe(503);
	});
});
