/**
 * The real server, started as a real process, pointed at a fixture bundle.
 *
 * `base-path.test.ts` pins the verdict; this pins that `index.ts` actually USES
 * it — that the process which answers `/health` is the one that serves pages,
 * and that the two agree. Each case boots `src/index.ts` under tsx with
 * `CARDTABLE_WEB_DIR` at a temp tree, once outside any dot-directory and once
 * under one, and then asks both questions: what does `/health` say, and what
 * does `GET /` answer. The assertion is the invariant, not a pair of
 * expected strings: `/health` is `ok` exactly when the page is a 200.
 *
 * ## It is also the proof that the wiring ORDER holds
 *
 * `index.ts` is one top-level module: `attachDraftSocket` takes the lobby as a
 * required dep (wave 23's readiness gate), so `openLobby` has to be evaluated
 * above it. If it is not, `const lobby` is read in its temporal dead zone and the
 * module throws a ReferenceError before anything listens — which is exactly what
 * `boot` reports as "server exited N before listening". There is no separate
 * assertion for the order because a booted server IS the assertion.
 *
 * Never the live service: every port is ephemeral and every path is a temp dir.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LIBRARY, formatIdOf } from '@hadoku/deck/library';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN_HEADER, ORIGIN_VALUE } from './http/origin.ts';
import { io as ioClient, type Socket } from 'socket.io-client';
import { SERVER_RESTARTING_EVENT } from '@hadoku/shared';
import { testPort } from './testPort.ts';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The server runs under node itself with tsx as a loader, as pm2 runs it under node: tsx's CLI relays
// a SIGTERM and SIGKILLs a child that has not acknowledged it within 30 ms, which on a loaded claw
// killed the server before its shutdown ran.
const TSX_LOADER = pathToFileURL(join(PKG_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const ENTRY = join(PKG_ROOT, 'src', 'index.ts');
const INDEX = '<!doctype html><html><head><script type="module" src="/cardtable/assets/app.js"></script></head><body>fixture</body></html>';

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'cardtable-boot-'));
	expect(root.split(sep).filter((s) => s.startsWith('.'))).toEqual([]);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});


interface Served {
	status: number;
	type: string | null;
	cache: string | null;
}

interface Booted {
	/** Everything the process printed until it was stopped. */
	output: string;
	health: { status: number; body: { status: string; service: string; commit: string | null; bundle: string; reason?: string } };
	page: { status: number; body: string };
	/** The embed bundle watchparty imports (D21): its entry, a hashed chunk, a name that is not there. */
	embed: { entry: Served; chunk: Served; missing: Served };
	/** The origin header (`http/origin.ts`) on a probe, the page, a socket.io poll and a 404. */
	origin: { health: string | null; page: string | null; socket: string | null; missing: string | null };
}

async function served(url: string): Promise<Served> {
	const res = await fetch(url);
	await res.arrayBuffer();
	return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control') };
}

/**
 * A Forge install whose pool JVM never answers: a `javac` that "compiles" the
 * bridge (an empty class file where `bridgeLaunch` looks for one) and a `java`
 * that reads its stdin and says nothing until the server hangs up on it. Every
 * pool call then waits out its own timeout — the shape of a slow claw's
 * warm-up, stretched past any test's patience.
 */
function silentForge(): NodeJS.ProcessEnv {
	const dir = join(root, 'silent-forge');
	const bin = join(dir, 'bin');
	mkdirSync(bin, { recursive: true });
	mkdirSync(join(dir, 'res', 'cardsfolder'), { recursive: true });
	writeFileSync(join(dir, 'forge.jar'), '');
	writeFileSync(join(bin, 'java'), '#!/bin/sh\nexec cat > /dev/null\n', { mode: 0o755 });
	writeFileSync(
		join(bin, 'javac'),
		'#!/bin/sh\nwhile [ $# -gt 1 ]; do [ "$1" = -d ] && out=$2; shift; done\nmain=$(basename "$1" .java)\ntouch "$out/$main.class"\n',
		{ mode: 0o755 },
	);
	return {
		CARDTABLE_FORGE_JAR: join(dir, 'forge.jar'),
		CARDTABLE_FORGE_RES: join(dir, 'res'),
		CARDTABLE_JAVA: join(bin, 'java'),
		CARDTABLE_PLAY_BRIDGE_CACHE: join(dir, 'bridge'),
		CARDTABLE_PLAY_WORK_DIR: join(dir, 'work'),
		CARDTABLE_PLAY_WARM_JVM: '0',
		CARDTABLE_CATALOG_REFRESH: '0',
	};
}

/**
 * A preload (`node --import`) that makes every read of an era's frozen pool (`decks/pools/*.json`)
 * take `ms` longer, and says so on stderr as it starts: the slowest step of a boot, slowed the way a
 * loaded claw slowed it, with nothing in the server itself knowing about the test.
 */
function slowPoolReads(ms: number): NodeJS.ProcessEnv {
	const file = join(root, 'slow-pool-reads.mjs');
	writeFileSync(
		file,
		`import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync;
fs.readFileSync = function (path, ...rest) {
	if (typeof path === 'string' && /[\\/]decks[\\/]pools[\\/][^\\/]+\\.json$/.test(path)) {
		process.stderr.write('slow-pool-read ' + path + '\\n');
		const until = Date.now() + ${ms};
		while (Date.now() < until);
	}
	return read.call(this, path, ...rest);
};
syncBuiltinESMExports();
`,
	);
	return { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(file).href}`.trim() };
}

/**
 * A preload that makes every fsync before the server says it is listening take `ms` longer: a slow
 * disk on the boot path, the way a loaded claw's was, with nothing in the server itself knowing about
 * the test. Each room write is one (`room-store`'s `saveSync`).
 */
function slowBootWrites(ms: number): NodeJS.ProcessEnv {
	const file = join(root, 'slow-boot-writes.mjs');
	writeFileSync(
		file,
		`import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
let listening = false;
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
	if (String(chunk).includes('listening on ')) listening = true;
	return write(chunk, ...rest);
};
const fsync = fs.fsyncSync;
fs.fsyncSync = function (fd) {
	if (!listening) {
		const until = Date.now() + ${ms};
		while (Date.now() < until);
	}
	return fsync.call(this, fd);
};
syncBuiltinESMExports();
`,
	);
	return { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(file).href}`.trim() };
}

/**
 * Boot the server against `webDir`, ask it both questions, then stop it once `until` (if given) is
 * printed. `forgeEnv` replaces the default of no Forge at all, and is merged over it;
 * `listenWithinMs` is how long it may take to listen; `first` is asked the moment it listens, before
 * anything else, with what the server has printed so far.
 */
async function boot(
	webDir: string,
	forgeEnv: NodeJS.ProcessEnv = {},
	listenWithinMs = 30_000,
	until?: string,
	first?: (base: string, output: () => string) => Promise<void>,
): Promise<Booted> {
	mkdirSync(webDir, { recursive: true });
	writeFileSync(join(webDir, 'index.html'), INDEX);
	mkdirSync(join(webDir, 'embed', 'assets'), { recursive: true });
	writeFileSync(join(webDir, 'embed', 'cardtable-embed.js'), 'export function mount() {}\n');
	writeFileSync(join(webDir, 'embed', 'assets', 'chunk-a1b2c3.js'), 'export const x = 1;\n');
	const port = await testPort();

	const env: NodeJS.ProcessEnv = {
		...process.env,
		CARDTABLE_PORT: String(port),
		CARDTABLE_HOST: '127.0.0.1',
		CARDTABLE_WEB_DIR: webDir,
		// Each boot its own store (the data dir is the log dir's sibling, `config.ts`): a shared one
		// let a boot find the rooms an earlier test's boot had made, and pass only by running second.
		CARDTABLE_LOG_DIR: join(mkdtempSync(join(root, 'store-')), 'logs'),
		// Local-dev identity, so `GET /` reaches the SPA fallback rather than
		// stopping at the tier floor. The probe itself needs none.
		EDGE_AUTH_SECRET: '',
		CARDTABLE_INSECURE_NO_EDGE_AUTH: '1',
		// Never the host's own card catalog: a claw has none, and a test reads what CI reads.
		CARDTABLE_CATALOG: join(root, 'no-catalog', 'cards.json'),
	};
	// Never a real Forge JVM for a boot test.
	delete env.CARDTABLE_FORGE_JAR;
	delete env.CARDTABLE_FORGE_RES;
	Object.assign(env, forgeEnv);

	const child: ChildProcess = spawn(process.execPath, ['--import', TSX_LOADER, ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
	child.stderr?.on('data', (d: Buffer) => (output += d.toString()));

	try {
		await new Promise<void>((resolveUp, rejectUp) => {
			const timer = setTimeout(() => rejectUp(new Error(`server did not listen within ${listenWithinMs} ms:\n${output}`)), listenWithinMs);
			const watch = () => {
				if (output.includes(`listening on 127.0.0.1:${port}`)) {
					clearTimeout(timer);
					resolveUp();
				}
			};
			child.stdout?.on('data', watch);
			child.on('exit', (code) => {
				clearTimeout(timer);
				rejectUp(new Error(`server exited ${code} before listening:\n${output}`));
			});
		});

		const base = `http://127.0.0.1:${port}`;
		await first?.(base, () => output);
		const h = await fetch(`${base}/health`);
		const p = await fetch(`${base}/`);
		const origin = {
			health: h.headers.get(ORIGIN_HEADER),
			page: p.headers.get(ORIGIN_HEADER),
			socket: (await fetch(`${base}/socket.io/?EIO=4&transport=polling`)).headers.get(ORIGIN_HEADER),
			missing: (await fetch(`${base}/api/no-such-route`)).headers.get(ORIGIN_HEADER),
		};
		const embed = {
			entry: await served(`${base}/embed/cardtable-embed.js`),
			chunk: await served(`${base}/embed/assets/chunk-a1b2c3.js`),
			missing: await served(`${base}/embed/nope.js`),
		};
		if (until !== undefined) await printed(child, () => output, until, listenWithinMs);
		return {
			output,
			health: { status: h.status, body: (await h.json()) as Booted['health']['body'] },
			page: { status: p.status, body: await p.text() },
			embed,
			origin,
		};
	} finally {
		child.kill('SIGTERM');
		if (child.exitCode === null) await new Promise((r) => child.once('exit', r));
	}
}

/** Resolves once `text` is in the output, rejects after `withinMs`. */
function printed(child: ChildProcess, output: () => string, text: string, withinMs: number): Promise<void> {
	return new Promise((resolveSeen, rejectSeen) => {
		const timer = setTimeout(() => rejectSeen(new Error(`never printed ${text} within ${withinMs} ms:\n${output()}`)), withinMs);
		const watch = () => {
			if (!output().includes(text)) return;
			clearTimeout(timer);
			child.stdout?.off('data', watch);
			resolveSeen();
		};
		child.stdout?.on('data', watch);
		watch();
	});
}

/** The `boot-phase` and `library-warmed` lines the server printed, parsed. */
function bootLines(output: string): Record<string, unknown>[] {
	return output
		.split('\n')
		.filter((line) => line.includes('"evt":"boot-phase"') || line.includes('"evt":"library-warmed"'))
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('a server started from a path', () => {
	it('outside any dot-directory is healthy and serves the page, then reads every era\'s pool', async () => {
		const { health, page, output, origin } = await boot(join(root, 'plain', 'apps', 'ui', 'dist'), {}, 30_000, '"evt":"library-warmed"');
		expect(health.status).toBe(200);
		expect(health.body).toMatchObject({ status: 'ok', bundle: 'ok' });
		// hadoku health v1: which instance, and the HEAD of the checkout it runs from.
		expect(health.body.service).toBe('cardtable');
		expect(health.body.commit).toBe(execFileSync('git', ['-C', PKG_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
		expect(page.status).toBe(200);
		expect(page.body).toContain('fixture');
		// The edge holds a 502 without it through a restart; every answer of ours carries it.
		expect(origin).toEqual({ health: ORIGIN_VALUE, page: ORIGIN_VALUE, socket: ORIGIN_VALUE, missing: ORIGIN_VALUE });
		const lines = bootLines(output);
		// Every step between process start and listen is timed, in order, ending at listen.
		const phases = lines.filter((l) => l.evt === 'boot-phase').map((l) => l.phase);
		expect(phases[0]).toBe('imports');
		expect(phases.at(-1)).toBe('listen');
		// The pools come after: every catalogued era, none of them faulted.
		const warmed = lines.find((l) => l.evt === 'library-warmed');
		expect(warmed).toMatchObject({ formats: new Set(LIBRARY.map((c) => formatIdOf(c))).size, faults: [] });
	}, 60_000);

	it('listens, healthy, while every era\'s pool is slow to read — the pools are never on the boot path', async () => {
		// 67 eras at 400 ms each is 27 s of pool reads: a boot that waits for them never listens in 15.
		const { health, page, output } = await boot(join(root, 'slow-pools', 'apps', 'ui', 'dist'), slowPoolReads(400), 15_000);
		expect(health.status).toBe(200);
		expect(health.body).toMatchObject({ status: 'ok', bundle: 'ok' });
		expect(page.status).toBe(200);
		const listened = output.indexOf('listening on 127.0.0.1:');
		const firstPoolRead = output.indexOf('slow-pool-read ');
		expect(listened).toBeGreaterThanOrEqual(0);
		if (firstPoolRead >= 0) expect(firstPoolRead).toBeGreaterThan(listened);
	}, 60_000);

	it('listens, healthy, while every write to disk is slow — the testing rooms are never on the boot path', async () => {
		// A first boot seeds the testing rooms, 85 room writes: at 400 ms each, a boot that makes them before it listens never listens in 15.
		const { health, page } = await boot(join(root, 'slow-disk', 'apps', 'ui', 'dist'), slowBootWrites(400), 15_000);
		expect(health.status).toBe(200);
		expect(health.body).toMatchObject({ status: 'ok', bundle: 'ok' });
		expect(page.status).toBe(200);
	}, 60_000);

	it('answers a request on an era nobody has read yet in full, the moment it listens', async () => {
		const eras = [...new Set(LIBRARY.map((c) => formatIdOf(c)))];
		const last = eras.at(-1)!;
		await boot(join(root, 'cold-pools', 'apps', 'ui', 'dist'), slowPoolReads(50), 30_000, undefined, async (base, output) => {
			// The newest era is the warm-up's last read: it is cold here, so this request reads it.
			const legal = await fetch(`${base}/api/tables/legal/${last}`);
			expect(output()).not.toContain('"evt":"library-warmed"');
			expect(legal.status).toBe(200);
			expect(((await legal.json()) as { legal: string[] }).legal.length).toBeGreaterThan(0);
			// The picker's list reads every era, cold or not: all of them, each with its pool's own name.
			const formats = await fetch(`${base}/api/tables/formats`);
			expect(formats.status).toBe(200);
			const listed = ((await formats.json()) as { formats: { id: string; name: string; cardCount: number }[] }).formats.slice(1);
			expect(listed.map((f) => f.id)).toEqual(eras);
			for (const f of listed) {
				expect(f.name).not.toBe('');
				expect(f.cardCount).toBeGreaterThan(0);
			}
		});
	}, 60_000);

	it('tells every socket it is restarting before a SIGTERM closes them', async () => {
		const seen: string[] = [];
		let client: Socket | undefined;
		await boot(join(root, 'restart', 'apps', 'ui', 'dist'), {}, 30_000, undefined, async (base) => {
			client = ioClient(base, { transports: ['websocket'], reconnection: false });
			client.on(SERVER_RESTARTING_EVENT, () => seen.push('restarting'));
			client.on('disconnect', (reason) => seen.push(`disconnect:${reason}`));
			await new Promise<void>((up) => client!.once('connect', () => up()));
		});
		client?.close();
		expect(seen[0]).toBe('restarting');
		expect(seen[1]).toMatch(/^disconnect:/);
	}, 60_000);

	it('serves the embed entry as revalidated JS, its chunks immutable, and a missing file as a 404', async () => {
		const { embed } = await boot(join(root, 'embed', 'apps', 'ui', 'dist'));
		expect(embed.entry).toMatchObject({ status: 200, cache: 'no-cache' });
		expect(embed.entry.type).toMatch(/^(text|application)\/javascript/);
		expect(embed.chunk.status).toBe(200);
		expect(embed.chunk.type).toMatch(/^(text|application)\/javascript/);
		expect(embed.chunk.cache).toContain('immutable');
		expect(embed.missing.status).toBe(404);
		expect(embed.missing.type).not.toMatch(/html/);
	}, 60_000);

	it('listens, healthy, while the pool JVM has not answered a single call — warming the sets is never on the boot path', async () => {
		const { health, page } = await boot(join(root, 'silent', 'apps', 'ui', 'dist'), silentForge(), 10_000);
		expect(health.status).toBe(200);
		expect(health.body).toMatchObject({ status: 'ok', bundle: 'ok' });
		expect(page.status).toBe(200);
	}, 60_000);

	it("answers the edge's account erase with every store's count, and refuses it without the seal", async () => {
		const SEAL = 'edge-seal-for-the-boot-test';
		const answers: { status: number; body: unknown }[] = [];
		const post = async (base: string, headers: Record<string, string>) => {
			const res = await fetch(`${base}/api/_account/erase`, { method: 'POST', headers });
			answers.push({ status: res.status, body: await res.json() });
		};
		await boot(join(root, 'erase', 'apps', 'ui', 'dist'), { EDGE_AUTH_SECRET: SEAL, CARDTABLE_INSECURE_NO_EDGE_AUTH: '0' }, 30_000, undefined, async (base) => {
			const who = { 'x-hadoku-tier': 'member', 'x-user-id': 'c41f9e2a-7b3d-4a8e-9c56-2f0d1b8e6a03' };
			await post(base, who);
			await post(base, { ...who, 'x-edge-auth': SEAL });
		});
		expect(answers[0]?.status).toBe(401);
		expect(answers[1]).toEqual({
			status: 200,
			body: {
				erased: {
					callersSeen: 0,
					statsKeys: 0,
					people: 0,
					matchesForfeited: 0,
					roomsClosed: 0,
					roomsLeft: 0,
					roomsAnonymised: 0,
					decks: 0,
					pods: 0,
					tournaments: 0,
					events: 0,
					forms: 0,
					recordings: 0,
					parked: 0,
					presets: 0,
					cubes: 0,
					legacyIds: 0,
				},
			},
		});
	}, 60_000);

	it('under a dot-directory reports degraded, and says why on the page instead of a 404', async () => {
		const { health, page } = await boot(join(root, 'repo', '.claude', 'worktrees', 'w', 'apps', 'ui', 'dist'));
		// The invariant first: green /health and a failing page may never coexist.
		expect(health.body.status === 'ok').toBe(page.status === 200);

		expect(health.status).toBe(503);
		expect(health.body).toMatchObject({ status: 'degraded', service: 'cardtable', bundle: 'unservable' });
		expect(health.body.reason).toContain('unservable');
		expect(page.status).toBe(503);
		expect(page.body).toContain('.claude');
	}, 60_000);
});
