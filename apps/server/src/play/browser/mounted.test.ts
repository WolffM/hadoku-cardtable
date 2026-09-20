/**
 * The bridge as `src/index.ts` MOUNTS it — not as a unit call into
 * `attachBrowserBridge`.
 *
 * `browser.test.ts` proves the bridge itself: it builds its own HTTP server,
 * its own registry and its own fanout, and drives real WebSockets at them. All
 * of that stayed true for a whole wave while **nothing in production imported
 * the module**, which is the exact failure mode this suite exists to close. So
 * this one never constructs a bridge for its own convenience. It asks two
 * questions instead:
 *
 *   1. **Is the endpoint reachable in a server started from `src/index.ts`?**
 *      `src/index.ts` is spawned as a real child process under `tsx`, on an
 *      ephemeral loopback port, with a real `EDGE_AUTH_SECRET` — and a real
 *      browser `WebSocket` upgrade is driven against it. Nothing in this file
 *      can make that pass except `index.ts` calling `attachBrowserBridge`.
 *
 *   2. **Does a browser get through join → a projected frame → an act, and can
 *      it reach the other seat's hidden state?** That needs a match, and a
 *      match needs Forge, so the second half assembles the SAME call shape
 *      `index.ts` uses — express + `requireMinTier`, one `createServer`, one
 *      socket.io on it, `attachPlay`, then `attachBrowserBridge` reading
 *      `play.matches` lazily — with the recorded REAL transcript
 *      (`fixtures/bridge-two-seats.ndjson`) replayed in place of a JVM.
 *
 * ## What "reachable" is proven by, and what would break each assertion
 *
 * | assertion | what it is the only witness for |
 * | --- | --- |
 * | the 101 and the `hello` | `index.ts` mounts the bridge at all |
 * | `join` → `unknown-match` | `deps.matches` resolves the registry `attachPlay` built. Were the lazy read wrong, the session would answer `play is not configured on this server` |
 * | an unvouched upgrade → **404**, no 101 | the tier floor is re-applied at the upgrade, where express middleware never runs |
 * | `/socket.io/` still handshakes | the second `upgrade` listener did not take engine.io's path with it |
 *
 * ## The wiring that is STILL missing, and is not this lane's file
 *
 * `Match` hands every projected envelope to the `emit` closure
 * `createMatchRegistry` was built with, and there is no later seam. In
 * production that closure is `play/socket.ts`'s, and it does **not** call
 * `browserFanout.deliver`. Until that one statement lands, a mounted browser
 * joins, is seated and is answered — everything below — but no LIVE frame is
 * pushed to it. `fanout.ts`'s header and `README.md` carry the patch.
 *
 * This suite therefore drives `browserFanout.deliver` itself, exactly as
 * `browser.test.ts` does, and says so where it does it. It does not assert the
 * gap, because an assertion that goes red when someone fixes a bug is a trap;
 * it asserts the property that must hold either way — that an envelope built
 * for one seat reaches that seat's connections and no others.
 */

import express from 'express';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { connect as netConnect, createServer as netServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketIOServer } from 'socket.io';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClientFrameSchema } from '@hadoku/forge-wire';

import type { Match } from '../match.js';
import { leaked, loadTranscript, rawStatesOf, replayFactory, secretsFor, type ReplayHost } from '../fixtures/transcript.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TSX = join(PKG_ROOT, 'node_modules', '.bin', 'tsx');
const ENTRY = join(PKG_ROOT, 'src', 'index.ts');
const INDEX_FIXTURE =
	'<!doctype html><html><head><script type="module" src="/cardtable/assets/app.js"></script></head><body>fixture</body></html>';

const EDGE_SECRET = 'mounted-bridge-test-edge-secret';

const TRANSCRIPT = loadTranscript();
const PROBE_AT = TRANSCRIPT.findIndex((l) => l.t === 'frame' && (l.frame as { kind: string }).kind === 'ask');
const OPENING = TRANSCRIPT.slice(0, PROBE_AT);
const PROBE_ASK = TRANSCRIPT[PROBE_AT] as Extract<(typeof TRANSCRIPT)[number], { t: 'frame' }>;
const AFTER_PROBE = TRANSCRIPT.slice(PROBE_AT + 1);

/* ── Shared helpers ──────────────────────────────────────────────────── */

interface WireMessage {
	t: string;
	rid?: string | null;
	[key: string]: unknown;
}

interface Peer {
	ws: WebSocket;
	messages: WireMessage[];
	raw: string[];
	request(t: 'join' | 'resync', matchId: string): Promise<WireMessage>;
	send(message: unknown): void;
	frames(): WireMessage[];
	/** Every byte this browser was handed, as it came off the socket. */
	transcript(): string;
	close(): void;
}

const openPeers: Peer[] = [];
const openRawSockets: Socket[] = [];

function edgeHeaders(user: string, tier = 'friend'): Record<string, string> {
	return {
		'x-edge-auth': EDGE_SECRET,
		'x-hadoku-tier': tier,
		'x-user-id': `browser-device-${user}`,
		'x-user-key': `friend-key-${user}`,
	};
}

/** A browser-shaped client: Node's own `WebSocket`, which is the one a browser ships. */
function connect(port: number, path: string, headers: Record<string, string>): Promise<Peer> {
	return new Promise((done, fail) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
		const messages: WireMessage[] = [];
		const raw: string[] = [];
		const waiters: ((m: WireMessage) => boolean)[] = [];
		let rids = 0;
		// Armed before the listener that runs it: the bridge greets the instant
		// the 101 is written, so a waiter installed in `open` can miss it.
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
					const timer = setTimeout(() => refuse(new Error(`no answer to ${t} ${rid}`)), 8000);
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

/**
 * The raw HTTP answer to a WebSocket upgrade request. Used where the STATUS
 * LINE is the assertion — a browser `WebSocket` only reports "it failed", and
 * "404 rather than 403" is the part of the refusal that matters.
 */
function upgradeStatus(port: number, path: string, headers: Record<string, string>): Promise<string> {
	return new Promise((done) => {
		const socket = netConnect(port, '127.0.0.1', () => {
			socket.write(
				[
					`GET ${path} HTTP/1.1`,
					'Host: 127.0.0.1',
					'Upgrade: websocket',
					'Connection: Upgrade',
					'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==',
					'Sec-WebSocket-Version: 13',
					...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
				].join('\r\n') + '\r\n\r\n',
			);
		});
		openRawSockets.push(socket);
		let seen = '';
		socket.on('data', (chunk: Buffer) => {
			seen += chunk.toString('latin1');
		});
		const deadline = Date.now() + 5000;
		const wait = setInterval(() => {
			if (seen.includes('\r\n\r\n') || Date.now() > deadline) {
				clearInterval(wait);
				done(seen);
			}
		}, 10);
	});
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

afterEach(() => {
	for (const p of openPeers.splice(0)) p.close();
	for (const s of openRawSockets.splice(0)) s.destroy();
});

/* ── 1. The real `src/index.ts`, as a real process ───────────────────── */

async function freePort(): Promise<number> {
	const probe = netServer();
	await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
	const { port } = probe.address() as AddressInfo;
	await new Promise<void>((r) => probe.close(() => r()));
	return port;
}

describe('the endpoint a server started from src/index.ts actually exposes', () => {
	let root = '';
	let child: ChildProcess | null = null;
	let port = 0;
	let output = '';

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), 'cardtable-mounted-'));
		// `checkBundle` fails under a dot-directory, and THIS worktree lives in
		// one — so the fixture bundle must not. Same guard `index.test.ts` uses.
		expect(root.split(sep).filter((s) => s.startsWith('.'))).toEqual([]);
		const webDir = join(root, 'web');
		mkdirSync(webDir, { recursive: true });
		writeFileSync(join(webDir, 'index.html'), INDEX_FIXTURE);
		port = await freePort();

		const env: NodeJS.ProcessEnv = {
			...process.env,
			CARDTABLE_PORT: String(port),
			CARDTABLE_HOST: '127.0.0.1',
			CARDTABLE_WEB_DIR: webDir,
			CARDTABLE_LOG_DIR: join(root, 'logs'),
			CARDTABLE_ROOMS_DIR: join(root, 'rooms'),
			// Never production's run directory. The JVM pool boot-sweeps this, and
			// with no jar configured below it is never built — but a default of
			// `/tmp/cardtable-play` is not something a test leaves to inference.
			CARDTABLE_PLAY_WORK_DIR: join(root, 'play'),
			// A REAL gate: provenance is verified, so an unvouched handshake is
			// degraded to `public` and must be refused by the bridge's own check.
			EDGE_AUTH_SECRET: EDGE_SECRET,
			CARDTABLE_MIN_TIER: 'friend',
		};
		delete env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
		// No JVM is started by a mount test.
		delete env.CARDTABLE_FORGE_JAR;
		delete env.CARDTABLE_FORGE_RES;

		child = spawn(TSX, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
		child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
		child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
		await new Promise<void>((up, down) => {
			const timer = setTimeout(() => down(new Error(`server did not start:\n${output}`)), 60_000);
			const watch = (): void => {
				if (output.includes(`listening on 127.0.0.1:${port}`)) {
					clearTimeout(timer);
					up();
				}
			};
			child?.stdout?.on('data', watch);
			child?.on('exit', (code) => {
				clearTimeout(timer);
				down(new Error(`server exited ${code} before listening:\n${output}`));
			});
		});
	}, 90_000);

	afterAll(async () => {
		child?.kill('SIGTERM');
		if (child !== null && child.exitCode === null) await new Promise((r) => child?.once('exit', r));
		rmSync(root, { recursive: true, force: true });
	});

	it('answers a real browser WebSocket upgrade on /play/ws, and seats it against the registry attachPlay built', async () => {
		const alice = await connect(port, '/play/ws', edgeHeaders('alice'));
		// Only `index.ts` calling `attachBrowserBridge` can produce this.
		expect(alice.messages[0]).toMatchObject({ t: 'hello' });
		expect(typeof alice.messages[0]?.protocol).toBe('number');

		// The lazy `matches` read resolved to play's OWN registry. A mount that
		// passed `() => null` — or one placed where `play` is still null — would
		// answer `play is not configured on this server` instead.
		const answer = await alice.request('join', 'm-000000000000');
		expect(answer).toMatchObject({ t: 'error', error: 'unknown-match' });

		// It is the process's own log line, from the file under test.
		expect(output).toContain('browser bridge on /play/ws');
	}, 30_000);

	it('refuses an unvouched upgrade with 404 and no 101, where no express middleware runs', async () => {
		// `x-hadoku-tier: admin` with no `x-edge-auth`: `sanitizeHeaders` strips
		// it and the request is `public`, below the floor. `app.use(requireMinTier)`
		// is on the REQUEST path and an upgrade is not a request, so the only
		// thing that can refuse this is the bridge's own re-application.
		const answer = await upgradeStatus(port, '/play/ws', { 'x-hadoku-tier': 'admin', 'x-user-id': 'liar' });
		expect(answer).toContain('404 Not Found');
		expect(answer).not.toContain('101');
		// 404 and not 403: the endpoint does not confirm its own existence.
		expect(answer).not.toContain('403');
	}, 30_000);

	it('leaves engine.io its own path — socket.io still handshakes on the same server', async () => {
		// Two `upgrade` listeners now share one HTTP server. If the bridge's
		// handler answered or destroyed a socket that is not its path, this is
		// the draft room and every match's socket.io client going dark.
		const res = await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`, {
			headers: edgeHeaders('alice'),
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('"sid"');
	}, 30_000);
});

/* ── 2. The same mount, in process, with a match behind it ───────────── */

let bridgeMod: typeof import('./index.ts');
let playMod: typeof import('../socket.ts');
let transportMod: typeof import('../transport.ts');
let edgeMod: typeof import('../../edge-auth.ts');

interface Mount {
	port: number;
	hosts: ReplayHost[];
	fanout: import('./fanout.js').BrowserFanout;
	logs: Record<string, unknown>[];
	create(): Match;
	close(): Promise<void>;
}

let mount: Mount | null = null;

async function bootMount(): Promise<Mount> {
	const logs: Record<string, unknown>[] = [];
	const { factory, hosts } = replayFactory();

	// ── `src/index.ts`'s own shape, in the same order ────────────────────
	const app = express();
	app.set('trust proxy', true);
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json({ limit: '1mb' }));
	app.use('/api', api);
	const httpServer: HttpServer = createServer(app);
	const io = new SocketIOServer(httpServer, { serveClient: false });

	let play: import('../socket.js').PlayHandle | null = null;
	play = playMod.attachPlay(io, api, {
		minTier: 'friend',
		host: factory,
		log: (e) => logs.push(e),
		joinWaitMs: 1000,
		askTimeoutMs: 60_000,
		overGraceMs: 60_000,
	});
	// The mount under test, with the SAME deps `index.ts` passes — including
	// the lazy `matches` read and the process-wide fanout (no `fanout` option).
	const bridge = bridgeMod.attachBrowserBridge(httpServer, {
		minTier: 'friend',
		matches: () => play?.matches ?? null,
		log: (e) => logs.push(e),
		joinWaitMs: 1000,
	});
	await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));

	mount = {
		port: (httpServer.address() as AddressInfo).port,
		hosts,
		fanout: bridgeMod.browserFanout,
		logs,
		create: () =>
			(play as import('../socket.js').PlayHandle).matches.create({
				seats: [
					{ name: 'Seat 1', ai: false, deck: null },
					{ name: 'Seat 2', ai: false, deck: null },
				],
			}),
		close: async () => {
			bridge.close();
			play?.close();
			io.engine.close();
			// `close()`'s CALLBACK never fires once an upgrade has been declined
			// (node v24.18.0) — see browser.test.ts. The listening handle is
			// released synchronously, which is what the next test needs.
			httpServer.closeAllConnections();
			httpServer.close();
			httpServer.unref();
			await new Promise((r) => setTimeout(r, 0));
		},
	};
	return mount;
}

beforeAll(async () => {
	// config.ts reads the environment once, at load — see socket.test.ts.
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	bridgeMod = await import('./index.ts');
	playMod = await import('../socket.ts');
	transportMod = await import('../transport.ts');
	edgeMod = await import('../../edge-auth.ts');
});

afterEach(async () => {
	if (mount !== null) await mount.close();
	mount = null;
});

/** Two joined browsers on one match behind the production mount. */
async function twoSeats(): Promise<{ m: Mount; matchId: string; host: ReplayHost; alice: Peer; bob: Peer }> {
	const m = await bootMount();
	const match = m.create();
	const host = m.hosts[0] as ReplayHost;
	host.push(...OPENING);
	const alice = await connect(m.port, '/play/ws', edgeHeaders('alice'));
	const bob = await connect(m.port, '/play/ws', edgeHeaders('bob'));
	return { m, matchId: match.id, host, alice, bob };
}

function body(message: WireMessage): Record<string, unknown> {
	const { t: _t, rid: _rid, ...rest } = message;
	return rest;
}

describe('a browser client through the mount src/index.ts builds', () => {
	it('is refused below the tier floor by the mounted bridge, not by express', async () => {
		const m = await bootMount();
		await expect(connect(m.port, '/play/ws', { 'x-hadoku-tier': 'admin', 'x-user-id': 'liar' })).rejects.toThrow();
		const answer = await upgradeStatus(m.port, '/play/ws', { 'x-hadoku-tier': 'admin', 'x-user-id': 'liar' });
		expect(answer).toContain('404 Not Found');
	}, 30_000);

	it('joins, is seated by Match.claim, gets that seat\'s projected frames, and its act reaches Forge as that seat', async () => {
		const { matchId, host, alice, bob } = await twoSeats();

		// ── join ──────────────────────────────────────────────────────────
		const a = await alice.request('join', matchId);
		const b = await bob.request('join', matchId);
		expect([a.t, b.t]).toEqual(['snapshot', 'snapshot']);
		expect([a.seat, a.playerId, b.seat, b.playerId]).toEqual([0, 0, 1, 1]);

		// ── a projected frame ─────────────────────────────────────────────
		// The snapshot IS the seat's projected history: `transport.ts`'s strict
		// schema parses it, and it carries the seat's own `openView`.
		const snapshot = transportMod.MatchSnapshotSchema.parse(body(a));
		expect(snapshot.frames.length).toBeGreaterThan(0);
		expect(snapshot.frames.map((f) => f.method)).toContain('openView');
		expect((snapshot.cursor as { seq: number }).seq).toBeGreaterThan(0);
		expect(snapshot.matchId).toBe(matchId);

		// ── an act ────────────────────────────────────────────────────────
		host.push(PROBE_ASK);
		const before = host.commands.length;
		alice.send({ t: 'c2s', matchId, frame: ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }) });
		bob.send({ t: 'c2s', matchId, frame: ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }) });
		await waitUntil(() => host.commands.length >= before + 2, 'both acts to reach the bridge');
		// The seat comes from the claim; there is no seat field on this wire.
		expect(host.commands.slice(before).filter((c) => c.t === 'act').map((c) => (c as { seat: number }).seat)).toEqual([0, 1]);
	}, 30_000);

	it('cannot be made to hand seat 0 one byte of seat 1\'s hidden state, even by delivering seat 1\'s own frame', async () => {
		const { m, matchId, host, alice, bob } = await twoSeats();
		const a = await alice.request('join', matchId);
		await bob.request('join', matchId);
		// The rest of the recorded match, then a resync each: without
		// `play/socket.ts`'s missing `deliver` there is no live push, so a resync
		// is how each browser's wire comes to hold the seat's WHOLE projected
		// history — which is the text the oracle below is measured over.
		host.push(PROBE_ASK, ...AFTER_PROBE);
		const b = await bob.request('resync', matchId);
		await alice.request('resync', matchId);
		const secretsOf = (seat: number): Set<string> => secretsFor(rawStatesOf(TRANSCRIPT, seat), seat).secrets;

		// The oracle is not vacuous: Forge's own raw stream carries every one of
		// seat 0's secrets, and so do the bytes that LAWFULLY reached seat 1.
		const secrets = secretsOf(0);
		const rawStream = TRANSCRIPT.filter((l) => l.t === 'frame' && l.seat === 0).map((l) => JSON.stringify(l)).join('\n');
		expect(secrets.size).toBeGreaterThan(0);
		expect(leaked(secrets, rawStream).length).toBe(secrets.size);
		expect(leaked(secrets, bob.transcript()).length).toBeGreaterThan(0);
		// And none of them is on seat 0's wire.
		expect(leaked(secrets, alice.transcript())).toEqual([]);
		expect(leaked(secretsOf(1), bob.transcript())).toEqual([]);

		// ── the illegal cross-seat read, performed rather than assumed ─────
		// Take a REAL frame out of seat 1's own projected snapshot — one that is
		// verified to carry seat 0's secrets — and push it at seat 1 through the
		// process-wide fanout `index.ts` mounts. (In production this call is
		// `play/socket.ts`'s `emit`, which does not make it yet; see the header.
		// Making it here is what exercises the seat filter at all.)
		const seat1 = transportMod.MatchSnapshotSchema.parse(body(b));
		const loaded = seat1.frames
			.map((frame) => ({ frame, n: leaked(secrets, JSON.stringify(frame)).length }))
			.sort((x, y) => y.n - x.n)[0];
		expect(loaded?.n ?? 0).toBeGreaterThan(0);
		const envelope = transportMod.ServerEnvelopeSchema.parse({
			matchId,
			cursor: { epoch: (a.cursor as { epoch: string }).epoch, seq: 9999 },
			frame: loaded?.frame,
		});
		const delivered = m.fanout.deliver(matchId, 1, envelope);
		await waitUntil(() => bob.frames().length > 0, 'seat 1 to receive its own frame');
		await new Promise((r) => setTimeout(r, 100));

		// Seat 0's connection was never offered THAT envelope, and still holds
		// none of the secrets it is stuffed with. Remove the seat check in
		// `BrowserFanout.deliver` or in `BrowserSession.push` and this fails.
		//
		// Phrased as "not this envelope" and "no secrets" rather than "no frames
		// at all", so it keeps its meaning the day `play/socket.ts` starts
		// delivering seat 0 its own live frames.
		expect(leaked(secrets, alice.transcript())).toEqual([]);
		expect(alice.frames().some((f) => (f.cursor as { seq: number }).seq === 9999)).toBe(false);
		// One connection holds seat 1 in this match, and exactly one got it.
		expect(delivered).toBe(1);
		console.log(
			`[mounted] seat 0: ${secrets.size} secrets, ${leaked(secrets, rawStream).length} in Forge's raw stream, ` +
				`${leaked(secrets, bob.transcript()).length} in seat 1's own bytes, ${leaked(secrets, alice.transcript()).length} in seat 0's`,
		);
	}, 30_000);
});
