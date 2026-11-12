/**
 * `openRelayChannel` against a REAL socket.io server on an ephemeral loopback port, with real
 * `socket.io-client` connections — `socket.io` (the server) is a dependency of `@hadoku/server`,
 * not of `@hadoku/ui`, and this lane does not edit manifests, so it is resolved from the server
 * package's own directory the same way `play/live/replay-server.ts`'s own header explains for the
 * same reason.
 *
 * The fake server below echoes exactly `relay-socket.ts`'s own wire shape (`relay:join` with an
 * ack, `relay:message` relayed to every OTHER joined socket) rather than importing the real
 * module, so this file stays a thin, self-contained proof of `relay-channel.ts`'s OWN behaviour —
 * `relay-socket.test.ts` is where the real server's own semantics are proven.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openRelayChannel } from './relay-channel.ts';

const serverRequire = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../server/package.json'));
const { Server: SocketIOServer } = serverRequire('socket.io') as { Server: new (http: HttpServer, opts?: unknown) => FakeIoServer };

interface FakeIoSocket {
	id: string;
	on(event: string, handler: (payload: unknown, ack?: (res: unknown) => void) => void): void;
	emit(event: string, payload: unknown): void;
}

interface FakeIoServer {
	on(event: 'connection', handler: (socket: FakeIoSocket) => void): void;
	close(): void;
}

interface FakeRelay {
	url: string;
	joins: { matchId: string }[];
	messages: { from: string; msg: unknown }[];
	close(): Promise<void>;
}

/** Echoes `relay-socket.ts`'s own wire shape: `relay:join` acks `{ ok: true, seat: null }`
 *  (every joiner a watcher — this file never needs a seat), and `relay:message` relays to every
 *  OTHER joined socket, never back to the sender — same as `RelaySession.fromSeat`'s own rule. */
async function fakeRelayServer(): Promise<FakeRelay> {
	const http: HttpServer = createServer();
	const io = new SocketIOServer(http, { serveClient: false });
	const joins: { matchId: string }[] = [];
	const messages: { from: string; msg: unknown }[] = [];
	const sockets = new Set<FakeIoSocket>();
	io.on('connection', (socket) => {
		sockets.add(socket);
		socket.on('relay:join', (payload, ack) => {
			joins.push(payload as { matchId: string });
			ack?.({ ok: true, seat: null });
		});
		socket.on('relay:message', (msg) => {
			messages.push({ from: socket.id, msg });
			for (const other of sockets) if (other !== socket) other.emit('relay:message', msg);
			// The host's end, as `relay-socket.ts` sends it: to every socket, the sender's too.
			const over = msg as { t?: unknown; winners?: unknown };
			if (over.t === 'over') for (const any of sockets) any.emit('relay:ended', { winners: over.winners });
		});
	});
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	const port = (http.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		joins,
		messages,
		close: () => {
			io.close();
			return new Promise<void>((done) => http.close(() => done()));
		},
	};
}

const openChannels: { close(): void }[] = [];
afterEach(async () => {
	for (const c of openChannels.splice(0)) c.close();
});

async function waitUntil(predicate: () => boolean, label: string, timeout = 2000): Promise<void> {
	await vi.waitFor(
		() => {
			if (!predicate()) throw new Error(`waiting for ${label}`);
		},
		{ timeout, interval: 5 },
	);
}

describe('openRelayChannel', () => {
	it('joins with { matchId } the moment the socket connects', async () => {
		const server = await fakeRelayServer();
		try {
			const channel = openRelayChannel('room-a', { url: server.url, path: '/socket.io/' });
			openChannels.push(channel as unknown as { close(): void });
			await waitUntil(() => server.joins.length === 1, 'the join to arrive');
			expect(server.joins[0]).toEqual({ matchId: 'room-a' });
		} finally {
			await server.close();
		}
	});

	it("send() relays over relay:message; two channels hear each other, never themselves", async () => {
		const server = await fakeRelayServer();
		try {
			const alice = openRelayChannel('room-a', { url: server.url, path: '/socket.io/' });
			const bob = openRelayChannel('room-a', { url: server.url, path: '/socket.io/' });
			openChannels.push(alice as unknown as { close(): void }, bob as unknown as { close(): void });
			await waitUntil(() => server.joins.length === 2, 'both to join');

			const bobHeard: unknown[] = [];
			const aliceHeard: unknown[] = [];
			bob.on((msg) => bobHeard.push(msg));
			alice.on((msg) => aliceHeard.push(msg));

			alice.send({ hi: 1 });
			await waitUntil(() => bobHeard.length === 1, 'bob to hear alice');
			expect(bobHeard).toEqual([{ hi: 1 }]);
			expect(aliceHeard).toEqual([]);
		} finally {
			await server.close();
		}
	});

	it("onEnded() hears the host's relay:ended on every channel, the over's own sender included", async () => {
		const server = await fakeRelayServer();
		try {
			const alice = openRelayChannel('room-a', { url: server.url, path: '/socket.io/' });
			const bob = openRelayChannel('room-a', { url: server.url, path: '/socket.io/' });
			openChannels.push(alice, bob);
			await waitUntil(() => server.joins.length === 2, 'both to join');
			const aliceEnded: unknown[] = [];
			const bobEnded: unknown[] = [];
			alice.onEnded((w) => aliceEnded.push(w));
			bob.onEnded((w) => bobEnded.push(w));
			alice.send({ t: 'over', winners: [1] });
			await waitUntil(() => aliceEnded.length === 1 && bobEnded.length === 1, 'both to hear the end');
			expect([aliceEnded, bobEnded]).toEqual([[[1]], [[1]]]);
		} finally {
			await server.close();
		}
	});

	it('on() returns an unsubscribe function; after calling it, that handler hears nothing more', async () => {
		const server = await fakeRelayServer();
		try {
			const alice = openRelayChannel('room-a', { url: server.url, path: '/socket.io/' });
			const bob = openRelayChannel('room-a', { url: server.url, path: '/socket.io/' });
			openChannels.push(alice as unknown as { close(): void }, bob as unknown as { close(): void });
			await waitUntil(() => server.joins.length === 2, 'both to join');

			const heard: unknown[] = [];
			const off = bob.on((msg) => heard.push(msg));
			alice.send(1);
			await waitUntil(() => heard.length === 1, 'the first message');
			off();
			alice.send(2);
			await waitUntil(() => server.messages.length === 2, "the server to see bob's second message go out");
			expect(heard).toEqual([1]);
		} finally {
			await server.close();
		}
	});

	it('close() disconnects: no further message is delivered, and nothing throws if called twice', async () => {
		const server = await fakeRelayServer();
		try {
			const alice = openRelayChannel('room-a', { url: server.url, path: '/socket.io/' });
			const bob = openRelayChannel('room-a', { url: server.url, path: '/socket.io/' });
			// A third, still-connected peer: ordering per sender means once IT has heard the marker
			// alice sends after `bob.close()`, the server has already finished processing `bob.close()`'s
			// own disconnect — so checking `heard` right after is a state-based wait, not a sleep.
			const carol = openRelayChannel('room-a', { url: server.url, path: '/socket.io/' });
			openChannels.push(alice as unknown as { close(): void }, carol as unknown as { close(): void });
			await waitUntil(() => server.joins.length === 3, 'all three to join');

			const heard: unknown[] = [];
			bob.on((msg) => heard.push(msg));
			bob.close();
			expect(() => bob.close()).not.toThrow();
			alice.send('after close');
			const carolHeard: unknown[] = [];
			carol.on((msg) => carolHeard.push(msg));
			alice.send('marker');
			await waitUntil(() => carolHeard.includes('marker'), "carol to hear alice's marker");
			expect(heard).toEqual([]);
		} finally {
			await server.close();
		}
	});

	it('joins again on a SECOND real connection to the same channel (the shape a reconnect takes: a fresh socket, same matchId)', async () => {
		// `openRelayChannel`'s own `connect` handler re-sends `relay:join` on every `connect` event,
		// including socket.io's own automatic reconnect — a library guarantee this file leans on
		// rather than re-proves (simulating a real network drop reliably in a unit test is its own
		// can of worms; `relay-fixture.spec.ts`, e2e, exercises a live connection end to end). What
		// IS this file's own to prove is that a second connection for the SAME match joins again,
		// never assuming "already joined once" from anywhere outside the socket itself.
		const server = await fakeRelayServer();
		try {
			const first = openRelayChannel('room-a', { url: server.url, path: '/socket.io/' });
			openChannels.push(first as unknown as { close(): void });
			await waitUntil(() => server.joins.length === 1, 'the first join');
			const second = openRelayChannel('room-a', { url: server.url, path: '/socket.io/' });
			openChannels.push(second as unknown as { close(): void });
			await waitUntil(() => server.joins.length === 2, 'the second connection to join too');
			expect(server.joins).toEqual([{ matchId: 'room-a' }, { matchId: 'room-a' }]);
		} finally {
			await server.close();
		}
	});
});
