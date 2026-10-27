/**
 * A burst of match starts against REAL Forge. Hosting test C7 (claw-9, 2026-10-24): ten starts at
 * once each booted a cold JVM in 44.7–52.4 s, against 9.6 s for one alone, and the slowest was 8 s
 * inside the 60 s start timeout. A failover on the claws is the same burst.
 *
 * Eight people start a match at the same moment, with a warm JVM up as in production and two
 * matches per JVM, so the burst needs boots:
 *
 *  1. no more than `coldStarts` JVMs boot at once for starts — the pool's warm one is the only
 *     JVM booting beside them;
 *  2. every start answers 201: none spends its timeout waiting in the queue;
 *  3. every start that waited was told its place (`GET /api/play/queue`), and the place only fell.
 *
 * `[nightly]`: eight JVMs is load, so it runs on the claws' scheduled and dispatched jvm jobs, not
 * on every push. Skips visibly without a Forge build, like every `*.jvm.test.ts`:
 *
 *   CARDTABLE_JVM_NIGHTLY=1 CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/start-queue.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import express from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';

import { jvmHostConfig, jvmHostFactory, liveJvmCount } from './host.js';
import { nightly } from './scenario.js';

const EDGE_SECRET = 'test-edge-auth-secret';
const available = jvmHostConfig();
const BURST = 8;
const COLD_STARTS = 2;
/** Small, so a burst of eight needs JVM boots and the queue between them. */
const PER_JVM = 2;
const title = !available.ok
	? `a burst of starts, against real Forge — SKIPPED: ${available.reason}`
	: !nightly
		? 'a burst of starts, against real Forge [nightly] — SKIPPED: CARDTABLE_JVM_NIGHTLY is not 1'
		: 'a burst of starts, against real Forge [nightly]';

let socketMod: typeof import('./socket.ts');
let edgeMod: typeof import('../edge-auth.ts');

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	socketMod = await import('./socket.ts');
	edgeMod = await import('../edge-auth.ts');
});

let closeServer: (() => Promise<void>) | null = null;

afterEach(async () => {
	await closeServer?.();
	closeServer = null;
});

const edge = (user: string): Record<string, string> => ({
	'x-edge-auth': EDGE_SECRET,
	'x-hadoku-tier': 'friend',
	'x-user-id': `user-${user}`,
	'x-user-key': `friend-key-${user}`,
});

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

function deck(name: string): string {
	return `[metadata]\nName=${name}\n[main]\n30 Mountain\n30 Memnite\n`;
}

type Entry = Record<string, unknown> & { at: number };

/** JVM boots, from the logs: every JVM from its spawn to its `warm`. */
function boots(logs: readonly Entry[]): { from: number; to: number }[] {
	const spawned = new Map<string, number>();
	const jvms: { from: number; to: number }[] = [];
	for (const e of logs) {
		if (e.evt === 'jvm-spawned' && typeof e.id === 'string') spawned.set(e.id, e.at);
		if (e.evt === 'jvm-warm' && typeof e.id === 'string') {
			const from = spawned.get(e.id);
			if (from !== undefined) jvms.push({ from, to: e.at });
			spawned.delete(e.id);
		}
	}
	return jvms;
}

/** The most intervals open at one instant. */
function peak(intervals: readonly { from: number; to: number }[]): number {
	const edges = intervals.flatMap((i) => [
		{ at: i.from, d: 1 },
		{ at: i.to, d: -1 },
	]);
	edges.sort((a, b) => a.at - b.at || a.d - b.d);
	let open = 0;
	let most = 0;
	for (const e of edges) {
		open += e.d;
		most = Math.max(most, open);
	}
	return most;
}

describe.skipIf(!available.ok || !nightly)(title, () => {
	it(
		`${BURST} starts at once, ${PER_JVM} matches per JVM: at most ${COLD_STARTS} JVM boots and the warm one at a time, every start answered, every waiter told its place`,
		async () => {
			if (!available.ok) throw new Error(available.reason);
			const logs: Entry[] = [];
			const log = (e: Record<string, unknown>): void => {
				logs.push({ ...e, at: Date.now() });
			};
			const app = express();
			app.use(edgeMod.edgeProvenance);
			app.use(edgeMod.requireMinTier);
			const api = express.Router();
			app.use('/api', api);
			const http: HttpServer = createServer(app);
			const io = new SocketIOServer(http, { serveClient: false });
			const factory = jvmHostFactory({ ...available.config, perJvm: PER_JVM }, { warm: true, log });
			const handle = socketMod.attachPlay(io, api, {
				minTier: 'friend',
				host: factory,
				log,
				// Production's own timeout: the point is that a queued start does not spend it waiting.
				startTimeoutMs: 60_000,
				coldStarts: COLD_STARTS,
			});
			await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
			closeServer = async () => {
				handle.close();
				io.close();
				await new Promise<void>((done) => http.close(() => done()));
				await waitUntil(() => liveJvmCount() === 0, 'every JVM to exit', 60_000);
			};
			const port = (http.address() as AddressInfo).port;
			const url = (path: string): string => `http://127.0.0.1:${port}/api/play/${path}`;

			// As in production: a JVM is warm before anyone asks.
			await waitUntil(() => factory.room() === 'warm', 'the warm JVM', 120_000);

			const users = Array.from({ length: BURST }, (_, i) => `burst${i}`);
			const places = new Map<string, number[]>(users.map((u) => [u, []]));
			const answered = new Set<string>();
			const t0 = Date.now();
			const starts = users.map(async (user) => {
				const res = await fetch(url('matches'), {
					method: 'POST',
					headers: { ...edge(user), 'content-type': 'application/json' },
					body: JSON.stringify({ opponent: 'ai', decks: [deck(`${user} A`), deck(`${user} B`)] }),
				});
				const body = (await res.json()) as { matchId?: string; error?: string };
				answered.add(user);
				console.log(`[start-queue] ${user}: ${res.status} after ${Date.now() - t0} ms ${body.error ?? ''}`);
				// A started match has done its part: stop it, so the claw holds only what is booting.
				if (body.matchId !== undefined) handle.matches.get(body.matchId)?.stop();
				return { user, status: res.status };
			});
			// What each waiting player's page asks, while it waits.
			const watching = (async () => {
				while (answered.size < BURST) {
					await Promise.all(
						users
							.filter((u) => !answered.has(u))
							.map(async (user) => {
								const res = await fetch(url('queue'), { headers: edge(user) });
								if (res.status !== 200) return;
								const { place } = (await res.json()) as { place: number | null };
								if (place !== null && places.get(user)!.at(-1) !== place) places.get(user)!.push(place);
							}),
					);
					await new Promise((r) => setTimeout(r, 250));
				}
			})();
			const results = await Promise.all(starts);
			await watching;

			const booted = boots(logs);
			console.log(`[start-queue] JVM boots: ${JSON.stringify(booted.map((b) => ({ from: b.from - t0, ms: b.to - b.from })))}`);
			console.log(`[start-queue] peak: JVM boots ${peak(booted)}`);
			console.log(`[start-queue] places: ${JSON.stringify(Object.fromEntries(places))}`);

			expect(results.filter((r) => r.status !== 201), 'every start answered 201').toEqual([]);
			expect(peak(booted), 'JVMs booting at once, the warm one included').toBeLessThanOrEqual(COLD_STARTS + 1);
			// Whoever waited was told so, and their place only fell.
			const waited = [...places.values()].filter((p) => p.length > 0);
			for (const seen of waited) expect(seen, 'a place only falls').toEqual([...seen].sort((a, b) => b - a));
		},
		600_000,
	);
});
