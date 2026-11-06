import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { describe, expect, it, vi } from 'vitest';
import { sendThenFlush } from './flush-sockets.ts';

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
	const conns = [...io.sockets.sockets.values()].map((s) => s.conn);
	if (flushFirst) await sendThenFlush(conns, () => io.emit('restarting'), 2_000);
	else io.emit('restarting');
	io.close();
	await dropped;
	return seen;
}

describe('sendThenFlush', () => {
	it('lets an emit queued behind a send in flight reach the client before io.close', async () => {
		expect(await closeBehindABigSend(true)).toEqual(['big', 'restarting']);
	});

	it('is needed: without it io.close discards the queued emit', async () => {
		expect(await closeBehindABigSend(false)).toEqual(['big']);
	});

	it('waits for no connection that wrote the emit at once: a poll just answered is not held to the bound', async () => {
		const http = createServer();
		const io = new Server(http);
		await new Promise<void>((up) => http.listen(0, '127.0.0.1', up));
		const { port } = http.address() as { port: number };
		const client = ioClient(`http://127.0.0.1:${port}`, { transports: ['polling'], reconnection: false });
		const heard = new Promise<void>((done) => client.once('restarting', () => done()));
		await new Promise<void>((up) => client.once('connect', () => up()));
		const conns = [...io.sockets.sockets.values()].map((s) => s.conn);
		// A poll held open: the emit answers it, and the transport is then busy with nothing left to write.
		await vi.waitFor(() => expect(conns.map((c) => c.transport.writable)).toEqual([true]));
		const started = Date.now();
		await sendThenFlush(conns, () => io.emit('restarting'), 5_000);
		expect(conns.map((c) => c.transport.writable)).toEqual([false]);
		expect(Date.now() - started).toBeLessThan(1_000);
		await heard;
		client.close();
		io.close();
	});

	it('resolves by its bound when a connection never drains', async () => {
		const stuck = { once: () => undefined, on: () => undefined, off: () => undefined };
		const started = Date.now();
		await sendThenFlush([stuck], () => undefined, 50);
		expect(Date.now() - started).toBeGreaterThanOrEqual(45);
	});
});
