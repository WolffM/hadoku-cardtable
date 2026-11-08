/*
 * Unit-level: real socket.io/socket.io-client integration (the regression this guards —
 * `io.close()` discarding a queued emit) lives next to cardtable's adapter, which already
 * carries `socket.io-client` as a devDependency; the kernel does not (`packages/service-kernel`
 * depends only on node built-ins, express, socket.io and `@wolffm/*`). These tests exercise the
 * same logic against hand-rolled `Flushable`/`Closable` stand-ins.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeConnections, sendThenFlush, type Closable, type Flushable } from './flush-sockets.ts';

function flushable(): Flushable & EventEmitter {
	return new EventEmitter() as Flushable & EventEmitter;
}

describe('sendThenFlush', () => {
	it('resolves at once when every connection flushed synchronously during send', async () => {
		const a = flushable();
		const b = flushable();
		const started = Date.now();
		await sendThenFlush([a, b], () => {
			a.emit('flush');
			b.emit('flush');
		}, 5_000);
		expect(Date.now() - started).toBeLessThan(200);
	});

	it('waits for drain on a connection that did not flush synchronously', async () => {
		const a = flushable();
		let resolved = false;
		const p = sendThenFlush([a], () => undefined, 5_000).then(() => (resolved = true));
		// Nothing but the 'drain' this never gets can resolve `p`: give the microtask queue a few
		// turns (no timer, no sleep) and it is still pending.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(resolved).toBe(false);
		a.emit('drain');
		await p;
		expect(resolved).toBe(true);
	});

	it('a close also counts as flushed (the connection is gone, nothing left to write)', async () => {
		const a = flushable();
		const p = sendThenFlush([a], () => undefined, 5_000);
		a.emit('close');
		await p;
	});

	it('resolves by its bound when a connection never drains', async () => {
		const stuck = { once: () => undefined, on: () => undefined, off: () => undefined };
		const started = Date.now();
		await sendThenFlush([stuck], () => undefined, 50);
		expect(Date.now() - started).toBeGreaterThanOrEqual(45);
	});

	it('removes its own flush listener once send returns, even if send throws', () => {
		const a = flushable();
		expect(a.listenerCount('flush')).toBe(0);
		expect(() =>
			sendThenFlush(
				[a],
				() => {
					throw new Error('boom');
				},
				50,
			),
		).toThrow('boom');
		expect(a.listenerCount('flush')).toBe(0);
	});
});

describe('closeConnections', () => {
	afterEach(() => vi.useRealTimers());

	it('closes idle connections at once, and the rest only after the grace', () => {
		vi.useFakeTimers();
		const server: Closable = { closeIdleConnections: vi.fn(), closeAllConnections: vi.fn() };
		closeConnections(server, 100);
		expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
		expect(server.closeAllConnections).not.toHaveBeenCalled();
		vi.advanceTimersByTime(99);
		expect(server.closeAllConnections).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
	});
});
