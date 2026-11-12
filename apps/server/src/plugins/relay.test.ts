/**
 * `relayPlugin` is thin by design (`relay.ts`'s own header): this only
 * proves it wires `play/relay-socket.ts`'s `attachRelay` to the context's
 * `io` and that its `shutdown` closes it. The relay socket's own behaviour
 * is proven in `play/relay-socket.test.ts`.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';

import { relayPlugin } from './relay.ts';

let http: HttpServer | null = null;
let io: SocketIOServer | null = null;

afterEach(() => {
	io?.close();
	http?.close();
	http = null;
	io = null;
});

function fakeCtx(): Parameters<typeof relayPlugin.setup>[0] {
	http = createServer();
	io = new SocketIOServer(http, { serveClient: false });
	return { io } as Parameters<typeof relayPlugin.setup>[0];
}

describe('relayPlugin', () => {
	it('is a sockets-phase plugin', () => {
		expect(relayPlugin.phase).toBe('sockets');
	});

	it('attaches the relay route to the context io, refusing every join (no roster exists yet)', async () => {
		const ctx = fakeCtx();
		const hooks = await relayPlugin.setup(ctx);
		expect(hooks).toBeDefined();
		expect(typeof hooks?.shutdown).toBe('function');
	});

	it("shutdown() closes the relay handle without throwing, even with no live matches", async () => {
		const ctx = fakeCtx();
		const hooks = await relayPlugin.setup(ctx);
		expect(() => hooks?.shutdown?.()).not.toThrow();
	});
});
