import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { phasesOf, tracedFetch } from './fetch-trace.js';

/** A real HTTP server on loopback that answers each request with `handle`. */
async function serve(handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close(): Promise<void> }> {
	const server = createServer(handle);
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${String(port)}/resolve`,
		close: () =>
			new Promise<void>((r) => {
				server.closeAllConnections();
				server.close(() => r());
			}),
	};
}

const post = (f: typeof fetch, url: string, timeoutMs: number) => f(url, { method: 'POST', body: '{"userIds":["u1"]}', signal: AbortSignal.timeout(timeoutMs) });

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
	await close?.();
	close = undefined;
});

describe('tracedFetch', () => {
	it('says a request that timed out was sent on a new socket and never got its headers', async () => {
		const s = await serve(() => undefined);
		close = s.close;
		const err = await post(tracedFetch(), s.url, 300).catch((e: unknown) => e);
		expect((err as Error).name).toBe('TimeoutError');
		const phases = phasesOf(err);
		expect(phases).toMatchObject({ socket: 'new', connectMs: expect.any(Number), sentMs: expect.any(Number), bodySentMs: expect.any(Number), connectsPending: 0 });
		expect(phases?.headersMs).toBeUndefined();
		expect(phases?.failedMs).toBeGreaterThanOrEqual(290);
	});

	it('says a request that hung went out on a reused socket, and how long that socket had sat', async () => {
		let n = 0;
		const s = await serve((_req, res) => {
			if (n++ === 0) res.end('{}');
		});
		close = s.close;
		const f = tracedFetch();
		await (await post(f, s.url, 1000)).text();
		// The socket returns to the pool once the response's last tick has run.
		await new Promise((r) => setImmediate(r));
		const phases = phasesOf(await post(f, s.url, 300).catch((e: unknown) => e));
		expect(phases).toMatchObject({ socket: 'reused', idleMs: expect.any(Number), sentMs: expect.any(Number) });
		expect(phases?.connectMs).toBeUndefined();
	});

	it('says the headers came when the body is what never finished', async () => {
		const s = await serve((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.write('{"avatars":');
		});
		close = s.close;
		const err = await (await post(tracedFetch(), s.url, 300)).json().catch((e: unknown) => e);
		expect(phasesOf(err)).toMatchObject({ socket: 'new', headersMs: expect.any(Number), failedMs: expect.any(Number) });
	});

	it('follows only its own fetches, and passes an answer through untouched', async () => {
		const s = await serve((_req, res) => res.end('ok'));
		close = s.close;
		expect(await (await post(tracedFetch(), s.url, 1000)).text()).toBe('ok');
		expect(phasesOf(await post(fetch, 'http://127.0.0.1:1/', 1000).catch((e: unknown) => e))).toBeUndefined();
	});
});
