/*
 * Tests for cardtable's own bindings in `kernel.ts`, plus the real-integration and
 * cardtable-pin coverage carried over from the pure re-export stubs this wave deleted
 * (`flush-sockets.ts`, `state-dir.ts` — w93-Z). The generic behaviour each stub re-exported
 * is proved in `@hadoku/service-kernel`'s own suite now; what stays here is coverage this
 * app's own dependencies or env names made specific.
 */
import { Agent, createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeConnections, sendThenFlush } from '@hadoku/service-kernel/lifecycle';
import { moveLegacyState } from '@hadoku/service-kernel/state';

/**
 * Real socket.io/socket.io-client integration (the regression this guards — `io.close()`
 * discarding a queued emit): this app already carries `socket.io-client` as a devDependency;
 * the kernel does not (`packages/service-kernel` depends only on node built-ins, express,
 * socket.io and `@wolffm/*`), so this integration-depth proof stays here, at the app layer,
 * against the kernel's own exported functions.
 */
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

describe('sendThenFlush (real socket.io)', () => {
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

// Prod 2026-11-06 16:00Z: the old server was still answering a second after `shutdown-begin`, and pm2
// SIGKILLed it at its 1.6 s kill_timeout before `shutdown-done`. `server.close` waits for every open
// connection; a response that never ends (a stream, a held request) holds it forever.
describe('closeConnections (real http.Server)', () => {
	it('a connection whose response never ends does not hold the close: the server closes after the grace', async () => {
		const server = createServer((_req, res) => res.write('streaming'));
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const { port } = server.address() as AddressInfo;
		const agent = new Agent({ keepAlive: true });
		await new Promise<void>((r) => {
			const req = request({ host: '127.0.0.1', port, agent }, (res) => {
				res.once('data', () => r());
				res.on('error', () => {});
			});
			req.on('error', () => {});
			req.end();
		});
		const began = Date.now();
		let ms: number | null = null;
		server.close(() => (ms = Date.now() - began));
		closeConnections(server, 100);
		try {
			await vi.waitFor(() => expect(ms, 'closed, not held open by the stream').not.toBeNull(), { timeout: 1000, interval: 20 });
		} finally {
			agent.destroy();
		}
		// libuv's loop clock is whole milliseconds, so a 100 ms timer can fire up to 1 ms early by Date.now.
		expect(ms).toBeGreaterThanOrEqual(99);
		expect(ms).toBeLessThan(600);
	});
});

describe('moveLegacyState (adapter smoke test)', () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'cardtable-state-'));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it('moves the in-clone data/ into a state dir through cardtable\'s own import path', () => {
		const legacy = { dataDir: join(root, 'clone/data'), logDir: join(root, 'clone/logs') };
		mkdirSync(legacy.dataDir, { recursive: true });
		writeFileSync(join(legacy.dataDir, 'tournaments.json'), '[]');
		mkdirSync(legacy.logDir, { recursive: true });
		const state = join(root, 'state');
		const log = vi.fn();
		const moves = moveLegacyState({ stateDir: state, dataDir: state, logDir: join(state, 'logs') }, legacy, log);
		expect(moves.map((m) => m.moved)).toEqual([['tournaments.json'], []]);
	});
});

describe('CONFIG with CARDTABLE_STATE_DIR', () => {
	const KEYS = ['CARDTABLE_STATE_DIR', 'CARDTABLE_LOG_DIR', 'CARDTABLE_ROOMS_DIR', 'CARDTABLE_RECORDINGS_DIR'] as const;
	const saved: Partial<Record<(typeof KEYS)[number], string>> = {};
	beforeEach(() => {
		for (const k of KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
		vi.resetModules();
	});
	afterEach(() => {
		for (const k of KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it('puts data directly in the state dir and logs in its logs/', async () => {
		process.env.CARDTABLE_STATE_DIR = '/srv-data/cardtable';
		const { CONFIG } = await import('./config.ts');
		expect(CONFIG.stateDir).toBe('/srv-data/cardtable');
		expect(CONFIG.dataDir).toBe('/srv-data/cardtable');
		expect(CONFIG.logDir).toBe('/srv-data/cardtable/logs');
		expect(CONFIG.roomsDir).toBe('/srv-data/cardtable/rooms');
		expect(CONFIG.recordingsDir).toBe('/srv-data/cardtable/recordings');
		expect(CONFIG.callersSeenFile).toBe('/srv-data/cardtable/callers-seen.json');
	});

	it('keeps the in-clone layout when unset, and a per-path env still wins', async () => {
		process.env.CARDTABLE_ROOMS_DIR = '/elsewhere/rooms';
		const { CONFIG, LEGACY_STATE } = await import('./config.ts');
		expect(CONFIG.stateDir).toBe('');
		expect(CONFIG.dataDir).toBe(LEGACY_STATE.dataDir);
		expect(CONFIG.logDir).toBe(LEGACY_STATE.logDir);
		expect(CONFIG.roomsDir).toBe('/elsewhere/rooms');
	});

	it('an explicit CARDTABLE_LOG_DIR still wins over the state dir', async () => {
		process.env.CARDTABLE_STATE_DIR = '/srv-data/cardtable';
		process.env.CARDTABLE_LOG_DIR = '/var/log/cardtable';
		const { CONFIG } = await import('./config.ts');
		expect(CONFIG.logDir).toBe('/var/log/cardtable');
		expect(CONFIG.dataDir).toBe('/srv-data/cardtable');
	});
});
