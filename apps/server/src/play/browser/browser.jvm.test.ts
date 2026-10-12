/**
 * The browser bridge against a REAL Forge, in a real child JVM, through the
 * real `bridge/PlayBridge.java` — the same thing `jvm.test.ts` does for the
 * socket.io path, with a browser `WebSocket` in place of a socket.io client.
 *
 * `browser.test.ts` proves the bridge against a recorded real transcript, which
 * is repeatable and runs in CI. This proves the part a recording cannot: that
 * the frames a live Forge produces TODAY reach a browser projected, that a
 * browser's answer to a real server-side `showConfirmDialog` travels back over
 * the WebSocket into Forge's `sendAndWait` and comes out as the return value,
 * that an act moves the game on, and that the JVM is gone afterwards.
 *
 * CI has no Java and no `forge/`, so this SKIPS unless the Forge build is
 * configured — and says so in the suite's name, with the reason, rather than
 * passing silently. To run it:
 *
 *   export CARDTABLE_FORGE_JAR=~/.local/share/cardtable/forge.jar
 *   export CARDTABLE_FORGE_RES=/home/hadoku/repos/hadoku-cardtable/forge/forge-gui/res
 *   pnpm exec vitest run apps/server/src/play/browser/browser-jvm.test.ts
 *
 * ## The work directory is this suite's own, always
 *
 * The JVM pool BOOT-SWEEPS its work dir, and the default is production's
 * `/tmp/cardtable-play` — which a test run deleted in Wave 12. `jvmHostConfig`
 * takes an env object, so this suite hands it a `mkdtemp`ed one and never reads
 * `CARDTABLE_PLAY_WORK_DIR` from the environment at all. Running this with the
 * Forge variables exported cannot touch a production run directory.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ClientFrameSchema } from '@hadoku/forge-wire';

import { jvmHostConfig, jvmHostFactory, liveJvmCount, type BridgeLine, type JvmHostFactory } from '../host.js';
import { createMatchRegistry, type Match } from '../match.js';
import { leaked, rawStatesOf, secretsFor } from '../fixtures/transcript.js';
import { BrowserFanout } from './fanout.js';

const EDGE_SECRET = 'browser-jvm-test-edge-secret';

// Availability is resolved BEFORE a directory is made, so a skipped run — every
// CI run — leaves nothing behind. `jvmHostConfig` only resolves strings; it is
// `jvmHostFactory` that sweeps, and it is never handed this probe's path.
const probe = jvmHostConfig({ ...process.env, CARDTABLE_PLAY_WORK_DIR: join(tmpdir(), 'cardtable-browser-jvm-probe') });
const WORK_DIR = probe.ok ? mkdtempSync(join(tmpdir(), 'cardtable-browser-jvm-')) : '';
const available = probe.ok
	? jvmHostConfig({
			...process.env,
			// Never production's, whatever the environment says. See the header.
			CARDTABLE_PLAY_WORK_DIR: WORK_DIR,
			CARDTABLE_PLAY_WARM_SPARE: '0',
		})
	: probe;
const title = available.ok
	? 'a browser WebSocket against a real Forge match in a child JVM'
	: `a browser WebSocket against a real Forge match in a child JVM — SKIPPED: ${available.reason}`;

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

interface WireMessage {
	t: string;
	rid?: string | null;
	[key: string]: unknown;
}

interface Peer {
	messages: WireMessage[];
	raw: string[];
	request(t: 'join' | 'resync', matchId: string): Promise<WireMessage>;
	send(message: unknown): void;
	frames(): WireMessage[];
	transcript(): string;
	close(): void;
}

describe.skipIf(!available.ok)(title, () => {
	const cleanup: (() => void)[] = [];

	afterAll(async () => {
		for (const fn of cleanup.splice(0)) fn();
		await waitUntil(() => liveJvmCount() === 0, 'the JVM to exit', 20_000).catch(() => undefined);
		if (WORK_DIR !== '') rmSync(WORK_DIR, { recursive: true, force: true });
	});

	it('joins two browsers, projects per seat, answers a real ask over the WebSocket, and moves on an act', async () => {
		if (!available.ok) return;
		process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
		delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
		vi.resetModules();
		const bridgeMod = await import('./index.ts');

		const precon = (name: string): string =>
			readFileSync(join(available.ok ? available.config.res : '', 'quest', 'precons', `${name}.dck`), 'utf8');

		const raw: BridgeLine[] = [];
		const logs: Record<string, unknown>[] = [];
		const fanout = new BrowserFanout();
		const jvm: JvmHostFactory = jvmHostFactory(available.config, { spare: false, log: (e) => logs.push(e) });
		const registry = createMatchRegistry({
			host: (id, spec, events) =>
				jvm(id, spec, {
					...events,
					line: (l) => {
						raw.push(l);
						events.line(l);
					},
				}),
			log: (e) => logs.push(e),
			overGraceMs: 60_000,
			// The one line of wiring that lives outside this lane. See fanout.ts.
			emit: (match, seat, envelope) => fanout.deliver(match.id, seat, envelope),
		});
		const http: HttpServer = createServer((_req, res) => res.end());
		const bridge = bridgeMod.attachBrowserBridge(http, {
			minTier: 'friend',
			matches: () => registry,
			fanout,
			log: (e) => logs.push(e),
		});
		await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
		const port = (http.address() as AddressInfo).port;

		function connect(user: string): Promise<Peer> {
			return new Promise((done, fail) => {
				const ws = new WebSocket(`ws://127.0.0.1:${port}${bridgeMod.BROWSER_WS_PATH}`, {
					headers: {
						'x-edge-auth': EDGE_SECRET,
						'x-hadoku-tier': 'friend',
						'x-user-id': `browser-device-${user}`,
						'x-user-key': `friend-key-${user}`,
					},
				});
				const messages: WireMessage[] = [];
				const rawText: string[] = [];
				const waiters: ((m: WireMessage) => boolean)[] = [];
				let rids = 0;
				const peer: Peer = {
					messages,
					raw: rawText,
					send: (message) => ws.send(JSON.stringify(message)),
					frames: () => messages.filter((m) => m.t === 's2c'),
					transcript: () => rawText.join('\n'),
					close: () => ws.close(),
					request(t, matchId) {
						const rid = `r-${(rids += 1)}`;
						return new Promise<WireMessage>((answer, refuse) => {
							const timer = setTimeout(() => refuse(new Error(`no answer to ${t} ${rid}`)), 30_000);
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
				waiters.push((m) => {
					if (m.t !== 'hello') return false;
					done(peer);
					return true;
				});
				ws.addEventListener('message', (event) => {
					const text = String(event.data);
					rawText.push(text);
					const parsed = JSON.parse(text) as WireMessage;
					messages.push(parsed);
					for (let i = waiters.length - 1; i >= 0; i--) {
						if ((waiters[i] as (m: WireMessage) => boolean)(parsed)) waiters.splice(i, 1);
					}
				});
				ws.addEventListener('error', () => fail(new Error('websocket refused')));
			});
		}

		const started = Date.now();
		const match: Match = registry.create({
			seed: 20260918,
			seats: [
				{ name: 'Seat 1', ai: false, deck: precon('Spirit Flames') },
				{ name: 'Seat 2', ai: false, deck: precon('Decay') },
			],
		});
		cleanup.push(() => {
			bridge.close();
			match.stop();
			jvm.close();
			http.closeAllConnections();
			http.close();
			http.unref();
		});
		expect(await match.whenRunning(180_000)).toEqual({ ok: true });
		const ready = raw.find((l) => l.t === 'ready') as Extract<BridgeLine, { t: 'ready' }>;
		console.log(
			`[browser-jvm] running after ${Date.now() - started} ms (JVM up ${ready.bootMs} ms); decks: ${ready.seats.map((s) => s.deck).join(' v ')}`,
		);

		const alice = await connect('alice');
		const bob = await connect('bob');
		const a = await alice.request('join', match.id);
		const b = await bob.request('join', match.id);
		expect([a.t, b.t]).toEqual(['snapshot', 'snapshot']);
		expect([a.seat, b.seat]).toEqual([0, 1]);
		expect((a.frames as unknown[]).length).toBeGreaterThan(0);

		// Forge opens with the coin toss: each seat is prompted.
		await waitUntil(
			() => [alice, bob].every((p) => p.frames().some((f) => (f.frame as { method: string }).method === 'updateButtons')),
			'a prompt for each browser',
			60_000,
		);

		// A real showConfirmDialog from Forge's server side, answered by a real
		// browser over a real WebSocket. The probe's default is NO, so a `true`
		// can only have come from that reply.
		const probe = match.probe(0, 'browser-jvm.test: answer yes', 60_000);
		await waitUntil(() => alice.frames().some((f) => (f.frame as { kind: string }).kind === 'ask'), 'the ask', 60_000);
		const ask = alice.frames().find((f) => (f.frame as { kind: string }).kind === 'ask')?.frame as { callId: string };
		alice.send({
			t: 'c2s',
			matchId: match.id,
			frame: ClientFrameSchema.parse({ kind: 'reply', callId: ask.callId, method: 'showConfirmDialog', result: true }),
		});
		const result = await probe;
		console.log(`[browser-jvm] probe: ${JSON.stringify(result)}`);
		expect(result.answer).toBe(true);

		// Acts move the game: OK from both seats plays first and keeps both hands.
		for (let i = 0; i < 3; i++) {
			for (const peer of [alice, bob]) {
				peer.send({ t: 'c2s', matchId: match.id, frame: ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }) });
			}
			await new Promise((r) => setTimeout(r, 1500));
		}
		await waitUntil(
			() => alice.transcript().includes('Turn: 1') || bob.transcript().includes('Turn: 1'),
			'turn 1',
			60_000,
		);
		expect(match.invalidFrames).toBe(0);

		// The measurement, over the bytes each browser received.
		const secretsOf = (seat: number): Set<string> => secretsFor(rawStatesOf(raw, seat), seat).secrets;
		const peers = [alice, bob] as const;
		for (const seat of [0, 1] as const) {
			const secrets = secretsOf(seat);
			const rawText = raw.filter((l) => l.t === 'frame' && l.seat === seat).map((l) => JSON.stringify(l)).join('\n');
			const got = (peers[seat] as Peer).transcript();
			console.log(
				`[browser-jvm] seat ${seat}: ${(peers[seat] as Peer).raw.length} messages, ${got.length} bytes, ${secrets.size} secrets, ` +
					`${leaked(secrets, rawText).length} in Forge's raw stream, ${leaked(secrets, got).length} in what the browser received`,
			);
			expect(secrets.size).toBeGreaterThan(0);
			expect(leaked(secrets, rawText).length).toBe(secrets.size);
			expect(leaked(secrets, got)).toEqual([]);
		}
		// The cross-seat control: seat 1's own lawful bytes ARE a leak at seat 0.
		const crossed = leaked(secretsOf(0), bob.transcript());
		console.log(`[browser-jvm] cross-seat control: ${crossed.length} of seat 0's secrets are present in seat 1's own bytes`);
		expect(crossed.length).toBeGreaterThan(0);

		alice.close();
		bob.close();
		for (const fn of cleanup.splice(0)) fn();
		await waitUntil(() => liveJvmCount() === 0, "this match's JVM to exit", 20_000);
		expect(liveJvmCount()).toBe(0);
	}, 300_000);
});
