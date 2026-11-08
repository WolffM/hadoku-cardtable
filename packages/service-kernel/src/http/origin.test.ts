/**
 * `stampOrigin` is generic over the origin value: the app's own service id,
 * not a fixed one. See `apps/server/src/http/origin.test.ts` for the pin on
 * cardtable's literal value.
 */
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ORIGIN_HEADER, stampOrigin } from './index.ts';

describe('stampOrigin', () => {
	let server: ReturnType<typeof createServer> | undefined;

	afterEach(async () => {
		if (server) await new Promise<void>((done) => server!.close(() => done()));
		server = undefined;
	});

	it('stamps the app-supplied origin value on every response, at the socket level', async () => {
		const app = express();
		app.get('/x', (_req, res) => res.status(200).send('ok'));
		server = createServer(app);
		stampOrigin(server, 'bomberman');
		await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
		const port = (server.address() as AddressInfo).port;

		const res = await fetch(`http://127.0.0.1:${port}/x`);
		expect(res.headers.get(ORIGIN_HEADER)).toBe('bomberman');
	});

	it('stamps even a 404 the app never routed, because it is socket-level', async () => {
		const app = express();
		server = createServer(app);
		stampOrigin(server, 'bomberman');
		await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
		const port = (server.address() as AddressInfo).port;

		const res = await fetch(`http://127.0.0.1:${port}/nowhere`);
		expect(res.headers.get(ORIGIN_HEADER)).toBe('bomberman');
	});
});
