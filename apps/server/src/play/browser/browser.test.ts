/**
 * The browser bridge, end to end: a real HTTP server on an ephemeral loopback
 * port, real browser `WebSocket` clients (Node's own built-in one — the same
 * implementation a browser ships, not a mock of one), and a match whose Forge
 * is the recorded REAL transcript `fixtures/bridge-two-seats.ndjson` replayed
 * through `ReplayHost`.
 *
 * ## The assertion that matters
 *
 * `jvm.test.ts` measured, against a real Forge, every identifying string of
 * every card hidden from a seat, found all of them in Forge's raw stream and
 * **none** in what reached that seat. This suite makes the same measurement
 * over the BYTES a browser received off the WebSocket, for the same recorded
 * stream, and adds a negative control the socket.io suite does not have: the
 * bytes that lawfully reached seat 1 are searched for seat 0's secrets and
 * **must** be found. That is the illegal cross-seat read, spelled as data — if
 * seat 0's connection were ever handed seat 1's stream, this suite's leak
 * assertion is the thing that fires.
 *
 * So the suite fails if:
 *
 *   - the per-seat projection is disabled (the raw stream reaches a browser);
 *   - `BrowserFanout.deliver` or `BrowserSession.push` stops checking the seat
 *     (one seat's envelopes reach the other's connection);
 *   - the leak oracle itself stops finding anything (the negative control).
 *
 * ## The one line this suite supplies that production does not yet have
 *
 * `emit: (match, seat, envelope) => fanout.deliver(match.id, seat, envelope)`
 * in `boot()` below. In production that call belongs inside the `emit` closure
 * `play/socket.ts` passes to `createMatchRegistry`, which is not this lane's
 * file. See `fanout.ts`'s header.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClientFrameSchema } from '@hadoku/forge-wire';

import type { BridgeLine } from '../host.js';
import { createMatchRegistry, type Match, type MatchRegistry } from '../match.js';
import { leaked, loadTranscript, rawStatesOf, replayFactory, secretsFor, type ReplayHost } from '../fixtures/transcript.js';
import { BrowserFanout } from './fanout.js';

const EDGE_SECRET = 'browser-bridge-test-edge-secret';

let bridgeMod: typeof import('./index.ts');
let transportMod: typeof import('../transport.ts');

beforeAll(async () => {
	// config.ts reads the environment once, at load — see socket.test.ts.
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	bridgeMod = await import('./index.ts');
	transportMod = await import('../transport.ts');
});

const TRANSCRIPT = loadTranscript();
const PROBE_AT = TRANSCRIPT.findIndex((l) => l.t === 'frame' && (l.frame as { kind: string }).kind === 'ask');
const OPENING = TRANSCRIPT.slice(0, PROBE_AT);
const PROBE_ASK = TRANSCRIPT[PROBE_AT] as Extract<BridgeLine, { t: 'frame' }>;
const AFTER_PROBE = TRANSCRIPT.slice(PROBE_AT + 1);

const TWO_HUMANS = {
	seats: [
		{ name: 'Seat 1', ai: false, deck: null },
		{ name: 'Seat 2', ai: false, deck: null },
	],
} as const;

/* ── Harness ─────────────────────────────────────────────────────────── */

interface Harness {
	port: number;
	hosts: ReplayHost[];
	fanout: BrowserFanout;
	bridge: import('./index.ts').BrowserBridgeHandle;
	logs: Record<string, unknown>[];
	registry: MatchRegistry;
	create(): Match;
	close(): Promise<void>;
}

let harness: Harness | null = null;
const openPeers: Peer[] = [];
const openRawSockets: Socket[] = [];

afterEach(async () => {
	for (const p of openPeers.splice(0)) p.close();
	for (const s of openRawSockets.splice(0)) s.destroy();
	if (harness !== null) await harness.close();
	harness = null;
});

async function boot(minTier = 'friend'): Promise<Harness> {
	const { factory, hosts } = replayFactory();
	const logs: Record<string, unknown>[] = [];
	const fanout = new BrowserFanout();
	const http: HttpServer = createServer((_req, res) => res.end());
	const registry = createMatchRegistry({
		host: factory,
		log: (e) => logs.push(e),
		overGraceMs: 60_000,
		// ── THE ONE LINE OF WIRING THAT LIVES OUTSIDE THIS LANE ──────────
		// In production this body is `play/socket.ts`'s, and it calls
		// `emitPerRecipient` over the socket.io room. The browser bridge needs
		// this one statement added in front of it.
		emit: (match, seat, envelope) => fanout.deliver(match.id, seat, envelope),
	});
	const bridge = bridgeMod.attachBrowserBridge(http, {
		minTier,
		matches: () => registry,
		fanout,
		log: (e) => logs.push(e),
		joinWaitMs: 1000,
	});
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	harness = {
		port: (http.address() as AddressInfo).port,
		hosts,
		fanout,
		bridge,
		logs,
		registry,
		create: () => registry.create({ seats: [{ ...TWO_HUMANS.seats[0] }, { ...TWO_HUMANS.seats[1] }] }),
		close: async () => {
			bridge.close();
			registry.stopAll();
			// `close()`'s CALLBACK is not awaited, and that is measured, not lazy:
			// once an `upgrade` event has been emitted and declined, node never
			// runs it — the detached socket is never subtracted from the server's
			// connection count, so `close(cb)` hangs for the process's life even
			// after the peer is destroyed and `closeAllConnections()` has run
			// (node v24.18.0, reproduced in 20 lines). `close()` itself releases
			// the listening handle synchronously, which is what the next test
			// needs; `unref()` makes sure nothing keeps the worker alive.
			http.closeAllConnections();
			http.close();
			http.unref();
			await new Promise((r) => setTimeout(r, 0));
		},
	};
	return harness;
}

function edgeHeaders(user: string, tier = 'friend'): Record<string, string> {
	return {
		'x-edge-auth': EDGE_SECRET,
		'x-hadoku-tier': tier,
		'x-user-id': `browser-device-${user}`,
		'x-user-key': `friend-key-${user}`,
	};
}

/* ── A browser-shaped peer ───────────────────────────────────────────── */

interface WireMessage {
	t: string;
	rid?: string | null;
	[key: string]: unknown;
}

interface Peer {
	ws: WebSocket;
	/** Every message, parsed, in arrival order. */
	messages: WireMessage[];
	/** Every text frame, exactly as it came off the socket. */
	raw: string[];
	request(t: 'join' | 'resync', matchId: string): Promise<WireMessage>;
	send(message: unknown): void;
	/** The `s2c` messages only. */
	frames(): WireMessage[];
	/** Everything this browser was sent, as bytes. */
	transcript(): string;
	close(): void;
}

function connect(port: number, headers: Record<string, string>): Promise<Peer> {
	return new Promise((done, fail) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}${bridgeMod.BROWSER_WS_PATH}`, { headers });
		const messages: WireMessage[] = [];
		const raw: string[] = [];
		const waiters: ((m: WireMessage) => boolean)[] = [];
		let rids = 0;
		// Registered BEFORE the listener that runs it: the bridge greets the
		// moment the 101 is written, so a waiter armed in `open` can miss it.
		waiters.push((m) => {
			if (m.t !== 'hello') return false;
			openPeers.push(peer);
			done(peer);
			return true;
		});
		ws.addEventListener('message', (event) => {
			const text = String(event.data);
			raw.push(text);
			const parsed = JSON.parse(text) as WireMessage;
			messages.push(parsed);
			for (let i = waiters.length - 1; i >= 0; i--) if ((waiters[i] as (m: WireMessage) => boolean)(parsed)) waiters.splice(i, 1);
		});
		ws.addEventListener('error', () => fail(new Error('websocket refused')));
		const peer: Peer = {
			ws,
			messages,
			raw,
			send: (message) => ws.send(JSON.stringify(message)),
			frames: () => messages.filter((m) => m.t === 's2c'),
			transcript: () => raw.join('\n'),
			close: () => ws.close(),
			request(t, matchId) {
				const rid = `r-${(rids += 1)}`;
				return new Promise<WireMessage>((answer, refuse) => {
					const timer = setTimeout(() => refuse(new Error(`no answer to ${t} ${rid}`)), 5000);
					waiters.push((m) => {
						if (m.rid !== rid) return false;
						clearTimeout(timer);
						answer(m);
						return true;
					});
					ws.send(JSON.stringify({ t, rid, matchId }));
				});
			},
		};
	});
}

/** A `showErrorDialog` notify carrying a marker string, for tracing who received what. */
function marked(matchId: string, epoch: string, text: string): ReturnType<typeof transportMod.ServerEnvelopeSchema.parse> {
	return transportMod.ServerEnvelopeSchema.parse({
		matchId,
		cursor: { epoch, seq: 9999 },
		frame: { kind: 'notify', method: 'showErrorDialog', title: 'fanout probe', message: text },
	});
}

/** A message with its `t`/`rid` wrapper off — what `transport.ts`'s strict schemas take. */
function body(message: WireMessage): Record<string, unknown> {
	const { t: _t, rid: _rid, ...rest } = message;
	return rest;
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

/** Two joined browsers on a running match, the opening already streamed. */
async function twoSeats(): Promise<{ h: Harness; matchId: string; host: ReplayHost; alice: Peer; bob: Peer }> {
	const h = await boot();
	const match = h.create();
	const host = h.hosts[0] as ReplayHost;
	host.push(...OPENING);
	const alice = await connect(h.port, edgeHeaders('alice'));
	const bob = await connect(h.port, edgeHeaders('bob'));
	return { h, matchId: match.id, host, alice, bob };
}

/* ── The gate ────────────────────────────────────────────────────────── */

describe('the friend gate, re-applied to a WebSocket upgrade', () => {
	it('refuses a handshake the edge did not vouch for — the upgrade never completes', async () => {
		const h = await boot('friend');
		// No x-edge-auth: `sanitizeHeaders` pins the request to `public`, which is
		// below the floor. An `upgrade` event runs no express middleware, so this
		// is the bridge's own re-application of the gate and nothing else.
		await expect(connect(h.port, { 'x-hadoku-tier': 'admin', 'x-user-id': 'liar' })).rejects.toThrow();
		expect(h.bridge.connections()).toBe(0);
		expect(h.fanout.size).toBe(0);
	});

	it('accepts a vouched friend, and leaves a path that is not its own alone', async () => {
		const h = await boot('friend');
		const alice = await connect(h.port, edgeHeaders('alice'));
		expect(alice.messages[0]).toEqual({ t: 'hello', protocol: bridgeMod.BROWSER_PROTOCOL_VERSION });
		expect(h.bridge.connections()).toBe(1);

		// A path that is not ours is left entirely alone — no 101, no refusal,
		// no connection. In production engine.io's own `upgrade` listener is the
		// one that answers `/socket.io/`; this handler must not answer for it,
		// and must not destroy a socket it did not take.
		const other = netConnect(h.port, '127.0.0.1');
		openRawSockets.push(other);
		let answered = '';
		other.on('data', (chunk) => {
			answered += chunk.toString('latin1');
		});
		await new Promise<void>((done) => other.on('connect', () => done()));
		other.write(
			'GET /socket.io/ HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
				'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Version: 13\r\n\r\n',
		);
		await new Promise((r) => setTimeout(r, 300));
		expect(answered).toBe('');
		expect(h.bridge.connections()).toBe(1);
	});
});

/* ── join → a projected frame → an act ───────────────────────────────── */

describe('a browser client through the bridge', () => {
	it('joins, is seated by the same claim the socket.io path uses, and gets that seat\'s projected snapshot', async () => {
		const { matchId, alice, bob } = await twoSeats();
		const a = await alice.request('join', matchId);
		const b = await bob.request('join', matchId);
		expect([a.t, b.t]).toEqual(['snapshot', 'snapshot']);
		expect([a.seat, a.playerId, b.seat, b.playerId]).toEqual([0, 0, 1, 1]);
		// The snapshot is the seat's own projected history, whole.
		const snapshot = transportMod.MatchSnapshotSchema.parse(body(a));
		expect(snapshot.frames.length).toBeGreaterThan(0);
		expect(snapshot.frames.map((f) => f.method)).toContain('openView');
		expect((snapshot.cursor as { seq: number }).seq).toBeGreaterThan(0);
	});

	it('receives live projected frames on its own contiguous cursor, and nothing for the other seat', async () => {
		const { h, matchId, alice, bob, host } = await twoSeats();
		const a = (await alice.request('join', matchId)) as unknown as { cursor: { seq: number; epoch: string } };
		await bob.request('join', matchId);
		// The join re-sends the prompt and buttons of the moment after the snapshot.
		await waitUntil(() => alice.frames().length >= 2 && bob.frames().length >= 2, 'the post-snapshot re-sends');
		host.push(PROBE_ASK, ...AFTER_PROBE);
		// the transcript's own closing window (seat 1's opening
		// Upkeep priority) is auto-passed — Upkeep is not a stop phase — so
		// `match.ts` withholds it whole: neither of its two bridge frames is
		// emitted. Read off the log, never guessed — see `socket.test.ts`'s
		// own identical fix for the full reasoning.
		await waitUntil(() => h.logs.some((l) => l.evt === 'prompt-withheld'), 'the withheld window to be decided');
		const withheld = h.logs.filter((l) => l.evt === 'prompt-withheld') as { seat: number }[];
		const expected = [0, 1].map((seat) => {
			const bridgeCount = TRANSCRIPT.slice(PROBE_AT).filter((l) => l.t === 'frame' && l.seat === seat).length;
			const withheldForSeat = withheld.filter((w) => w.seat === seat).length * 2;
			return bridgeCount - withheldForSeat;
		});
		await waitUntil(
			() => alice.frames().length >= 2 + (expected[0] ?? 0) && bob.frames().length >= 2 + (expected[1] ?? 0),
			'every live frame',
		);
		const envelopes = alice.frames().map((f) => transportMod.ServerEnvelopeSchema.parse(body(f)));
		expect(envelopes.map((e) => e.cursor.seq)).toEqual(envelopes.map((_, k) => a.cursor.seq + k + 1));
		expect(new Set(envelopes.map((e) => e.cursor.epoch))).toEqual(new Set([a.cursor.epoch]));
		expect(new Set(envelopes.map((e) => e.matchId))).toEqual(new Set([matchId]));
		// The transcript's one ask is seat 0's. It reached seat 0 and only seat 0.
		expect(alice.frames().filter((f) => (f.frame as { kind: string }).kind === 'ask')).toHaveLength(1);
		expect(bob.frames().filter((f) => (f.frame as { kind: string }).kind === 'ask')).toHaveLength(0);
	});

	it('carries an act to Forge as the seat that sent it, and a reply by callId', async () => {
		const { matchId, alice, bob, host } = await twoSeats();
		await alice.request('join', matchId);
		await bob.request('join', matchId);
		host.push(PROBE_ASK);
		await waitUntil(() => alice.frames().some((f) => (f.frame as { kind: string }).kind === 'ask'), 'the ask');
		const ask = alice.frames().find((f) => (f.frame as { kind: string }).kind === 'ask')?.frame as { callId: string };

		alice.send({ t: 'c2s', matchId, frame: ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }) });
		bob.send({ t: 'c2s', matchId, frame: ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }) });
		alice.send({
			t: 'c2s',
			matchId,
			frame: ClientFrameSchema.parse({ kind: 'reply', callId: ask.callId, method: 'showConfirmDialog', result: true }),
		});
		await waitUntil(() => host.commands.length >= 3, 'the commands to reach the bridge');
		expect(host.commands.filter((c) => c.t === 'act').map((c) => (c as { seat: number }).seat)).toEqual([0, 1]);
		expect(host.commands.find((c) => c.t === 'reply')).toEqual({ t: 'reply', seat: 0, callId: ask.callId, result: true });
	});

	it('refuses a third person, an unknown match, and a resync or an act from a connection that never joined', async () => {
		const { h, matchId, alice, bob, host } = await twoSeats();
		await alice.request('join', matchId);
		await bob.request('join', matchId);
		const carol = await connect(h.port, edgeHeaders('carol'));
		expect(await carol.request('join', matchId)).toMatchObject({ error: 'match-full' });
		expect(await carol.request('join', 'm-000000000000')).toMatchObject({ error: 'unknown-match' });
		expect(await carol.request('resync', matchId)).toMatchObject({ error: 'not-joined' });
		const before = host.commands.length;
		carol.send({ t: 'c2s', matchId, frame: ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }) });
		await new Promise((r) => setTimeout(r, 100));
		expect(host.commands.length).toBe(before);
		// An unseated connection was never handed one byte of the match.
		expect(carol.frames()).toEqual([]);
	});

	it('refuses a malformed message through the same parser the socket.io path uses', async () => {
		const { matchId, alice } = await twoSeats();
		await alice.request('join', matchId);
		const mark = alice.messages.length;
		alice.ws.send('{ not json');
		alice.send({ t: 'c2s', matchId, frame: { kind: 'act', method: 'noSuchMethod' } });
		alice.send({ t: 'join', matchId, extra: 'field' });
		await waitUntil(() => alice.messages.slice(mark).filter((m) => m.t === 'error').length >= 3, 'three refusals');
		// Each refusal names where it failed, in `transport.ts`'s own wording.
		const errors = alice.messages.slice(mark).filter((m) => m.t === 'error');
		expect(errors.every((m) => typeof m.error === 'string' && (m.error as string).length > 0)).toBe(true);
	});
});

/* ── Hidden information ──────────────────────────────────────────────── */

describe('hidden information, over the bytes a browser received', () => {
	it("never puts one byte of the other seat's hidden cards on a browser's WebSocket — and the same check fires on a cross-seat read", async () => {
		const { matchId, alice, bob, host } = await twoSeats();
		await alice.request('join', matchId);
		await bob.request('join', matchId);
		host.push(PROBE_ASK, ...AFTER_PROBE);
		await waitUntil(() => alice.frames().length > 0 && bob.frames().length > 0, 'live frames to both browsers');
		await alice.request('resync', matchId);
		await bob.request('resync', matchId);

		const secretsOf = (seat: number): Set<string> => secretsFor(rawStatesOf(TRANSCRIPT, seat), seat).secrets;
		const peers = [alice, bob] as const;
		for (const seat of [0, 1] as const) {
			const secrets = secretsOf(seat);
			const raw = TRANSCRIPT.filter((l) => l.t === 'frame' && l.seat === seat).map((l) => JSON.stringify(l)).join('\n');
			const got = (peers[seat] as Peer).transcript();
			console.log(
				`[browser] seat ${seat}: ${(peers[seat] as Peer).raw.length} messages, ${got.length} bytes, ${secrets.size} secrets, ` +
					`${leaked(secrets, raw).length} in Forge's raw stream, ${leaked(secrets, got).length} in what the browser received`,
			);
			expect(secrets.size).toBeGreaterThan(0);
			// Forge's own stream carries every one of them. The projection is the
			// only thing between that and this browser.
			expect(leaked(secrets, raw).length).toBe(secrets.size);
			expect(leaked(secrets, got)).toEqual([]);
		}

		// The negative control, and the "illegal cross-seat read" of the brief:
		// the bytes that lawfully reached seat 1 ARE a leak when measured against
		// seat 0's secrets. So the assertion above is not vacuous — had seat 0's
		// connection been handed seat 1's stream, it would have failed.
		const crossed = leaked(secretsOf(0), bob.transcript());
		console.log(`[browser] cross-seat control: ${crossed.length} of seat 0's secrets are present in seat 1's own bytes`);
		expect(crossed.length).toBeGreaterThan(0);
		expect(leaked(secretsOf(1), alice.transcript()).length).toBeGreaterThan(0);
	});

	it('hands a frame built for one seat to no other connection, even one that holds a seat in the same match', async () => {
		const { h, matchId, alice, bob } = await twoSeats();
		const a = await alice.request('join', matchId);
		await bob.request('join', matchId);
		const epoch = (a.cursor as { epoch: string }).epoch;

		// Straight at the fan-out, past `Match`: the seat check is the fan-out's
		// and the session's own, not something only `Match` happens to get right.
		expect(h.fanout.deliver(matchId, 0, marked(matchId, epoch, 'MARK-SEAT-0'))).toBe(1);
		// A seat nobody in this match holds, and a match nobody here joined.
		expect(h.fanout.deliver(matchId, 7, marked(matchId, epoch, 'MARK-NOBODY'))).toBe(0);
		expect(h.fanout.deliver('m-000000000000', 0, marked('m-000000000000', epoch, 'MARK-OTHER-MATCH'))).toBe(0);

		await waitUntil(() => alice.transcript().includes('MARK-SEAT-0'), 'seat 0 to receive its own frame');
		expect(bob.transcript()).not.toContain('MARK-SEAT-0');
		expect(alice.transcript()).not.toContain('MARK-NOBODY');
		expect(bob.transcript()).not.toContain('MARK-NOBODY');
		expect(alice.transcript()).not.toContain('MARK-OTHER-MATCH');
	});

	it("refuses, in the session itself, an envelope for a match the connection holds no seat in", async () => {
		// The fan-out's filter would hide this: `deliver` never offers a session
		// an envelope for a match it is not in, so `push`'s own check is only
		// reachable by calling it. Two independent guards are worth two tests.
		const h = await boot();
		const match = h.create();
		(h.hosts[0] as ReplayHost).push(...OPENING);
		const sent: import('./index.ts').BrowserMessage[] = [];
		const session = new bridgeMod.BrowserSession({
			matches: () => h.registry,
			participantId: 'fk:dddddddddddddddd' as Parameters<Match['claim']>[0],
			send: (message) => sent.push(message),
			log: () => {},
			fanout: h.fanout,
			joinWaitMs: 1000,
		});
		// Not joined anywhere yet: every envelope is refused and nothing is written.
		expect(session.seatIn(match.id)).toBeNull();
		expect(session.push(marked(match.id, 'e', 'NOPE'))).toBe(false);
		expect(sent).toEqual([]);

		await session.handle(JSON.stringify({ t: 'join', rid: 'j1', matchId: match.id }));
		expect(sent.filter((m) => m.t === 'snapshot')).toHaveLength(1);
		expect(session.seatIn(match.id)).toBe(0);
		// The seat it holds — written. Another match — refused, even though this
		// connection is joined to something.
		expect(session.push(marked(match.id, 'e', 'YES'))).toBe(true);
		expect(session.push(marked('m-000000000000', 'e', 'NOPE'))).toBe(false);
		expect(JSON.stringify(sent)).toContain('YES');
		expect(JSON.stringify(sent)).not.toContain('NOPE');
		session.disconnect('test');
		expect(session.push(marked(match.id, 'e', 'NOPE'))).toBe(false);
	});
});

/* ── The frame codec ─────────────────────────────────────────────────── */

/**
 * The hand-written RFC 6455 reader, driven from a raw TCP socket because a
 * browser `WebSocket` will not fragment a small message, send a ping or send a
 * binary frame on demand — and those are exactly the paths `ws.ts` has to get
 * right on its own.
 */
function rawHandshake(port: number, headers: Record<string, string>): Promise<{ socket: Socket; read: () => Buffer }> {
	return new Promise((done) => {
		const socket = netConnect(port, '127.0.0.1', () => {
			const key = randomBytes(16).toString('base64');
			const lines = [
				`GET ${bridgeMod.BROWSER_WS_PATH} HTTP/1.1`,
				'Host: 127.0.0.1',
				'Upgrade: websocket',
				'Connection: Upgrade',
				`Sec-WebSocket-Key: ${key}`,
				'Sec-WebSocket-Version: 13',
				...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
			];
			socket.write(`${lines.join('\r\n')}\r\n\r\n`);
			let seen = Buffer.alloc(0);
			socket.on('data', (chunk) => {
				seen = Buffer.concat([seen, chunk]);
			});
			const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'utf8').digest('base64');
			const wait = setInterval(() => {
				if (!seen.includes('\r\n\r\n')) return;
				clearInterval(wait);
				expect(seen.toString('latin1')).toContain('101 Switching Protocols');
				expect(seen.toString('latin1')).toContain(`Sec-WebSocket-Accept: ${accept}`);
				// We negotiate no extension, so the handshake must not echo one.
				expect(seen.toString('latin1').toLowerCase()).not.toContain('sec-websocket-extensions');
				done({ socket, read: () => seen });
			}, 5);
		});
		openRawSockets.push(socket);
	});
}

/**
 * The server's own frames, parsed out of everything a raw peer received. Server
 * frames are never masked, so this is the same reader inverted — and it is how
 * a close CODE is read, which is not simply the last two bytes on the wire: the
 * close payload is the code followed by the reason text.
 */
function serverFrames(seen: Buffer): { opcode: number; payload: Buffer }[] {
	const start = seen.indexOf('\r\n\r\n');
	if (start === -1) return [];
	let at = start + 4;
	const out: { opcode: number; payload: Buffer }[] = [];
	while (at + 2 <= seen.length) {
		const opcode = (seen[at] as number) & 0x0f;
		let length = (seen[at + 1] as number) & 0x7f;
		let offset = at + 2;
		if (length === 126) {
			if (offset + 2 > seen.length) break;
			length = seen.readUInt16BE(offset);
			offset += 2;
		} else if (length === 127) {
			if (offset + 8 > seen.length) break;
			length = Number(seen.readBigUInt64BE(offset));
			offset += 8;
		}
		if (offset + length > seen.length) break;
		out.push({ opcode, payload: seen.subarray(offset, offset + length) });
		at = offset + length;
	}
	return out;
}

/** The close frame's code, or null if the server has not sent one. */
function closeCode(seen: Buffer): number | null {
	const close = serverFrames(seen).find((f) => f.opcode === 0x8);
	return close === undefined || close.payload.length < 2 ? null : close.payload.readUInt16BE(0);
}

function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
	const mask = randomBytes(4);
	const masked = Buffer.from(payload);
	for (let i = 0; i < masked.length; i++) masked[i] = (masked[i] as number) ^ (mask[i % 4] as number);
	const short = masked.length < 126;
	const header = Buffer.alloc(short ? 2 : 4);
	header[0] = (fin ? 0x80 : 0x00) | opcode;
	header[1] = 0x80 | (short ? masked.length : 126);
	if (!short) header.writeUInt16BE(masked.length, 2);
	return Buffer.concat([header, mask, masked]);
}

describe('the RFC 6455 reader', () => {
	it('reassembles a fragmented text message, answers a ping, and closes on a binary frame', async () => {
		const h = await boot();
		const match = h.create();
		(h.hosts[0] as ReplayHost).push(...OPENING);
		const { socket, read } = await rawHandshake(h.port, edgeHeaders('raw'));

		// One join, split across two fragments and a continuation, with a ping in
		// between. The bridge must answer the join exactly once.
		const join = Buffer.from(JSON.stringify({ t: 'join', rid: 'rid-1', matchId: match.id }), 'utf8');
		const cut = Math.floor(join.length / 2);
		socket.write(clientFrame(0x1, join.subarray(0, cut), false));
		socket.write(clientFrame(0x9, Buffer.from('ping-me', 'utf8')));
		socket.write(clientFrame(0x0, join.subarray(cut), true));
		await waitUntil(() => read().includes('rid-1'), 'the answer to the fragmented join', 5000);
		const answer = read().toString('utf8');
		expect(answer).toContain('"t":"snapshot"');
		expect(answer).toContain('ping-me'); // the pong, echoed unmasked
		expect(h.bridge.connections()).toBe(1);

		// A binary frame is not this protocol: close 1003.
		socket.write(clientFrame(0x2, Buffer.from([1, 2, 3])));
		await waitUntil(() => h.bridge.connections() === 0, 'the close on a binary frame', 5000);
		expect(h.fanout.size).toBe(0);
	});

	it('refuses a frame with an RSV bit set, because no extension was negotiated', async () => {
		const h = await boot();
		const { socket, read } = await rawHandshake(h.port, edgeHeaders('raw'));
		// A `permessage-deflate` frame is exactly this: RSV1 on a text frame. The
		// handshake echoed no extension, so it can only be a client that ignored
		// the negotiation — 1002, never a guess at how to inflate it.
		const frame = clientFrame(0x1, Buffer.from('{}', 'utf8'));
		frame[0] = (frame[0] as number) | 0x40;
		socket.write(frame);
		await waitUntil(() => h.bridge.connections() === 0, 'the close on an RSV bit', 5000);
		expect(closeCode(read())).toBe(1002);
	});

	it('refuses a message over the ceiling before it is buffered', async () => {
		const h = await boot();
		const { socket, read } = await rawHandshake(h.port, edgeHeaders('raw'));
		// A 64-bit length header claiming 8 GiB, and not one byte of payload:
		// the ceiling is checked off the header, not after the read.
		const header = Buffer.alloc(14);
		header[0] = 0x81;
		header[1] = 0x80 | 127;
		header.writeBigUInt64BE(8n * 1024n * 1024n * 1024n, 2);
		socket.write(header);
		await waitUntil(() => h.bridge.connections() === 0, 'the close on an oversized message', 5000);
		expect(closeCode(read())).toBe(1009);
	});

	it('refuses an unmasked client frame, which is what a forged server frame would look like', async () => {
		const h = await boot();
		const { socket } = await rawHandshake(h.port, edgeHeaders('raw'));
		const payload = Buffer.from('{"t":"join","matchId":"m-000000000000"}', 'utf8');
		const header = Buffer.alloc(2);
		header[0] = 0x81;
		header[1] = payload.length; // no mask bit
		socket.write(Buffer.concat([header, payload]));
		await waitUntil(() => h.bridge.connections() === 0, 'the close on an unmasked frame', 5000);
	});
});
