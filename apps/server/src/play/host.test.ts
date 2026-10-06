/**
 * The JVM pool — warm spare, addressing, ceiling, a spare that dies — against
 * `fixtures/fake-bridge.mjs`, a real child process speaking the bridge's line
 * protocol. CI has no Java; the same paths against a real Forge JVM are in
 * `jvm.test.ts` (the warm-spare run) and measured by `dev/spare-bench.ts`.
 */

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
	CRASH_RECORDS_KEPT,
	CRASH_RECORD_FILES,
	CRASH_RECORD_MAX_AGE_MS,
	JVM_RECORD_FILE,
	BRIDGE_CACHE_MAX_AGE_MS,
	ORPHAN_CLAIM_MS,
	ORPHAN_MAX_MS,
	SPARE_MAX_FAILURES,
	STREAM_FILE,
	bridgeLaunch,
	jvmHostFactory,
	liveJvmCount,
	readJvmRecord,
	sweepRunDirs,
	withHeapCap,
	type BridgeLine,
	type HostEvents,
	type JvmHostConfig,
	type JvmHostFactory,
	type JvmRecord,
	type MatchHost,
	type MatchSpec,
	type ReapResult,
} from './host.js';

const FAKE = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-bridge.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'cardtable-host-test-'));

// The pool runs `<java> <jvm flags> -cp <jar> <bridge source> <args>`; this
// "java" drops everything up to the source and runs the fake with the rest.
// It says so on stderr first, so a crash record has something of its own to keep.
const java = join(scratch, 'java');
writeFileSync(
	java,
	`#!/bin/sh\nwhile [ "$1" != "BRIDGE" ]; do shift; done\nshift\necho "fake-bridge stderr: $*" >&2\nexec "${process.execPath}" "${FAKE}" "$@"\n`,
);
chmodSync(java, 0o755);

const config: JvmHostConfig = {
	java,
	jar: 'unused.jar',
	// Forge's res/, symlinked into every run dir. It holds the marker below, so
	// a cleanup that followed the symlink instead of unlinking it is caught.
	res: join(scratch, 'res'),
	workDir: join(scratch, 'runs'),
	jvmOpts: [],
	bridgeSource: 'BRIDGE',
	bridgeCache: join(scratch, 'bridge-cache'),
	stopGraceMs: 1000,
	warmSpare: true,
};

mkdirSync(config.res);
const RES_MARKER = join(config.res, 'cardsfolder.marker');
writeFileSync(RES_MARKER, 'Forge res — never deleted through a run dir');

const SPEC: MatchSpec = { seats: [{ name: 'Seat 1', ai: false, deck: null }, { name: 'Seat 2', ai: false, deck: null }] };

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

interface Recorder extends HostEvents {
	lines: BridgeLine[];
	exits: string[];
	logs: Record<string, unknown>[];
}

function recorder(): Recorder {
	const r: Recorder = {
		lines: [],
		exits: [],
		logs: [],
		line: (l) => r.lines.push(l),
		exit: (reason) => r.exits.push(reason),
		log: (e) => r.logs.push(e),
	};
	return r;
}

const pools: JvmHostFactory[] = [];
const hosts: MatchHost[] = [];

/** `close()` releases only the spare — a match owns its JVM — so each test's matches are stopped here. */
function track(host: MatchHost): MatchHost {
	hosts.push(host);
	return host;
}

afterEach(async () => {
	for (const h of hosts.splice(0)) h.stop();
	for (const p of pools.splice(0)) p.close();
	delete process.env.FAKE_BRIDGE_MODE;
	await waitUntil(() => liveJvmCount() === 0, 'every child to exit');
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('the warm spare', () => {
	it("hands the booted spare to the next match, which from then on answers to the match's id — and boots a replacement", async () => {
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory(config, { log: (e) => poolLog.push(e) });
		pools.push(pool);
		await waitUntil(() => pool.spare() === 'warm', 'the spare');
		const spareId = poolLog.find((l) => l.evt === 'spare-warm')?.id;

		const events = recorder();
		const host = track(pool('m-000000000001', SPEC, events));
		await waitUntil(() => events.lines.some((l) => l.t === 'ready'), 'ready');
		expect(events.logs.find((l) => l.evt === 'spare-adopted')).toMatchObject({ matchId: 'm-000000000001', from: spareId, warm: true });

		// A command reaches it addressed to the match, and its lines are accepted as the match's.
		host.send({ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } as never });
		await waitUntil(() => events.lines.some((l) => l.t === 'rejected' && l.message === 'echo'), 'the echo');
		expect(events.logs.filter((l) => l.evt === 'bridge-wrong-match')).toEqual([]);

		await waitUntil(() => pool.spare() === 'warm', 'the replacement spare');
		expect(liveJvmCount()).toBe(2);
	});

	it('adopts a spare that is still booting rather than starting a second JVM', async () => {
		const pool = jvmHostFactory(config, { log: () => undefined });
		pools.push(pool);
		expect(pool.spare()).toBe('booting');
		const events = recorder();
		track(pool('m-000000000002', SPEC, events));
		await waitUntil(() => events.lines.some((l) => l.t === 'ready'), 'ready');
		expect(events.logs.find((l) => l.evt === 'spare-adopted')).toMatchObject({ warm: false });
	});

	it('is off when asked: the match starts cold and no spare is kept', async () => {
		const pool = jvmHostFactory(config, { spare: false, log: () => undefined });
		pools.push(pool);
		expect(pool.spare()).toBe('none');
		const events = recorder();
		track(pool('m-000000000003', SPEC, events));
		await waitUntil(() => events.lines.some((l) => l.t === 'ready'), 'ready');
		expect(events.logs.some((l) => l.evt === 'jvm-cold')).toBe(true);
		expect(pool.spare()).toBe('none');
		expect(liveJvmCount()).toBe(1);
	});

	it('close() stops the idle spare', async () => {
		const pool = jvmHostFactory(config, { log: () => undefined });
		await waitUntil(() => pool.spare() === 'warm', 'the spare');
		pool.close();
		await waitUntil(() => liveJvmCount() === 0, 'the spare to exit');
		expect(pool.spare()).toBe('none');
	});
});

describe('the ceiling', () => {
	it('counts the spare: at maxJvms matches there is no spare, and one comes back when a match ends', async () => {
		const pool = jvmHostFactory(config, { maxJvms: 1, log: () => undefined });
		pools.push(pool);
		await waitUntil(() => pool.spare() === 'warm', 'the spare');
		const events = recorder();
		const host = track(pool('m-000000000004', SPEC, events));
		await waitUntil(() => events.lines.some((l) => l.t === 'ready'), 'ready');
		await new Promise((r) => setTimeout(r, 300));
		expect(pool.spare()).toBe('none');
		expect(liveJvmCount()).toBe(1);

		host.stop();
		await waitUntil(() => events.exits.length > 0, 'the match to end');
		expect(events.exits).toEqual(['stopped']);
		await waitUntil(() => pool.spare() === 'warm', 'a spare, once there is room');
		expect(liveJvmCount()).toBe(1);
	});

	it('caps every JVM heap unless the operator names one', () => {
		expect(withHeapCap(['-XX:+UseG1GC'])).toEqual(['-Xmx1g', '-XX:+UseG1GC']);
		expect(withHeapCap(['-Xmx2g'])).toEqual(['-Xmx2g']);
	});
});

describe('the bridge is compiled once per version, not in every JVM', () => {
	// A JDK's bin/: a `java` nobody runs here, and a `javac` that does what the
	// real one is asked to — write `<main>.class` into `-d` — and counts its runs.
	function fixture(javac: 'works' | 'fails' | 'absent') {
		const root = mkdtempSync(join(scratch, 'bridge-'));
		const bin = join(root, 'bin');
		mkdirSync(bin);
		writeFileSync(join(bin, 'java'), '#!/bin/sh\n');
		const runs = join(root, 'javac-runs');
		if (javac !== 'absent') {
			const body =
				javac === 'works'
					? `echo run >> "${runs}"\nwhile [ "$1" != "-d" ]; do shift; done\necho compiled > "$2/Bridge.class"\n`
					: `echo run >> "${runs}"\necho "Bridge.java:1: error: not a statement" >&2\nexit 1\n`;
			writeFileSync(join(bin, 'javac'), `#!/bin/sh\n${body}`);
			chmodSync(join(bin, 'javac'), 0o755);
		}
		const bridgeSource = join(root, 'Bridge.java');
		writeFileSync(bridgeSource, 'class Bridge {}');
		const jar = join(root, 'forge.jar');
		writeFileSync(jar, 'jar');
		const logs: Record<string, unknown>[] = [];
		const cfg: JvmHostConfig = { ...config, java: join(bin, 'java'), jar, bridgeSource, bridgeCache: join(root, 'cache') };
		const javacRuns = (): number => (existsSync(runs) ? readFileSync(runs, 'utf8').trim().split('\n').length : 0);
		return { cfg, logs, javacRuns, launch: () => bridgeLaunch(cfg, (e) => logs.push(e)) };
	}

	it('compiles on the first launch and launches the classes from then on', () => {
		const f = fixture('works');
		const first = f.launch();
		expect(first.how).toBe('compiled');
		const [dir] = readdirSync(f.cfg.bridgeCache);
		expect(first.args).toEqual(['-cp', `${join(f.cfg.bridgeCache, dir as string)}:${f.cfg.jar}`, 'Bridge']);
		expect(f.logs.map((l) => l.evt)).toEqual(['bridge-compiled']);
		expect(f.launch()).toEqual(first);
		expect(f.javacRuns()).toBe(1);
		// Nothing half-made is left beside it.
		expect(readdirSync(f.cfg.bridgeCache)).toEqual([dir]);
	});

	it('an edited bridge is a different version: compiled again, into its own directory', () => {
		const f = fixture('works');
		const before = f.launch();
		writeFileSync(f.cfg.bridgeSource, 'class Bridge { int edited; }');
		const after = f.launch();
		expect(after.how).toBe('compiled');
		expect(after.args[1]).not.toBe(before.args[1]);
		expect(f.javacRuns()).toBe(2);
	});

	it('a compile that fails is logged with javac\'s own words, and the JVM gets the source launcher', () => {
		const f = fixture('fails');
		expect(f.launch()).toEqual({ args: ['-cp', f.cfg.jar, f.cfg.bridgeSource], how: 'source' });
		expect(f.logs).toHaveLength(1);
		expect(f.logs[0]).toMatchObject({ evt: 'bridge-compile-failed' });
		expect(f.logs[0]?.error).toContain('not a statement');
		expect(readdirSync(f.cfg.bridgeCache)).toEqual([]);
	});

	it('with no javac beside java it is the source launcher, and nothing is attempted', () => {
		const f = fixture('absent');
		expect(f.launch()).toEqual({ args: ['-cp', f.cfg.jar, f.cfg.bridgeSource], how: 'source' });
		expect(f.logs).toEqual([]);
		expect(existsSync(f.cfg.bridgeCache)).toBe(false);
	});

	it('a version nobody has launched for BRIDGE_CACHE_MAX_AGE_MS goes when the next one is compiled; a recent one stays', () => {
		const f = fixture('works');
		const old = f.launch().args[1]?.split(':')[0] as string;
		writeFileSync(f.cfg.bridgeSource, 'class Bridge { int recent; }');
		const recent = f.launch().args[1]?.split(':')[0] as string;
		const stale = new Date(Date.now() - BRIDGE_CACHE_MAX_AGE_MS - 60_000);
		utimesSync(old, stale, stale);
		writeFileSync(f.cfg.bridgeSource, 'class Bridge { int newest; }');
		const newest = f.launch().args[1]?.split(':')[0] as string;
		expect(existsSync(old)).toBe(false);
		expect(existsSync(recent)).toBe(true);
		expect(existsSync(newest)).toBe(true);
	});
});

describe('a spare that dies before it is used', () => {
	it(`is replaced, and after ${SPARE_MAX_FAILURES} deaths in a row the pool stops trying and starts matches cold`, async () => {
		process.env.FAKE_BRIDGE_MODE = 'die';
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory(config, { spareRetryMs: 20, log: (e) => poolLog.push(e) });
		pools.push(pool);
		await waitUntil(() => poolLog.some((l) => l.evt === 'spare-disabled'), 'the pool to give up');
		expect(poolLog.filter((l) => l.evt === 'spare-died')).toHaveLength(SPARE_MAX_FAILURES);
		expect(pool.spare()).toBe('none');

		delete process.env.FAKE_BRIDGE_MODE;
		const events = recorder();
		track(pool('m-000000000005', SPEC, events));
		await waitUntil(() => events.lines.some((l) => l.t === 'ready'), 'ready');
		expect(events.logs.some((l) => l.evt === 'jvm-cold')).toBe(true);
	});

	it("a match's own JVM dying is that match's exit, reported with its signal — not a spare death", async () => {
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory(config, { spare: false, log: (e) => poolLog.push(e) });
		pools.push(pool);
		const events = recorder();
		track(pool('m-000000000006', SPEC, events));
		await waitUntil(() => events.lines.some((l) => l.t === 'ready'), 'ready');
		const pid = events.logs.find((l) => l.evt === 'jvm-spawned')?.pid as number;
		process.kill(pid, 'SIGKILL');
		await waitUntil(() => events.exits.length > 0, 'the exit');
		expect(events.exits[0]).toMatch(/^the JVM exited \(code null, signal SIGKILL\)/);
		expect(poolLog.some((l) => l.evt === 'spare-died')).toBe(false);
	});
});

describe('the run directory', () => {
	const runOf = (logs: Record<string, unknown>[]): string => logs.find((l) => l.evt === 'jvm-spawned')?.run as string;

	it("a finished match's directory is gone — and Forge's res behind its symlink is untouched", async () => {
		const pool = jvmHostFactory(config, { spare: false, log: () => undefined });
		pools.push(pool);
		const events = recorder();
		const host = track(pool('m-000000000007', SPEC, events));
		await waitUntil(() => events.lines.some((l) => l.t === 'ready'), 'ready');
		const run = runOf(events.logs);
		expect(existsSync(join(run, 'bridge.stderr.txt'))).toBe(true);

		host.stop();
		await waitUntil(() => events.logs.some((l) => l.evt === 'run-dir-removed'), 'the run dir to be settled');
		expect(events.exits).toEqual(['stopped']);
		expect(existsSync(run)).toBe(false);
		expect(existsSync(RES_MARKER)).toBe(true);
	});

	it("a spare stopped by close() leaves nothing behind", async () => {
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory(config, { log: (e) => poolLog.push(e) });
		await waitUntil(() => pool.spare() === 'warm', 'the spare');
		const run = runOf(poolLog);
		pool.close();
		await waitUntil(() => poolLog.some((l) => l.evt === 'run-dir-removed'), 'the spare dir to be settled');
		expect(existsSync(run)).toBe(false);
	});

	it("a crashed match's diagnostics are still reachable at the path its exit names — pruned to the record", async () => {
		const pool = jvmHostFactory(config, { spare: false, log: () => undefined });
		pools.push(pool);
		const events = recorder();
		track(pool('m-000000000008', SPEC, events));
		await waitUntil(() => events.lines.some((l) => l.t === 'ready'), 'ready');
		const pid = events.logs.find((l) => l.evt === 'jvm-spawned')?.pid as number;
		process.kill(pid, 'SIGKILL');
		await waitUntil(() => events.logs.some((l) => l.evt === 'run-dir-kept'), 'the crash record');

		// The reason a seat's status shows names the file; that file is there and holds the bridge's stderr.
		const named = /; see (.+)$/.exec(events.exits[0] ?? '')?.[1];
		expect(named).toBe(join(runOf(events.logs), 'bridge.stderr.txt'));
		expect(readFileSync(named as string, 'utf8')).toMatch(/^fake-bridge stderr: /);
		const run = dirname(named as string);
		expect(readdirSync(run).sort()).toEqual([...CRASH_RECORD_FILES].sort());
		expect(JSON.parse(readFileSync(join(run, 'config.json'), 'utf8'))).toMatchObject({ matchId: 'm-000000000008' });
		expect(JSON.parse(readFileSync(join(run, 'crash.json'), 'utf8'))).toMatchObject({ id: 'm-000000000008', code: null, signal: 'SIGKILL' });
		expect(existsSync(RES_MARKER)).toBe(true);
	});
});

describe('the boot sweep — against a fixture work dir, never the real one', () => {
	const DAY = 24 * 60 * 60 * 1000;

	/** A run dir as `stageRunDir` leaves one, dated `ageMs` ago. */
	function staged(root: string, name: string, ageMs: number, crashAt?: number): string {
		const dir = join(root, name);
		mkdirSync(join(dir, 'user', 'decks'), { recursive: true });
		symlinkSync(config.res, join(dir, 'res'));
		writeFileSync(join(dir, 'bridge.stderr.txt'), `stderr of ${name}\n`);
		if (crashAt !== undefined) writeFileSync(join(dir, 'crash.json'), JSON.stringify({ id: name, at: new Date(crashAt).toISOString() }));
		const t = new Date(Date.now() - ageMs);
		utimesSync(dir, t, t);
		return dir;
	}

	it('removes dead run dirs, and spares a live one, a fresh one, crash records within the bound, and anything not ours', async () => {
		const root = mkdtempSync(join(scratch, 'sweep-'));
		const now = Date.now();
		const dead = staged(root, 'm-aaaaaaaaaaaa', DAY);
		const deadSpare = staged(root, 'spare-bbbbbbbbbbbb', DAY);
		const live = staged(root, 'm-cccccccccccc', DAY);
		const fresh = staged(root, 'm-dddddddddddd', 0);
		const crash = staged(root, 'm-eeeeeeeeeeee', DAY, now - DAY);
		const stale = staged(root, 'm-ffffffffffff', 8 * DAY, now - 8 * DAY);
		const notOurs = join(root, 'keep-me');
		mkdirSync(notOurs);
		utimesSync(notOurs, new Date(now - DAY), new Date(now - DAY));
		const notADir = join(root, 'm-0123456789ab');
		writeFileSync(notADir, 'a file with a run-dir name');

		// A real process standing in the live dir, as a JVM stands in its run dir.
		const squatter = spawn('sleep', ['30'], { cwd: live, stdio: 'ignore' });
		await waitUntil(() => squatter.pid !== undefined, 'the squatter');
		try {
			const swept = sweepRunDirs(root, now);
			expect(swept.skipped).toBeUndefined();
			expect(swept.removed.sort()).toEqual(['m-aaaaaaaaaaaa', 'spare-bbbbbbbbbbbb']);
			expect(swept.live).toEqual(['m-cccccccccccc']);
			expect(swept.fresh).toEqual(['m-dddddddddddd']);
			expect(swept.crashes).toEqual({ kept: ['m-eeeeeeeeeeee'], removed: ['m-ffffffffffff'] });
		} finally {
			squatter.kill('SIGKILL');
		}
		expect([dead, deadSpare, stale].map(existsSync)).toEqual([false, false, false]);
		expect([live, fresh, crash, notOurs, notADir].map(existsSync)).toEqual([true, true, true, true, true]);
		expect(readFileSync(join(crash, 'bridge.stderr.txt'), 'utf8')).toBe('stderr of m-eeeeeeeeeeee\n');
		expect(existsSync(RES_MARKER)).toBe(true);
	});

	it(`keeps the newest ${CRASH_RECORDS_KEPT} crash records and removes the rest`, () => {
		const root = mkdtempSync(join(scratch, 'sweep-'));
		const now = Date.now();
		const names = Array.from({ length: CRASH_RECORDS_KEPT + 2 }, (_, i) => `m-${i.toString(16).padStart(12, '0')}`);
		// m-…00 is the newest; the last two are the oldest, still inside the age bound.
		names.forEach((n, i) => staged(root, n, DAY, now - (i + 1) * (CRASH_RECORD_MAX_AGE_MS / 100)));
		const swept = sweepRunDirs(root, now);
		expect(swept.crashes.kept).toEqual(names.slice(0, CRASH_RECORDS_KEPT));
		expect(swept.crashes.removed).toEqual(names.slice(CRASH_RECORDS_KEPT));
		expect(readdirSync(root).sort()).toEqual(names.slice(0, CRASH_RECORDS_KEPT));
	});

	it('runs when the pool is made, and logs what it did', () => {
		const root = mkdtempSync(join(scratch, 'sweep-'));
		const dead = staged(root, 'm-aaaaaaaaaaaa', DAY);
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory({ ...config, workDir: root }, { spare: false, log: (e) => poolLog.push(e) });
		pools.push(pool);
		expect(existsSync(dead)).toBe(false);
		expect(poolLog.find((l) => l.evt === 'run-dirs-swept')).toMatchObject({ workDir: root, removed: 1, live: [], fresh: [] });
	});
});

/* ── A match that outlives its server (Wave 22 §E) ───────────────────── */

describe('a JVM that outlives the process that started it', () => {
	/** `tsx`, because `host.ts` uses parameter properties and node cannot strip those. */
	const TSX = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '.bin', 'tsx');
	const HOST = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'host.ts')).href;

	/**
	 * A whole other server, in its own process: it starts one match, waits for
	 * `ready`, and then DIES without stopping it — the shape of a `pm2 restart`
	 * with no handler, or of a SIGKILL. What it leaves behind is the only thing
	 * the next process gets: a run directory, two fifos, `jvm.json`,
	 * `stream.jsonl`, and a JVM still running in it.
	 */
	const maker = join(scratch, 'other-server.mts');
	writeFileSync(
		maker,
		[
			`import { jvmHostFactory } from ${JSON.stringify(HOST)};`,
			'const args = JSON.parse(process.argv[2]);',
			'const pool = jvmHostFactory(args.config, { spare: false, sweep: false, log: () => undefined });',
			'pool(args.matchId, args.spec, {',
			"  line: (l) => { if (l.t === 'ready') { process.stdout.write('READY\\n'); setTimeout(() => process.exit(0), 50); } },",
			'  exit: () => undefined,',
			'  log: () => undefined,',
			'});',
			'',
		].join('\n'),
	);

	/** Run that other server to completion. Returns the work dir it left behind. */
	async function otherServer(matchId: string): Promise<string> {
		const workDir = mkdtempSync(join(scratch, 'outlive-'));
		const child = spawn(TSX, [maker, JSON.stringify({ config: { ...config, workDir }, matchId, spec: SPEC })], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		let err = '';
		child.stdout.on('data', (d: Buffer) => (out += d.toString()));
		child.stderr.on('data', (d: Buffer) => (err += d.toString()));
		const code = await new Promise<number | null>((done) => child.on('exit', (c) => done(c)));
		if (code !== 0 || !out.includes('READY')) throw new Error(`the other server did not reach ready (code ${code}): ${err || out}`);
		return workDir;
	}

	const strays: number[] = [];
	afterEach(() => {
		for (const pid of strays.splice(0)) {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {
				// Already gone, which is what we wanted.
			}
		}
	});

	it('is still running after that process is gone, and names itself on disk', async () => {
		const matchId = 'm-0000000000a1';
		const workDir = await otherServer(matchId);
		const record = readJvmRecord(join(workDir, matchId));
		expect(record).not.toBeNull();
		const live = record as JvmRecord;
		strays.push(live.pid);
		expect(live.matchId).toBe(matchId);
		// The process that started it is gone; this one never knew it.
		expect(() => process.kill(live.pid, 0)).not.toThrow();
		expect(readlinkSync(`/proc/${live.pid}/cwd`)).toBe(join(workDir, matchId));
		// And everything a replay needs is beside it.
		expect(readFileSync(join(workDir, matchId, STREAM_FILE), 'utf8')).toContain('"ready"');
	}, 30_000);

	it('is offered back by the next pool, replayed into the new match, and still answers what we send it', async () => {
		const matchId = 'm-0000000000a2';
		const workDir = await otherServer(matchId);
		strays.push((readJvmRecord(join(workDir, matchId)) as JvmRecord).pid);

		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory({ ...config, workDir }, { spare: false, log: (e) => poolLog.push(e) });
		pools.push(pool);
		// The boot sweep spared it AND said whose it is.
		expect(poolLog.find((l) => l.evt === 'run-dirs-swept')).toMatchObject({ live: [matchId], orphans: [matchId], removed: 0 });
		const offered = pool.orphans();
		expect(offered.map((o) => o.matchId)).toEqual([matchId]);

		const events = recorder();
		const host = track(pool.attach(offered[0] as JvmRecord, events));
		// The replay handed the new match everything the dead one had read.
		expect(events.lines.map((l) => l.t)).toContain('ready');
		expect(events.logs.find((l) => l.evt === 'match-resumed')).toMatchObject({ matchId, replayed: 1 });

		// And the transport works in the other direction too: the fake bridge echoes
		// a command back, addressed to this match, over the re-opened fifos.
		host.send({ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } });
		await waitUntil(() => events.lines.some((l) => l.t === 'rejected'), 'the echo from the re-attached JVM');
		expect(events.lines.filter((l) => l.t === 'rejected')).toMatchObject([{ message: 'echo', command: 'act' }]);
	}, 30_000);

	it('is killed when nobody claims it, so ignoring orphans() cannot leak a JVM', async () => {
		const matchId = 'm-0000000000a3';
		const workDir = await otherServer(matchId);
		const pid = (readJvmRecord(join(workDir, matchId)) as JvmRecord).pid;
		strays.push(pid);

		const pool = jvmHostFactory({ ...config, workDir }, { spare: false, log: () => undefined });
		pools.push(pool);
		expect(pool.orphans()).toHaveLength(1);
		// The deadline is a minute in production; here it is reached by hand, the
		// same way the pool's own timer would reach it.
		expect(ORPHAN_CLAIM_MS).toBeGreaterThan(0);
		const swept = sweepRunDirs(workDir, Date.now() + ORPHAN_MAX_MS + 1);
		expect(swept.killed).toEqual([matchId]);
		await waitUntil(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		}, 'the unclaimed JVM to be killed');
		expect(existsSync(join(workDir, matchId))).toBe(false);
	}, 30_000);
});

describe('handing a match over on the way out', () => {
	it('lets go without killing, and a second pool takes it back', async () => {
		const workDir = mkdtempSync(join(scratch, 'handover-'));
		const first = jvmHostFactory({ ...config, workDir }, { spare: false, log: () => undefined });
		pools.push(first);
		const events = recorder();
		first('m-0000000000b1', SPEC, events);
		await waitUntil(() => events.lines.some((l) => l.t === 'ready'), 'ready');
		const pid = (readJvmRecord(join(workDir, 'm-0000000000b1')) as JvmRecord).pid;

		const handed = first.handOverAll();
		expect(handed).toEqual(['m-0000000000b1']);
		expect(liveJvmCount()).toBe(0);
		// Handed over, not stopped: it is still playing, and its record says when.
		expect(() => process.kill(pid, 0)).not.toThrow();
		expect(readJvmRecord(join(workDir, 'm-0000000000b1'))?.orphanedAt).toEqual(expect.any(String));

		const second = jvmHostFactory({ ...config, workDir }, { spare: false, log: () => undefined });
		pools.push(second);
		const back = second.orphans();
		expect(back.map((o) => o.matchId)).toEqual(['m-0000000000b1']);
		const resumed = recorder();
		track(second.attach(back[0] as JvmRecord, resumed));
		expect(resumed.lines.map((l) => l.t)).toEqual(['ready']);
	}, 20_000);
});

describe('the boot sweep and a live directory it can identify', () => {
	/** A live run dir with a `jvm.json` naming the process standing in it. */
	async function squatted(root: string, name: string, patch: Partial<JvmRecord> = {}): Promise<{ dir: string; pid: number; kill(): void }> {
		const dir = join(root, name);
		mkdirSync(dir, { recursive: true });
		const squatter = spawn('sleep', ['30'], { cwd: dir, stdio: 'ignore' });
		await waitUntil(() => squatter.pid !== undefined, 'the squatter');
		const pid = squatter.pid as number;
		writeFileSync(
			join(dir, JVM_RECORD_FILE),
			JSON.stringify({
				matchId: name,
				pid,
				run: dir,
				startedAt: new Date().toISOString(),
				epoch: `${name}:1`,
				owners: ['fk:aaaaaaaaaaaaaaaa', null],
				spec: SPEC,
				...patch,
			}),
		);
		return { dir, pid, kill: () => squatter.kill('SIGKILL') };
	}

	it("offers a live match back, with the epoch and owners it wrote down", async () => {
		const root = mkdtempSync(join(scratch, 'ident-'));
		const s = await squatted(root, 'm-00000000c001');
		try {
			const swept = sweepRunDirs(root);
			expect(swept.live).toEqual(['m-00000000c001']);
			expect(swept.killed).toEqual([]);
			expect(swept.orphans).toMatchObject([{ matchId: 'm-00000000c001', pid: s.pid, epoch: 'm-00000000c001:1', owners: ['fk:aaaaaaaaaaaaaaaa', null] }]);
			expect(existsSync(s.dir)).toBe(true);
		} finally {
			s.kill();
		}
	});

	it('ends a live SPARE from its own record: a spare holds no game and nothing will come back for it', async () => {
		const root = mkdtempSync(join(scratch, 'ident-'));
		const s = await squatted(root, 'spare-00000000c002', { spare: true, spec: null });
		try {
			const swept = sweepRunDirs(root);
			expect(swept.killed).toEqual(['spare-00000000c002']);
			expect(swept.live).toEqual([]);
			expect(swept.orphans).toEqual([]);
			expect(existsSync(s.dir)).toBe(false);
			await waitUntil(() => {
				try {
					process.kill(s.pid, 0);
					return false;
				} catch {
					return true;
				}
			}, 'the spare to be killed');
		} finally {
			s.kill();
		}
	});

	it(`ends a live match that has been an orphan for longer than ORPHAN_MAX_MS rather than offering it back`, async () => {
		const root = mkdtempSync(join(scratch, 'ident-'));
		const old = new Date(Date.now() - ORPHAN_MAX_MS - 1).toISOString();
		const s = await squatted(root, 'm-00000000c003', { orphanedAt: old });
		try {
			const swept = sweepRunDirs(root);
			expect(swept.killed).toEqual(['m-00000000c003']);
			expect(swept.orphans).toEqual([]);
			expect(existsSync(s.dir)).toBe(false);
		} finally {
			s.kill();
		}
	});

	it("leaves a live directory alone when its record names a DIFFERENT process — it may be another server's", async () => {
		const root = mkdtempSync(join(scratch, 'ident-'));
		// A record that lies about the pid: the live-process guard still spares the
		// directory, because a dir it cannot identify is never one it may remove.
		const s = await squatted(root, 'm-00000000c004', { pid: 999_999_999, spare: true });
		try {
			const swept = sweepRunDirs(root);
			expect(swept.killed).toEqual([]);
			expect(swept.live).toEqual(['m-00000000c004']);
			expect(swept.orphans).toEqual([]);
			expect(existsSync(s.dir)).toBe(true);
		} finally {
			s.kill();
		}
	});
});

/*
 * ── Going down: what must die before we do (Wave 22, lane U) ─────────────
 *
 * The wave made a LIVE match outlive its server on purpose. This is the other
 * half of that bargain: everything the server did NOT hand over has to be gone
 * before the server is. Both halves are asserted off the SAME `reapOnExit()`
 * call on the SAME pool, so a pass cannot be a mix-up about which JVM is which.
 */
describe('going down: what must die before we do', () => {
	/**
	 * A stand-in for a bridge that will not go quietly — which, on a deploy's
	 * timescale, is what the real one measurably IS. Lane U timed a live match
	 * JVM on this host: `{"t":"stop"}` → gone in **9355 ms**, SIGTERM → gone in
	 * **4322 ms**, SIGKILL → gone in **0 ms**, with pm2 SIGKILLing the server
	 * after `kill_timeout` (1.6 s). So this one ignores the stop line and ignores
	 * SIGTERM, and only an insisting shutdown ends it. `fake-bridge.mjs` exits on
	 * `stop`, which would go green whether anything insisted or not.
	 */
	const javaDeaf = join(scratch, 'java-deaf');
	writeFileSync(javaDeaf, `#!/bin/sh\nexec "${process.execPath}" -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'\n`);
	chmodSync(javaDeaf, 0o755);

	const ENDED = 'm-0000000000c1';
	const HANDED = 'm-0000000000c2';

	/** Alive and not a zombie: the question `host.ts` and `e2e/play.spec.ts` both ask of `/proc`. */
	function running(pid: number): boolean {
		try {
			return !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
		} catch {
			return false; // no /proc entry: it has exited
		}
	}

	const strays: number[] = [];
	afterEach(() => {
		for (const pid of strays.splice(0)) {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {
				// Already gone, which is what we wanted.
			}
		}
	});

	interface Deaf {
		host: MatchHost;
		pid: number;
		run: string;
		events: Recorder;
	}

	/** One cold match on a JVM that answers nothing. It never says `ready`; it only exists. */
	async function deafMatch(pool: JvmHostFactory, matchId: string): Promise<Deaf> {
		const events = recorder();
		const host = pool(matchId, SPEC, events);
		await waitUntil(() => events.logs.some((l) => l.evt === 'jvm-spawned'), `${matchId} to be spawned`);
		const spawned = events.logs.find((l) => l.evt === 'jvm-spawned') as { pid: number; run: string };
		strays.push(spawned.pid);
		// `/bin/sh` execs into it, so wait until the process that holds the pid is
		// the one standing in the run dir — which is what the kill confirms against.
		await waitUntil(() => {
			try {
				return readlinkSync(`/proc/${spawned.pid}/cwd`) === spawned.run;
			} catch {
				return false;
			}
		}, `${matchId} to be standing in its run dir`);
		return { host, pid: spawned.pid, run: spawned.run, events };
	}

	/**
	 * Exactly what `PlayHandle.shutdown` does, in its order: hand over the match
	 * that can outlive us, ask the one that cannot to stop — and then reap, which
	 * is the step that did not exist.
	 */
	async function shutdownWith(matchIds: { handed: string; ended: string }): Promise<{ handed: Deaf; ended: Deaf; reaped: ReapResult }> {
		const workDir = mkdtempSync(join(scratch, 'reap-'));
		const pool = jvmHostFactory({ ...config, java: javaDeaf, workDir }, { spare: false, log: () => undefined });
		pools.push(pool);
		const handed = await deafMatch(pool, matchIds.handed);
		const ended = await deafMatch(pool, matchIds.ended);
		handed.host.remember?.({ epoch: 'e-1', owners: ['p-alice', 'p-bob'] });
		expect(handed.host.handOver?.()).toBe(true);
		ended.host.stop();
		// Asked, and still there: a polite stop is not a guarantee, which is the
		// whole reason the step below exists.
		expect(running(ended.pid)).toBe(true);
		return { handed, ended, reaped: pool.reapOnExit() };
	}

	it('an ENDED match is gone once the shutdown path has run — nothing else was going to end it, and asking is not enough', async () => {
		const { ended, reaped } = await shutdownWith({ handed: HANDED, ended: ENDED });
		expect(reaped.killed).toEqual([ENDED]);
		expect(reaped.left).toEqual([]);
		expect(running(ended.pid)).toBe(false);
		// And its run directory goes with it, so no successor is offered a finished
		// game and the next boot's `RUN_DIR_FRESH_MS` window has nothing to spare.
		expect(existsSync(ended.run)).toBe(false);
	}, 20_000);

	it('a HANDED-OVER match is still alive after that same reap, standing in its run dir with its orphanedAt', async () => {
		const { handed, reaped } = await shutdownWith({ handed: HANDED, ended: ENDED });
		// Deliberately says nothing about the OTHER JVM's fate: that is the test
		// above, and these two must be able to fail separately or neither of them
		// tells you which half broke.
		expect(reaped.killed).not.toContain(HANDED);
		expect(running(handed.pid)).toBe(true);
		// Re-attachable, asked the way `orphans()` asks it.
		expect(readlinkSync(`/proc/${handed.pid}/cwd`)).toBe(handed.run);
		const record = readJvmRecord(handed.run) as JvmRecord;
		expect(record.orphanedAt).toEqual(expect.any(String));
		expect([record.pid, record.epoch, record.owners]).toEqual([handed.pid, 'e-1', ['p-alice', 'p-bob']]);
	}, 20_000);

	it('refuses to signal a pid that is not the process standing in that run dir, and says the JVM was LEFT', async () => {
		const workDir = mkdtempSync(join(scratch, 'reap-guard-'));
		const pool = jvmHostFactory({ ...config, java: javaDeaf, workDir }, { spare: false, log: () => undefined });
		pools.push(pool);
		const jvm = await deafMatch(pool, 'm-0000000000c3');

		// Move the directory and that pid is standing somewhere else — which is
		// exactly what a RECYCLED pid looks like, and the one case where signalling
		// it would kill a stranger's process.
		renameSync(jvm.run, `${jvm.run}-moved`);
		expect(pool.reapOnExit()).toMatchObject({ killed: [], left: ['m-0000000000c3'] });
		expect(running(jvm.pid)).toBe(true);
		expect(jvm.events.logs.filter((l) => l.evt === 'jvm-reap-refused').map((l) => l.pid)).toEqual([jvm.pid]);

		// Put it back and the same call ends it: the refusal is about identity, not
		// about giving up, and `reapOnExit` is idempotent.
		renameSync(`${jvm.run}-moved`, jvm.run);
		expect(pool.reapOnExit()).toMatchObject({ killed: ['m-0000000000c3'], left: [] });
		expect(running(jvm.pid)).toBe(false);
	}, 20_000);

	it('reaps the idle spare too, even after close() has forgotten it — it holds no game and must not outlive us', async () => {
		const workDir = mkdtempSync(join(scratch, 'reap-spare-'));
		const pool = jvmHostFactory({ ...config, java: javaDeaf, workDir }, { log: () => undefined });
		pools.push(pool);
		await waitUntil(() => readdirSync(workDir).some((d) => d.startsWith('spare-')), 'the spare to be staged');
		const dir = readdirSync(workDir).find((d) => d.startsWith('spare-')) as string;
		const spare = readJvmRecord(join(workDir, dir)) as JvmRecord;
		strays.push(spare.pid);
		await waitUntil(() => running(spare.pid), 'the spare to be running');

		pool.close();
		// A real spare takes ~314 ms to `halt(0)`; this one never will.
		expect(running(spare.pid)).toBe(true);
		expect(pool.reapOnExit().killed).toEqual([spare.matchId]);
		expect(running(spare.pid)).toBe(false);
		expect(existsSync(join(workDir, dir))).toBe(false);
	}, 20_000);
});
