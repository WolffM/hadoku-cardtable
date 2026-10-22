/**
 * The real server, started as a real process, pointed at a fixture bundle.
 *
 * `base-path.test.ts` pins the verdict; this pins that `index.ts` actually USES
 * it — that the process which answers `/health` is the one that serves pages,
 * and that the two agree. Each case boots `src/index.ts` under tsx with
 * `CARDTABLE_WEB_DIR` at a temp tree, once outside any dot-directory and once
 * under one, and then asks both questions: what does `/health` say, and what
 * does `GET /` answer. The assertion is the invariant, not a pair of
 * expected strings: `/health` is `healthy` exactly when the page is a 200.
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

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPort } from './testPort.ts';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = join(PKG_ROOT, 'node_modules', '.bin', 'tsx');
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
	health: { status: number; body: { status: string; bundle: string } };
	page: { status: number; body: string };
	/** The embed bundle watchparty imports (D21): its entry, a hashed chunk, a name that is not there. */
	embed: { entry: Served; chunk: Served; missing: Served };
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
		CARDTABLE_PLAY_WARM_SPARE: '0',
		CARDTABLE_CATALOG_REFRESH: '0',
	};
}

/** Boot the server against `webDir`, ask it both questions, stop it. `forgeEnv` replaces the default of no Forge at all; `listenWithinMs` is how long it may take to listen. */
async function boot(webDir: string, forgeEnv: NodeJS.ProcessEnv = {}, listenWithinMs = 30_000): Promise<Booted> {
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
		CARDTABLE_LOG_DIR: join(root, 'logs'),
		// Local-dev identity, so `GET /` reaches the SPA fallback rather than
		// stopping at the tier floor. The probe itself needs none.
		EDGE_AUTH_SECRET: '',
		CARDTABLE_INSECURE_NO_EDGE_AUTH: '1',
	};
	// Never a real Forge JVM for a boot test.
	delete env.CARDTABLE_FORGE_JAR;
	delete env.CARDTABLE_FORGE_RES;
	Object.assign(env, forgeEnv);

	const child: ChildProcess = spawn(TSX, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
		const h = await fetch(`${base}/health`);
		const p = await fetch(`${base}/`);
		return {
			health: { status: h.status, body: (await h.json()) as Booted['health']['body'] },
			page: { status: p.status, body: await p.text() },
			embed: {
				entry: await served(`${base}/embed/cardtable-embed.js`),
				chunk: await served(`${base}/embed/assets/chunk-a1b2c3.js`),
				missing: await served(`${base}/embed/nope.js`),
			},
		};
	} finally {
		child.kill('SIGTERM');
		if (child.exitCode === null) await new Promise((r) => child.once('exit', r));
	}
}

describe('a server started from a path', () => {
	it('outside any dot-directory is healthy and serves the page', async () => {
		const { health, page } = await boot(join(root, 'plain', 'apps', 'ui', 'dist'));
		expect(health.status).toBe(200);
		expect(health.body).toMatchObject({ status: 'healthy', bundle: 'ok' });
		expect(page.status).toBe(200);
		expect(page.body).toContain('fixture');
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
		expect(health.body).toMatchObject({ status: 'healthy', bundle: 'ok' });
		expect(page.status).toBe(200);
	}, 60_000);

	it('under a dot-directory reports degraded, and says why on the page instead of a 404', async () => {
		const { health, page } = await boot(join(root, 'repo', '.claude', 'worktrees', 'w', 'apps', 'ui', 'dist'));
		// The invariant first: green /health and a failing page may never coexist.
		expect(health.body.status === 'healthy').toBe(page.status === 200);

		expect(health.status).toBe(503);
		expect(health.body).toMatchObject({ status: 'degraded', bundle: 'unservable' });
		expect(page.status).toBe(503);
		expect(page.body).toContain('.claude');
	}, 60_000);
});
