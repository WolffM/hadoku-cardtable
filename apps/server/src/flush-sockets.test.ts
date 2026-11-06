import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { describe, expect, it } from 'vitest';
import { flushed } from './flush-sockets.ts';

/** A real socket.io server and websocket client; an emit queued behind a large one, then `io.close`. */
async function closeBehindABigSend(flushFirst: boolean): Promise<string[]> {
	const http = createServer();
	const io = new Server(http);
	await new Promise<void>((up) => http.listen(0, '127.0.0.1', up));
	const { port } = http.address() as { port: number };
	const seen: string[] = [];
	const client = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
	client.on('big', () => seen.push('big'));
	client.on('restarting', () => seen.push('restarting'));
	await new Promise<void>((up) => client.once('connect', () => up()));
	const dropped = new Promise<void>((done) => client.once('disconnect', () => done()));
	io.emit('big', 'x'.repeat(4_000_000));
	io.emit('restarting');
	expect([...io.sockets.sockets.values()].map((s) => s.conn.transport.writable)).toEqual([false]);
	if (flushFirst) await flushed([...io.sockets.sockets.values()].map((s) => s.conn), 2_000);
	io.close();
	await dropped;
	return seen;
}

describe('flushed', () => {
	it('lets an emit queued behind a send in flight reach the client before io.close', async () => {
		expect(await closeBehindABigSend(true)).toEqual(['big', 'restarting']);
	});

	it('is needed: without it io.close discards the queued emit', async () => {
		expect(await closeBehindABigSend(false)).toEqual(['big']);
	});

	it('resolves at once when every transport is writable, and by its bound when one never drains', async () => {
		const idle = { transport: { writable: true }, once: () => undefined };
		const stuck = { transport: { writable: false }, once: () => undefined };
		await expect(flushed([idle], 60_000)).resolves.toBeUndefined();
		const started = Date.now();
		await flushed([stuck], 50);
		expect(Date.now() - started).toBeGreaterThanOrEqual(45);
	});
});
