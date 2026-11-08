/**
 * Pins cardtable's own origin value — `apps/server/src/index.test.ts` already
 * proves `stampOrigin` on the real boot path; this pins the literals this
 * file binds, now that the mechanism itself lives in
 * `@hadoku/service-kernel/http`.
 */
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ORIGIN_HEADER, ORIGIN_VALUE, stampOrigin } from './origin.ts';

describe('cardtable\'s origin stamp', () => {
	it('pins the header name and the service value, byte-identical', () => {
		expect(ORIGIN_HEADER).toBe('X-Hadoku-Origin');
		expect(ORIGIN_VALUE).toBe('cardtable');
	});

	let server: ReturnType<typeof createServer> | undefined;
	afterEach(async () => {
		if (server) await new Promise<void>((done) => server!.close(() => done()));
		server = undefined;
	});

	it('stamps X-Hadoku-Origin: cardtable on every response, at the socket level', async () => {
		const app = express();
		app.get('/x', (_req, res) => res.status(200).send('ok'));
		server = createServer(app);
		stampOrigin(server);
		await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
		const port = (server.address() as AddressInfo).port;

		const res = await fetch(`http://127.0.0.1:${port}/x`);
		expect(res.headers.get(ORIGIN_HEADER)).toBe('cardtable');
	});
});
