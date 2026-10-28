/**
 * The coordinator — placement into shared JVMs, routing by match id, a JVM's death failing every
 * match on it, the warm JVM, re-attach per JVM, going down — against `fixtures/fake-bridge.mjs`,
 * a real child process speaking the `--host` bridge's line protocol. CI has no Java; the same
 * paths against a real Forge JVM are the jar suites (`multi-match`, `liveness`, `match`, …).
 */

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
	BRIDGE_JVM_FLAGS,
	CRASH_RECORDS_KEPT,
	bridgeDiagnostics,
	CRASH_RECORD_FILES,
	CRASH_RECORD_MAX_AGE_MS,
	JVM_RECORD_FILE,
	BRIDGE_CACHE_MAX_AGE_MS,
	MATCH_STOP_MS,
	ORPHAN_MAX_MS,
	WARM_MAX_FAILURES,
	bridgeLaunch,
	jvmHostFactory,
	liveJvmCount,
	readJvmRecord,
	streamFile,
	sweepRunDirs,
	type BridgeLine,
	type HostEvents,
	type JvmHostConfig,
	type JvmHostFactory,
	type MatchHost,
	type MatchSpec,
	type ReapResult,
} from './host.js';
import type { JvmLauncher, JvmTransport } from './jvm-transport.js';
import { queueColdStarts } from './start-queue.js';
import { LAUNCH_RECORD_FILE, readLaunchRecord } from './local-jvm.js';

const FAKE = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-bridge.mjs');
// A slow case's own budget, which must never undercut CI's (vitest.config.ts):
// 20 s here, 60 s on a shared CI runner where the default is already 30 s.
const SLOW_TIMEOUT = process.env.CI ? 60_000 : 20_000;

const scratch = mkdtempSync(join(tmpdir(), 'cardtable-host-test-'));

// The pool runs `<java> <jvm flags> -cp <jar> <bridge source> --host <hostId>`; this
// "java" drops everything up to the source and runs the fake with the rest.
// It says so on stderr first, so a crash record has something of its own to keep.
const java = join(scratch, 'java');
writeFileSync(
	java,
	`#!/bin/sh\nargv="$*"\nwhile [ "$1" != "BRIDGE" ]; do shift; done\nshift\necho "fake-bridge stderr: $*" >&2\necho "fake-java argv: $argv" >&2\nexec "${process.execPath}" "${FAKE}" "$@"\n`,
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
	warmJvm: true,
	perJvm: 2,
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

const ready = (r: Recorder): boolean => r.lines.some((l) => l.t === 'ready');

const pools: JvmHostFactory[] = [];
const hosts: MatchHost[] = [];

/** `close()` retires only idle JVMs — a JVM keeps its matches — so each test's matches are stopped here. */
function track(host: MatchHost): MatchHost {
	hosts.push(host);
	return host;
}

/** The pid and run directory of a JVM this pool launched, from its log. */
function spawned(log: Record<string, unknown>[], hostId: string): { pid: number; run: string } {
	const l = log.find((e) => e.evt === 'jvm-spawned' && e.id === hostId) as { pid: number; run: string } | undefined;
	if (l === undefined) throw new Error(`no jvm-spawned for ${hostId}`);
	return l;
}

/** Alive and not a zombie: the question `local-jvm.ts` and `e2e/play.spec.ts` both ask of `/proc`. */
function running(pid: number): boolean {
	try {
		return !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
	} catch {
		return false;
	}
}

afterEach(async () => {
	for (const h of hosts.splice(0)) h.stop();
	for (const p of pools.splice(0)) p.close();
	delete process.env.FAKE_BRIDGE_MODE;
	delete process.env.FAKE_BRIDGE_DEAF_STOP;
	await waitUntil(() => liveJvmCount() === 0, 'every child to exit');
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('placement: matches share a JVM, up to perJvm each', () => {
	it('places matches into the warm JVM until it is full, routes each line to its own match, and keeps a JVM with room booted behind it', async () => {
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory(config, { log: (e) => poolLog.push(e) });
		pools.push(pool);
		await waitUntil(() => pool.room() === 'warm', 'the warm JVM');
		const first = pool.jvms()[0]!.hostId;

		const [a, b] = [recorder(), recorder()];
		const hostA = track(pool('m-000000000001', SPEC, a));
		const hostB = track(pool('m-000000000002', SPEC, b));
		await waitUntil(() => ready(a) && ready(b), 'both ready');
		expect([a, b].map((r) => r.logs.find((l) => l.evt === 'match-placed')?.hostId)).toEqual([first, first]);
		// Full at perJvm = 2: another JVM was launched behind it.
		await waitUntil(() => pool.room() === 'warm' && pool.jvms().length === 2, 'the next warm JVM');
		expect(liveJvmCount()).toBe(2);

		// Each command reaches its own match, and each answer comes back to it alone.
		hostA.send({ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } as never });
		await waitUntil(() => a.lines.some((l) => l.t === 'rejected' && l.message === 'echo'), "A's echo");
		await new Promise((r) => setTimeout(r, 100));
		expect(b.lines.map((l) => l.t)).toEqual(['ready']);
		expect(poolLog.filter((l) => l.evt === 'bridge-wrong-match' || l.evt === 'bridge-noise')).toEqual([]);

		// A match's exit is its own `stopped`; the other plays on in the same JVM.
		hostB.stop();
		await waitUntil(() => b.exits.length > 0, "B's stop");
		expect(b.exits).toEqual(['stopped']);
		expect(a.exits).toEqual([]);
		expect(pool.jvms().find((j) => j.hostId === first)?.matches).toEqual(['m-000000000001']);
		expect(readJvmRecord(join(config.workDir, first))?.matches.map((m) => m.matchId)).toEqual(['m-000000000001']);
	});

	it('places into a JVM still booting rather than launching a second, and says so through room()', async () => {
		const pool = jvmHostFactory(config, { log: () => undefined });
		pools.push(pool);
		await pool.orphans();
		expect(pool.room()).toBe('booting');
		expect(pool.booting()).toBe(1);
		const events = recorder();
		track(pool('m-000000000003', SPEC, events));
		await waitUntil(() => ready(events), 'ready');
		expect(events.logs.find((l) => l.evt === 'match-placed')).toMatchObject({ warm: false, matches: 1 });
		expect(liveJvmCount()).toBe(1);
	});

	it('with no warm JVM wanted, a match launches its own, and the JVM is retired when its last match ends', async () => {
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory(config, { warm: false, log: (e) => poolLog.push(e) });
		pools.push(pool);
		expect(pool.room()).toBe('none');
		const events = recorder();
		const host = pool('m-000000000004', SPEC, events);
		await waitUntil(() => ready(events), 'ready');
		expect(liveJvmCount()).toBe(1);
		host.stop();
		await waitUntil(() => liveJvmCount() === 0, 'the empty JVM to be retired');
		expect(events.exits).toEqual(['stopped']);
		expect(poolLog.find((l) => l.evt === 'jvm-retired')?.why).toBe('no match left, and no JVM is kept warm');
		// Asked to go, and went: a clean end, so its directory is gone.
		expect(poolLog.some((l) => l.evt === 'run-dir-removed')).toBe(true);
	});

	it('refuses a match when every JVM is full at maxJvms, and leaves nothing behind', async () => {
		const pool = jvmHostFactory({ ...config, perJvm: 1 }, { maxJvms: 1, log: () => undefined });
		pools.push(pool);
		const events = recorder();
		track(pool('m-000000000005', SPEC, events));
		await waitUntil(() => ready(events), 'ready');
		expect(pool.room()).toBe('none');
		expect(() => pool('m-000000000006', SPEC, recorder())).toThrow(/every Forge JVM is full \(1 of 1, 1 matches each\)/);
		expect(liveJvmCount()).toBe(1);
	});

	it('a start the bridge refuses ends that match alone, with the bridge\'s words', async () => {
		process.env.FAKE_BRIDGE_MODE = 'refuse';
		const pool = jvmHostFactory(config, { warm: false, log: () => undefined });
		pools.push(pool);
		const events = recorder();
		pool('m-000000000007', SPEC, events);
		await waitUntil(() => events.exits.length > 0, 'the refusal');
		expect(events.lines).toEqual([{ t: 'fatal', message: 'Forge refused the match: java.lang.IllegalArgumentException: no deck' }]);
		expect(events.exits).toEqual(['Forge failed: Forge refused the match: java.lang.IllegalArgumentException: no deck']);
	});

	it('a match whose stop is never answered is let go after matchStopMs; its JVM keeps its other matches', async () => {
		expect(MATCH_STOP_MS).toBeGreaterThan(10_000);
		process.env.FAKE_BRIDGE_DEAF_STOP = '1';
		const pool = jvmHostFactory(config, { warm: false, matchStopMs: 300, log: () => undefined });
		pools.push(pool);
		const [a, b] = [recorder(), recorder()];
		const host = pool('m-000000000008', SPEC, a);
		track(pool('m-000000000009', SPEC, b));
		await waitUntil(() => ready(a) && ready(b), 'ready');
		host.stop();
		await new Promise((r) => setTimeout(r, 100));
		expect(a.exits).toEqual([]);
		await waitUntil(() => a.exits.length > 0, 'the stop to be given up on');
		expect(a.exits).toEqual(['stopped']);
		expect(a.logs.find((l) => l.evt === 'match-stop-unanswered')).toMatchObject({ matchId: 'm-000000000008', afterMs: 300 });
		expect(pool.jvms()[0]?.matches).toEqual(['m-000000000009']);
		expect(b.exits).toEqual([]);
		pool.reapOnExit();
	});
});

describe('a JVM that dies fails every match on it', () => {
	it("SIGKILLed: every match on it exits with the JVM's reason, and the death is logged as a lost JVM", async () => {
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory(config, { warm: false, log: (e) => poolLog.push(e) });
		pools.push(pool);
		const [a, b] = [recorder(), recorder()];
		pool('m-000000000011', SPEC, a);
		pool('m-000000000012', SPEC, b);
		await waitUntil(() => ready(a) && ready(b), 'both ready');
		const hostId = pool.jvms()[0]!.hostId;
		process.kill(spawned(poolLog, hostId).pid, 'SIGKILL');
		await waitUntil(() => a.exits.length > 0 && b.exits.length > 0, 'both exits');
		for (const r of [a, b]) expect(r.exits[0]).toMatch(/^the JVM exited \(code null, signal SIGKILL\); see .+bridge\.stderr\.txt$/);
		expect(poolLog.find((l) => l.evt === 'jvm-lost')).toMatchObject({ level: 'error', id: hostId, matches: ['m-000000000011', 'm-000000000012'] });
		// A crash: the record stays, pruned, with every match's decks in its jvm.json.
		const run = spawned(poolLog, hostId).run;
		await waitUntil(() => existsSync(join(run, 'crash.json')), 'the crash record');
		expect(readdirSync(run).sort()).toEqual([...CRASH_RECORD_FILES].sort());
		expect(readJvmRecord(run)?.matches.map((m) => m.matchId)).toEqual(['m-000000000011', 'm-000000000012']);
		expect(readFileSync(join(run, 'bridge.stderr.txt'), 'utf8')).toMatch(/^fake-bridge stderr: --host h-/);
		expect(existsSync(RES_MARKER)).toBe(true);
	});

	it(`JVMs that die booting are retried, and after ${WARM_MAX_FAILURES} in a row none is kept warm; a match still launches its own`, async () => {
		process.env.FAKE_BRIDGE_MODE = 'die';
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory(config, { warmRetryMs: 20, log: (e) => poolLog.push(e) });
		pools.push(pool);
		await waitUntil(() => poolLog.some((l) => l.evt === 'warm-disabled'), 'the pool to give up');
		expect(poolLog.filter((l) => l.evt === 'jvm-boot-failed')).toHaveLength(WARM_MAX_FAILURES);
		expect(pool.room()).toBe('none');

		delete process.env.FAKE_BRIDGE_MODE;
		const events = recorder();
		track(pool('m-000000000013', SPEC, events));
		await waitUntil(() => ready(events), 'ready');
	});
});

// hosting-test-plan H2/C2: a SIGSTOPped bridge kept its match `running` for 3+ minutes.
describe('liveness: a JVM that stops saying anything is killed, and every match on it told why', () => {
	afterEach(() => {
		delete process.env.FAKE_BRIDGE_ALIVE_MS;
	});

	it('a JVM that keeps saying alive is left alone; the same JVM SIGSTOPped is killed within the window, through the exit path', async () => {
		process.env.FAKE_BRIDGE_ALIVE_MS = '100';
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory({ ...config, unresponsiveMs: 1500 }, { warm: false, sweep: false, log: (e) => poolLog.push(e) });
		pools.push(pool);
		const [a, b] = [recorder(), recorder()];
		pool('m-0000000000f1', SPEC, a);
		pool('m-0000000000f2', SPEC, b);
		await waitUntil(() => ready(a) && ready(b), 'ready');
		const hostId = pool.jvms()[0]!.hostId;
		await new Promise((r) => setTimeout(r, 2500));
		expect(a.exits).toEqual([]);
		// Liveness is never a match's line, never kept for a replay, and never noise.
		expect(a.lines.map((l) => l.t)).toEqual(['ready']);
		expect(readFileSync(streamFile(join(config.workDir, hostId), 'm-0000000000f1'), 'utf8')).not.toContain('alive');
		expect(poolLog.filter((l) => l.evt === 'bridge-noise' || l.evt === 'bridge-wrong-match' || l.evt === 'bridge-host-line')).toEqual([]);

		const { pid, run } = spawned(poolLog, hostId);
		const stoppedAt = Date.now();
		process.kill(pid, 'SIGSTOP');
		await waitUntil(() => a.exits.length > 0 && b.exits.length > 0, 'the stopped JVM to be failed', 5000);
		expect(Date.now() - stoppedAt).toBeLessThan(1500 + 2000);
		for (const r of [a, b]) expect(r.exits[0]).toMatch(/^the JVM stopped answering \(nothing from it for \d+ s\), so it was killed$/);
		expect(poolLog.find((l) => l.evt === 'jvm-unresponsive')).toMatchObject({ id: hostId, matches: ['m-0000000000f1', 'm-0000000000f2'] });
		expect(liveJvmCount()).toBe(0);
		// Killed without being asked to go: a crash, so its record is kept like any other.
		expect(existsSync(join(run, 'crash.json'))).toBe(true);
		// Its own windows add to 6 s past the boot (2.5 s alive, then up to 1.5 s + 2 s to be failed),
		// past vitest's 5 s default: a loaded host timed it out with every bound still met.
	}, 20_000);
});

describe('the JVM\'s flags', () => {
	// hosting-test-plan H7 (a JVM out of heap never exited) and H3 (Forge dropped its own loopback
	// clients after a 45 s pause and the match never moved again).
	it('launches every bridge JVM to exit on OutOfMemoryError, with Forge\'s client timeout far past any pause and a heap cap, before the operator\'s own flags', async () => {
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory({ ...config, xmxMb: 3072, jvmOpts: ['-Dforge.net.heartbeatTimeout=2', '-Xmx4g'] }, { warm: false, sweep: false, log: (e) => poolLog.push(e) });
		pools.push(pool);
		const events = recorder();
		track(pool('m-0000000000f7', SPEC, events));
		await waitUntil(() => ready(events), 'ready');
		const { run } = spawned(poolLog, pool.jvms()[0]!.hostId);
		const argv = readFileSync(join(run, 'bridge.stderr.txt'), 'utf8').split('\n').find((l) => l.startsWith('fake-java argv: ')) ?? '';
		expect(argv).toContain(' -XX:+ExitOnOutOfMemoryError ');
		const timeouts = [...argv.matchAll(/-Dforge\.net\.heartbeatTimeout=(\d+)/g)].map((m) => Number(m[1]));
		// Ours first and far past UNRESPONSIVE_MS (which ends a stopped JVM long before); a later flag of the operator's wins.
		expect(timeouts).toEqual([86_400, 2]);
		expect([...argv.matchAll(/-Xmx(\w+)/g)].map((m) => m[1])).toEqual(['3072m', '4g']);
		expect(argv).toMatch(/ --host h-[0-9a-f]{12}$/);
		expect(BRIDGE_JVM_FLAGS).toContain('-XX:+ExitOnOutOfMemoryError');
	});
});

describe('the bridge is compiled once per version, not in every JVM', () => {
	// A JDK's bin/: a `java` nobody runs here, and a `javac` that does what the
	// real one is asked to — write `<main>.class` into `-d`, `<main>` being
	// whatever source file it was actually handed (the last argument, same
	// position `-sourcepath`'s dir is NOT — this fixture is used with more than
	// one bridge source to prove two mains get their own cache directory) —
	// and counts its runs.
	function fixture(javac: 'works' | 'fails' | 'absent') {
		const root = mkdtempSync(join(scratch, 'bridge-'));
		const bin = join(root, 'bin');
		mkdirSync(bin);
		writeFileSync(join(bin, 'java'), '#!/bin/sh\n');
		const runs = join(root, 'javac-runs');
		if (javac !== 'absent') {
			const body =
				javac === 'works'
					? `echo run >> "${runs}"\nwhile [ "$1" != "-d" ]; do shift; done\ndir="$2"\nfor a in "$@"; do src="$a"; done\nname=$(basename "$src" .java)\necho compiled > "$dir/$name.class"\n`
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

	/**
	 * `-sourcepath` (the flag this JVM's fake javac is handed, same as the real
	 * one) lets `javac` pull in ANY `.java` file beside the one named on the
	 * command line — `PoolService.java` referencing `PlayBridge.forgeCardName`
	 * is exactly this. So the version has to cover every sibling, not just the
	 * one file `bridgeLaunch` was asked to compile: an edit to a sibling that is
	 * actually referenced, with the referencing file unchanged, must still be a
	 * different compile — otherwise the cache would keep serving a stale class
	 * for the referenced file under the referencing file's unchanged key.
	 */
	it("an edited SIBLING .java changes the key too, even though Bridge.java itself did not change", () => {
		const f = fixture('works');
		const sibling = join(dirname(f.cfg.bridgeSource), 'Sibling.java');
		writeFileSync(sibling, 'class Sibling {}');
		const before = f.launch();
		writeFileSync(sibling, 'class Sibling { int edited; }');
		const after = f.launch();
		expect(after.how).toBe('compiled');
		expect(after.args[1]).not.toBe(before.args[1]);
		expect(f.javacRuns()).toBe(2);
	});

	/**
	 * Two mains sharing a directory would let a reader that finds ITS main's
	 * class already there be looking at a directory another process is still
	 * mid-write on for the OTHER main (the bug a bare `cpSync` merge — tried
	 * and reverted — would have reintroduced on the exact path a match
	 * launches through). Each main gets its own directory instead, even when
	 * every `.java` file beside them (so `bridgeVersion`) is identical.
	 */
	it('PlayBridge and PoolService (two different mains, same siblings) get their own cache directories', () => {
		const f = fixture('works');
		const other = join(dirname(f.cfg.bridgeSource), 'Other.java');
		writeFileSync(other, 'class Other {}');
		const bridge = f.launch();
		const otherLaunch = bridgeLaunch({ ...f.cfg, bridgeSource: other }, (e) => f.logs.push(e));
		expect(bridge.how).toBe('compiled');
		expect(otherLaunch.how).toBe('compiled');
		expect(otherLaunch.args).toEqual(['-cp', otherLaunch.args[1], 'Other']);
		expect(otherLaunch.args[1]).not.toBe(bridge.args[1]);
		// Both directories exist at once, each with only its own main's class —
		// never one main's directory missing or half-holding the other's.
		expect(readdirSync(f.cfg.bridgeCache)).toHaveLength(2);
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

describe('the run directory', () => {
	it("a retired JVM's directory is gone — and Forge's res behind its symlink is untouched — with what the bridge said about itself logged first", async () => {
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory(config, { warm: false, log: (e) => poolLog.push(e) });
		pools.push(pool);
		const events = recorder();
		const host = pool('m-000000000021', SPEC, events);
		await waitUntil(() => ready(events), 'ready');
		const hostId = pool.jvms()[0]!.hostId;
		const { run } = spawned(poolLog, hostId);
		expect(readLaunchRecord(run)).toMatchObject({ hostId, pid: spawned(poolLog, hostId).pid });
		appendFileSync(join(run, 'bridge.stderr.txt'), '[bridge] showPromptMessage: parts could not be read (java.lang.NullPointerException); the prompt goes without it\n');

		host.stop();
		await waitUntil(() => poolLog.some((l) => l.evt === 'run-dir-removed'), 'the run dir to be settled');
		expect(poolLog.find((l) => l.evt === 'bridge-diagnostics')).toMatchObject({
			id: hostId,
			lines: [{ line: '[bridge] showPromptMessage: parts could not be read (java.lang.NullPointerException); the prompt goes without it', count: 1 }],
		});
		expect(existsSync(run)).toBe(false);
		expect(existsSync(RES_MARKER)).toBe(true);
	});

	it('close() retires the idle warm JVM and leaves nothing behind', async () => {
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory(config, { log: (e) => poolLog.push(e) });
		await waitUntil(() => pool.room() === 'warm', 'the warm JVM');
		const { run } = spawned(poolLog, pool.jvms()[0]!.hostId);
		pool.close();
		await waitUntil(() => poolLog.some((l) => l.evt === 'run-dir-removed'), 'its dir to be settled');
		expect(existsSync(run)).toBe(false);
	});

	it('an idle JVM is retired after idleMs when another has room, but the last one with room stays warm', async () => {
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory({ ...config, perJvm: 1 }, { idleMs: 200, log: (e) => poolLog.push(e) });
		pools.push(pool);
		const events = recorder();
		const host = pool('m-000000000022', SPEC, events);
		await waitUntil(() => ready(events) && pool.room() === 'warm', 'the match and a warm JVM behind it');
		expect(pool.jvms()).toHaveLength(2);
		host.stop();
		// Its JVM is empty and the warm one has room: one of the two goes, the other stays.
		await waitUntil(() => poolLog.some((l) => l.evt === 'jvm-retired'), 'an idle JVM to be retired');
		await new Promise((r) => setTimeout(r, 600));
		expect(pool.jvms()).toHaveLength(1);
		expect(pool.room()).toBe('warm');
	});
});

describe('bridgeDiagnostics', () => {
	it('keeps every [bridge] line and each throwable with its first frame, once each with a count, in first-seen order', () => {
		const stderr = [
			'Read cards: 33752 files',
			'[bridge] askSource: could not read the running replacements (java.util.ConcurrentModificationException)',
			'java.util.ConcurrentModificationException',
			'\tat java.base/java.util.ArrayList$Itr.next(ArrayList.java:1095)',
			'\tat forge.game.zone.MagicStack.iterator(MagicStack.java:1)',
			'[bridge] askSource: could not read the running replacements (java.util.ConcurrentModificationException)',
			'Exception in thread "seat-0-ui" java.lang.NullPointerException: Cannot invoke "x"',
			'\tat forge.player.PlayerControllerHuman.confirm(PlayerControllerHuman.java:12)',
			'an ordinary line',
		].join('\n');
		expect(bridgeDiagnostics(stderr)).toEqual([
			{ line: '[bridge] askSource: could not read the running replacements (java.util.ConcurrentModificationException)', count: 2 },
			{ line: 'java.util.ConcurrentModificationException at java.base/java.util.ArrayList$Itr.next(ArrayList.java:1095)', count: 1 },
			{ line: 'Exception in thread "seat-0-ui" java.lang.NullPointerException: Cannot invoke "x" at forge.player.PlayerControllerHuman.confirm(PlayerControllerHuman.java:12)', count: 1 },
		]);
	});

	it('keeps a bounded number of distinct lines, still counting the ones it kept', () => {
		const stderr = Array.from({ length: 100 }, (_, i) => `[bridge] read ${i % 60} failed`).join('\n');
		const kept = bridgeDiagnostics(stderr);
		expect(kept).toHaveLength(40);
		expect(kept[0]).toEqual({ line: '[bridge] read 0 failed', count: 2 });
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

	/** A live run dir: a process standing in it, and `file` naming `pid` (that process, unless patched). */
	async function squatted(root: string, name: string, file: string, record: (pid: number) => Record<string, unknown>): Promise<{ dir: string; pid: number; kill(): void }> {
		const dir = join(root, name);
		mkdirSync(dir, { recursive: true });
		const squatter = spawn('sleep', ['30'], { cwd: dir, stdio: 'ignore' });
		await waitUntil(() => squatter.pid !== undefined, 'the squatter');
		const pid = squatter.pid as number;
		writeFileSync(join(dir, file), JSON.stringify(record(pid)));
		return { dir, pid, kill: () => squatter.kill('SIGKILL') };
	}

	it('removes dead run dirs, and spares a live one, a fresh one, crash records within the bound, and anything not ours', async () => {
		const root = mkdtempSync(join(scratch, 'sweep-'));
		const now = Date.now();
		const dead = staged(root, 'h-aaaaaaaaaaaa', DAY);
		const deadLegacy = staged(root, 'spare-bbbbbbbbbbbb', DAY);
		const live = staged(root, 'h-cccccccccccc', DAY);
		const fresh = staged(root, 'h-dddddddddddd', 0);
		const crash = staged(root, 'h-eeeeeeeeeeee', DAY, now - DAY);
		const stale = staged(root, 'h-ffffffffffff', 8 * DAY, now - 8 * DAY);
		const notOurs = join(root, 'keep-me');
		mkdirSync(notOurs);
		utimesSync(notOurs, new Date(now - DAY), new Date(now - DAY));
		const notADir = join(root, 'h-0123456789ab');
		writeFileSync(notADir, 'a file with a run-dir name');

		// A real process standing in the live dir, as a JVM stands in its run dir.
		const squatter = spawn('sleep', ['30'], { cwd: live, stdio: 'ignore' });
		await waitUntil(() => squatter.pid !== undefined, 'the squatter');
		try {
			const swept = sweepRunDirs(root, now);
			expect(swept.skipped).toBeUndefined();
			expect(swept.removed.sort()).toEqual(['h-aaaaaaaaaaaa', 'spare-bbbbbbbbbbbb']);
			expect(swept.live).toEqual(['h-cccccccccccc']);
			// Standing there, but with no launch record naming it: spared, not claimed.
			expect(swept.running).toEqual([]);
			expect(swept.fresh).toEqual(['h-dddddddddddd']);
			expect(swept.crashes).toEqual({ kept: ['h-eeeeeeeeeeee'], removed: ['h-ffffffffffff'] });
		} finally {
			squatter.kill('SIGKILL');
		}
		expect([dead, deadLegacy, stale].map(existsSync)).toEqual([false, false, false]);
		expect([live, fresh, crash, notOurs, notADir].map(existsSync)).toEqual([true, true, true, true, true]);
		expect(readFileSync(join(crash, 'bridge.stderr.txt'), 'utf8')).toBe('stderr of h-eeeeeeeeeeee\n');
		expect(existsSync(RES_MARKER)).toBe(true);
	});

	it(`keeps the newest ${CRASH_RECORDS_KEPT} crash records and removes the rest`, () => {
		const root = mkdtempSync(join(scratch, 'sweep-'));
		const now = Date.now();
		const names = Array.from({ length: CRASH_RECORDS_KEPT + 2 }, (_, i) => `h-${i.toString(16).padStart(12, '0')}`);
		// h-…00 is the newest; the last two are the oldest, still inside the age bound.
		names.forEach((n, i) => staged(root, n, DAY, now - (i + 1) * (CRASH_RECORD_MAX_AGE_MS / 100)));
		const swept = sweepRunDirs(root, now);
		expect(swept.crashes.kept).toEqual(names.slice(0, CRASH_RECORDS_KEPT));
		expect(swept.crashes.removed).toEqual(names.slice(CRASH_RECORDS_KEPT));
		expect(readdirSync(root).sort()).toEqual(names.slice(0, CRASH_RECORDS_KEPT));
	});

	it('runs when the pool is made, and logs what it did', () => {
		const root = mkdtempSync(join(scratch, 'sweep-'));
		const dead = staged(root, 'h-aaaaaaaaaaaa', DAY);
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory({ ...config, workDir: root }, { warm: false, log: (e) => poolLog.push(e) });
		pools.push(pool);
		expect(existsSync(dead)).toBe(false);
		expect(poolLog.find((l) => l.evt === 'run-dirs-swept')).toMatchObject({ workDir: root, removed: 1, live: [], fresh: [] });
	});

	it('finds a live JVM of ours by the pid its launch record names', async () => {
		const root = mkdtempSync(join(scratch, 'ident-'));
		const s = await squatted(root, 'h-00000000c001', LAUNCH_RECORD_FILE, (pid) => ({ hostId: 'h-00000000c001', pid, startedAt: new Date().toISOString() }));
		try {
			const swept = sweepRunDirs(root);
			expect(swept.live).toEqual(['h-00000000c001']);
			expect(swept.running).toMatchObject([{ hostId: 'h-00000000c001', pid: s.pid }]);
			expect(existsSync(s.dir)).toBe(true);
		} finally {
			s.kill();
		}
	});

	it("leaves a live directory alone when its record names a DIFFERENT process — it may be another server's", async () => {
		const root = mkdtempSync(join(scratch, 'ident-'));
		const s = await squatted(root, 'h-00000000c004', LAUNCH_RECORD_FILE, () => ({ hostId: 'h-00000000c004', pid: 999_999_999 }));
		try {
			const swept = sweepRunDirs(root);
			expect(swept.killed).toEqual([]);
			expect(swept.live).toEqual(['h-00000000c004']);
			expect(swept.running).toEqual([]);
			expect(existsSync(s.dir)).toBe(true);
		} finally {
			s.kill();
		}
	});

	it('ends a live one-match JVM from before many matches per JVM, named by its own record: nothing re-attaches one now', async () => {
		const root = mkdtempSync(join(scratch, 'ident-'));
		const s = await squatted(root, 'm-00000000c002', 'jvm.json', (pid) => ({ matchId: 'm-00000000c002', pid, run: join(root, 'm-00000000c002'), spec: SPEC }));
		try {
			const swept = sweepRunDirs(root);
			expect(swept.killed).toEqual(['m-00000000c002']);
			expect(swept.live).toEqual([]);
			expect(existsSync(s.dir)).toBe(false);
			await waitUntil(() => !running(s.pid), 'it to be killed');
		} finally {
			s.kill();
		}
	});
});

/* ── A match that outlives its server (Wave 22 §E) ───────────────────── */

describe('a JVM that outlives the process that started it', () => {
	/** `tsx`, because `host.ts` uses parameter properties and node cannot strip those. */
	const TSX = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '.bin', 'tsx');
	const HOST = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'host.ts')).href;

	/**
	 * A whole other server, in its own process: it starts two matches in one JVM, waits for both
	 * `ready`s, and then DIES without stopping them — the shape of a `pm2 restart` with no handler,
	 * or of a SIGKILL. What it leaves behind is the only thing the next process gets: a run
	 * directory, two fifos, `launch.json`, `jvm.json`, a stream per match, and a JVM still running.
	 */
	const maker = join(scratch, 'other-server.mts');
	writeFileSync(
		maker,
		[
			`import { jvmHostFactory } from ${JSON.stringify(HOST)};`,
			'const args = JSON.parse(process.argv[2]);',
			'const pool = jvmHostFactory(args.config, { warm: false, sweep: false, log: () => undefined });',
			'let readies = 0;',
			'for (const matchId of args.matchIds) {',
			'  const host = pool(matchId, args.spec, {',
			"    line: (l) => { if (l.t === 'ready' && ++readies === args.matchIds.length) { process.stdout.write('READY\\n'); setTimeout(() => process.exit(0), 50); } },",
			'    exit: () => undefined,',
			'    log: () => undefined,',
			'  });',
			"  host.remember({ epoch: `${matchId}:1`, owners: ['p-alice', 'p-bob'] });",
			'}',
			'',
		].join('\n'),
	);

	/** Run that other server to completion. Returns the work dir it left behind and its JVM. */
	async function otherServer(matchIds: string[]): Promise<{ workDir: string; hostId: string; pid: number }> {
		const workDir = mkdtempSync(join(scratch, 'outlive-'));
		const child = spawn(TSX, [maker, JSON.stringify({ config: { ...config, workDir }, matchIds, spec: SPEC })], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		let err = '';
		child.stdout.on('data', (d: Buffer) => (out += d.toString()));
		child.stderr.on('data', (d: Buffer) => (err += d.toString()));
		const code = await new Promise<number | null>((done) => child.on('exit', (c) => done(c)));
		if (code !== 0 || !out.includes('READY')) throw new Error(`the other server did not reach ready (code ${code}): ${err || out}`);
		const hostId = readdirSync(workDir).find((d) => d.startsWith('h-')) as string;
		const pid = readLaunchRecord(join(workDir, hostId))?.pid as number;
		strays.push(pid);
		return { workDir, hostId, pid };
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

	it('is still running after that process is gone, and names itself and every match on it on disk', async () => {
		const { workDir, hostId, pid } = await otherServer(['m-0000000000a1', 'm-0000000000a2']);
		expect(running(pid)).toBe(true);
		expect(readlinkSync(`/proc/${pid}/cwd`)).toBe(join(workDir, hostId));
		const record = readJvmRecord(join(workDir, hostId));
		expect(record).toMatchObject({
			hostId,
			matches: [
				{ matchId: 'm-0000000000a1', epoch: 'm-0000000000a1:1', owners: ['p-alice', 'p-bob'], spec: SPEC },
				{ matchId: 'm-0000000000a2', epoch: 'm-0000000000a2:1', owners: ['p-alice', 'p-bob'], spec: SPEC },
			],
		});
		// And everything a replay needs is beside it, one stream per match.
		expect(readFileSync(streamFile(join(workDir, hostId), 'm-0000000000a1'), 'utf8')).toContain('"ready"');
	}, 30_000);

	it('is taken back by the next pool: every match on it offered, replayed into its new match, and still answering what we send', async () => {
		const { workDir, hostId } = await otherServer(['m-0000000000a3', 'm-0000000000a4']);
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory({ ...config, workDir }, { warm: false, log: (e) => poolLog.push(e) });
		pools.push(pool);
		expect(poolLog.find((l) => l.evt === 'run-dirs-swept')).toMatchObject({ live: [hostId], running: [hostId], removed: 0 });
		const offered = await pool.orphans();
		expect(offered.map((o) => [o.matchId, o.hostId, o.epoch])).toEqual([
			['m-0000000000a3', hostId, 'm-0000000000a3:1'],
			['m-0000000000a4', hostId, 'm-0000000000a4:1'],
		]);

		const [a, b] = [recorder(), recorder()];
		const hostA = track(pool.attach(offered[0]!, a));
		track(pool.attach(offered[1]!, b));
		// The replay handed each new match what the dead server had read for it.
		expect(a.lines.map((l) => l.t)).toEqual(['ready']);
		expect(a.logs.find((l) => l.evt === 'match-resumed')).toMatchObject({ matchId: 'm-0000000000a3', hostId, replayed: 1 });
		expect(() => pool.attach(offered[0]!, recorder())).toThrow(/no orphan match m-0000000000a3/);

		// And the transport works in the other direction too, over the re-opened fifos, to that match alone.
		hostA.send({ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } });
		await waitUntil(() => a.lines.some((l) => l.t === 'rejected'), 'the echo from the re-attached JVM');
		expect(a.lines.filter((l) => l.t === 'rejected')).toMatchObject([{ message: 'echo', command: 'act' }]);
		expect(b.lines.map((l) => l.t)).toEqual(['ready']);
		// Lines and commands keep going to each match's stream, so it survives the next restart too.
		expect(readFileSync(streamFile(join(workDir, hostId), 'm-0000000000a3'), 'utf8')).toContain('"echo"');
	}, 30_000);

	it('a JVM orphaned past ORPHAN_MAX_MS is retired at boot, not offered', async () => {
		const { workDir, hostId, pid } = await otherServer(['m-0000000000a5']);
		const record = readJvmRecord(join(workDir, hostId))!;
		writeFileSync(join(workDir, hostId, JVM_RECORD_FILE), JSON.stringify({ ...record, orphanedAt: new Date(Date.now() - ORPHAN_MAX_MS - 1).toISOString() }));
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory({ ...config, workDir }, { warm: false, log: (e) => poolLog.push(e) });
		pools.push(pool);
		expect(await pool.orphans()).toEqual([]);
		expect(poolLog.find((l) => l.evt === 'jvm-retired')?.why).toMatch(/past ORPHAN_MAX_MS$/);
		await waitUntil(() => !running(pid), 'the expired JVM to go');
	}, 30_000);
});

describe('handing matches over on the way out', () => {
	it('lets go of a JVM without killing it, and a second pool takes every match on it back', async () => {
		const workDir = mkdtempSync(join(scratch, 'handover-'));
		const poolLog: Record<string, unknown>[] = [];
		const first = jvmHostFactory({ ...config, workDir }, { warm: false, log: (e) => poolLog.push(e) });
		pools.push(first);
		const [a, b] = [recorder(), recorder()];
		first('m-0000000000b1', SPEC, a);
		first('m-0000000000b2', SPEC, b);
		await waitUntil(() => ready(a) && ready(b), 'ready');
		const hostId = first.jvms()[0]!.hostId;
		const { pid } = spawned(poolLog, hostId);

		expect(first.handOverAll()).toEqual(['m-0000000000b1', 'm-0000000000b2']);
		expect(liveJvmCount()).toBe(0);
		// Handed over, not stopped: it is still playing, and its record says when.
		expect(running(pid)).toBe(true);
		expect(readJvmRecord(join(workDir, hostId))?.orphanedAt).toEqual(expect.any(String));
		expect(poolLog.find((l) => l.evt === 'jvm-handed-over')).toMatchObject({ id: hostId, pid });

		const second = jvmHostFactory({ ...config, workDir }, { warm: false, log: () => undefined });
		pools.push(second);
		const back = await second.orphans();
		expect(back.map((o) => o.matchId)).toEqual(['m-0000000000b1', 'm-0000000000b2']);
		const resumed = recorder();
		track(second.attach(back[0]!, resumed));
		track(second.attach(back[1]!, recorder()));
		expect(resumed.lines.map((l) => l.t)).toEqual(['ready']);
	}, SLOW_TIMEOUT);

	it('a pool that takes a JVM with room back boots no second one beside it', async () => {
		const workDir = mkdtempSync(join(scratch, 'handover-warm-'));
		const first = jvmHostFactory({ ...config, workDir }, { warm: false, log: () => undefined });
		pools.push(first);
		const events = recorder();
		first('m-0000000000b3', SPEC, events);
		await waitUntil(() => ready(events), 'ready');
		first.handOverAll();

		const poolLog: Record<string, unknown>[] = [];
		const second = jvmHostFactory({ ...config, workDir }, { log: (e) => poolLog.push(e) });
		pools.push(second);
		const back = await second.orphans();
		track(second.attach(back[0]!, recorder()));
		expect(poolLog.filter((l) => l.evt === 'jvm-spawned')).toEqual([]);
		expect(second.room()).toBe('warm');
	}, SLOW_TIMEOUT);
});

/*
 * ── Going down: what must die before we do (Wave 22, lane U) ─────────────
 *
 * A JVM holding a handed-over match outlives its server on purpose. Everything else has to be
 * gone before the server is. Both halves are asserted off the SAME `reapOnExit()` call on the
 * SAME pool, so a pass cannot be a mix-up about which JVM is which.
 */
describe('going down: what must die before we do', () => {
	/**
	 * A stand-in for a bridge that will not go quietly — which, on a deploy's timescale, is what
	 * the real one measurably IS (lane U: `{"t":"stop"}` → gone in 9355 ms, SIGTERM 4322 ms,
	 * SIGKILL 0 ms, pm2 SIGKILLing the server after 1.6 s). It ignores every line and SIGTERM, so
	 * only an insisting shutdown ends it.
	 */
	const javaDeaf = join(scratch, 'java-deaf');
	writeFileSync(javaDeaf, `#!/bin/sh\nexec "${process.execPath}" -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'\n`);
	chmodSync(javaDeaf, 0o755);

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
		hostId: string;
		pid: number;
		run: string;
	}

	/** One match on a JVM of its own that answers nothing. It never says `ready`; it only exists. */
	async function deafMatch(pool: JvmHostFactory, poolLog: Record<string, unknown>[], matchId: string): Promise<Deaf> {
		const host = pool(matchId, SPEC, recorder());
		const hostId = pool.jvms().find((j) => j.matches.includes(matchId))!.hostId;
		const { pid, run } = spawned(poolLog, hostId);
		strays.push(pid);
		// `/bin/sh` execs into it, so wait until the process that holds the pid is the one
		// standing in the run dir — which is what the kill confirms against.
		await waitUntil(() => {
			try {
				return readlinkSync(`/proc/${pid}/cwd`) === run;
			} catch {
				return false;
			}
		}, `${matchId}'s JVM to be standing in its run dir`);
		return { host, hostId, pid, run };
	}

	/**
	 * Exactly what `PlayHandle.shutdown` does, in its order: hand over the match that can outlive
	 * us, ask the one that cannot to stop, close — and then reap.
	 */
	async function shutdownWith(): Promise<{ handed: Deaf; ended: Deaf; reaped: ReapResult }> {
		const workDir = mkdtempSync(join(scratch, 'reap-'));
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory({ ...config, java: javaDeaf, workDir, perJvm: 1 }, { warm: false, log: (e) => poolLog.push(e) });
		pools.push(pool);
		const handed = await deafMatch(pool, poolLog, 'm-0000000000c2');
		const ended = await deafMatch(pool, poolLog, 'm-0000000000c1');
		handed.host.remember?.({ epoch: 'e-1', owners: ['p-alice', 'p-bob'] });
		expect(handed.host.handOver?.()).toBe(true);
		ended.host.stop();
		pool.close();
		// Asked, and still there: a polite stop is not a guarantee, which is the whole reason the
		// step below exists.
		expect(running(ended.pid)).toBe(true);
		return { handed, ended, reaped: pool.reapOnExit() };
	}

	it('a JVM with no handed-over match is gone once the shutdown path has run — asking is not enough', async () => {
		const { ended, reaped } = await shutdownWith();
		expect(reaped.killed).toEqual([ended.hostId]);
		expect(reaped.left).toEqual([]);
		expect(running(ended.pid)).toBe(false);
		// Asked to go and then killed: a clean end, so no successor is offered a finished game.
		expect(existsSync(ended.run)).toBe(false);
	}, SLOW_TIMEOUT);

	it('a JVM with a HANDED-OVER match is still alive after that same reap, standing in its run dir with its orphanedAt', async () => {
		const { handed, reaped } = await shutdownWith();
		expect(reaped.kept).toEqual([handed.hostId]);
		expect(running(handed.pid)).toBe(true);
		// Re-attachable, asked the way the sweep asks it.
		expect(readlinkSync(`/proc/${handed.pid}/cwd`)).toBe(handed.run);
		expect(readLaunchRecord(handed.run)?.pid).toBe(handed.pid);
		const record = readJvmRecord(handed.run)!;
		expect(record.orphanedAt).toEqual(expect.any(String));
		expect(record.matches).toMatchObject([{ matchId: 'm-0000000000c2', epoch: 'e-1', owners: ['p-alice', 'p-bob'] }]);
	}, SLOW_TIMEOUT);

	it('refuses to signal a pid that is not the process standing in that run dir, and says the JVM was LEFT', async () => {
		const workDir = mkdtempSync(join(scratch, 'reap-guard-'));
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory({ ...config, java: javaDeaf, workDir }, { warm: false, log: (e) => poolLog.push(e) });
		pools.push(pool);
		const jvm = await deafMatch(pool, poolLog, 'm-0000000000c3');

		// Move the directory and that pid is standing somewhere else — which is exactly what a
		// RECYCLED pid looks like, and the one case where signalling it would kill a stranger.
		renameSync(jvm.run, `${jvm.run}-moved`);
		expect(pool.reapOnExit()).toMatchObject({ killed: [], left: [jvm.hostId] });
		expect(running(jvm.pid)).toBe(true);
		expect(poolLog.filter((l) => l.evt === 'jvm-reap-refused').map((l) => l.pid)).toEqual([jvm.pid]);

		// Put it back and the same call ends it: the refusal is about identity, not about giving
		// up, and `reapOnExit` is idempotent.
		renameSync(`${jvm.run}-moved`, jvm.run);
		expect(pool.reapOnExit()).toMatchObject({ killed: [jvm.hostId], left: [] });
		expect(running(jvm.pid)).toBe(false);
	}, SLOW_TIMEOUT);

	it('reaps the idle warm JVM too, even after close() asked it to go — it holds no game and must not outlive us', async () => {
		const workDir = mkdtempSync(join(scratch, 'reap-warm-'));
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory({ ...config, java: javaDeaf, workDir }, { log: (e) => poolLog.push(e) });
		pools.push(pool);
		await pool.orphans();
		const hostId = pool.jvms()[0]!.hostId;
		const { pid, run } = spawned(poolLog, hostId);
		strays.push(pid);
		await waitUntil(() => running(pid), 'the warm JVM to be running');

		pool.close();
		// A real idle JVM takes ~314 ms to `halt(0)`; this one never will.
		expect(running(pid)).toBe(true);
		expect(pool.reapOnExit().killed).toEqual([hostId]);
		expect(running(pid)).toBe(false);
		expect(existsSync(run)).toBe(false);
	}, SLOW_TIMEOUT);
});

/** A launcher with no JVM behind it: the coordinator's half alone, line by line. */
function scriptedLauncher(): { launcher: JvmLauncher; jvms: Map<string, { sent: string[]; say(line: object): void; die(reason: string): void }> } {
	const jvms = new Map<string, { sent: string[]; say(line: object): void; die(reason: string): void }>();
	return {
		jvms,
		launcher: {
			launch(hostId) {
				let onLine: (line: string) => void = () => undefined;
				let onExit: (reason: string) => void = () => undefined;
				const sent: string[] = [];
				jvms.set(hostId, { sent, say: (line) => onLine(JSON.stringify(line)), die: (reason) => onExit(reason) });
				const transport: JvmTransport = {
					hostId,
					send: (line) => sent.push(line),
					onLine: (l) => (onLine = l),
					onExit: (l) => (onExit = l),
					kill: () => onExit('killed'),
					release: () => undefined,
				};
				return transport;
			},
			running: () => Promise.resolve([]),
			attach: () => {
				throw new Error('nothing to attach');
			},
		},
	};
}

describe('routing, against a scripted launcher', () => {
	// The start-queue jar suite on a claw: 8 starts at 2 per JVM had 4 JVMs booting at once, past the
	// queue's limit of 2, because every booting JVM that filled made the pool launch a warm one behind it.
	it('a burst through the start queue never has more JVMs booting than the queue allows', () => {
		const { launcher, jvms } = scriptedLauncher();
		const workDir = mkdtempSync(join(scratch, 'scripted-'));
		const pool = jvmHostFactory({ ...config, workDir, perJvm: 2 }, { launcher, log: () => undefined });
		const queue = queueColdStarts(pool, 2, () => undefined);
		let peak = 0;
		const sample = (): void => {
			peak = Math.max(peak, pool.booting());
		};
		pool.watchRoom(sample);
		for (let i = 0; i < 8; i++) {
			queue(`m-${i.toString(16).padStart(12, '0')}`, SPEC, recorder());
			sample();
		}
		// Boot every JVM in turn, as they would come up; the queue moves on each.
		for (let round = 0; round < 8; round++) {
			for (const [hostId, j] of jvms) if (pool.jvms().some((x) => x.hostId === hostId && !x.warm)) j.say({ t: 'warm', bootMs: 1, match: hostId });
			sample();
		}
		expect(peak).toBeLessThanOrEqual(2);
		expect(queue.queue().waiting).toBe(0);
		expect(pool.jvms().flatMap((j) => j.matches)).toHaveLength(8);
	});

	it('each line goes to the match it names; a line for no match here is logged and dropped; a JVM\'s death fails only its own matches', () => {
		const { launcher, jvms } = scriptedLauncher();
		const poolLog: Record<string, unknown>[] = [];
		const workDir = mkdtempSync(join(scratch, 'scripted-'));
		const pool = jvmHostFactory({ ...config, workDir, perJvm: 2 }, { warm: false, launcher, log: (e) => poolLog.push(e) });
		const [a, b, c] = [recorder(), recorder(), recorder()];
		pool('m-0000000000d1', SPEC, a);
		pool('m-0000000000d2', SPEC, b);
		pool('m-0000000000d3', SPEC, c);
		const [one, two] = [...jvms.keys()];
		expect(pool.jvms().map((j) => j.matches)).toEqual([['m-0000000000d1', 'm-0000000000d2'], ['m-0000000000d3']]);
		// The start line names the host; its config names the match first.
		expect(JSON.parse(jvms.get(one!)!.sent[0]!)).toMatchObject({ t: 'start', match: one, config: { matchId: 'm-0000000000d1' } });
		expect(jvms.get(one!)!.sent[0]).toMatch(/^\{"t":"start","config":\{"matchId":"m-0000000000d1"/);

		jvms.get(one!)!.say({ t: 'warm', bootMs: 1, match: one });
		jvms.get(one!)!.say({ t: 'ready', forgePort: 1, bootMs: 1, seats: [], match: 'm-0000000000d2' });
		jvms.get(one!)!.say({ t: 'frame', seat: 0, frame: {}, match: 'm-0000000000d3' });
		expect(a.lines).toEqual([]);
		expect(b.lines).toEqual([{ t: 'ready', forgePort: 1, bootMs: 1, seats: [] }]);
		// d3 is not on that JVM: its line is not d3's.
		expect(c.lines).toEqual([]);
		expect(poolLog.find((l) => l.evt === 'bridge-wrong-match')).toMatchObject({ id: one, got: 'm-0000000000d3' });

		jvms.get(one!)!.die('the claw went away');
		expect([a.exits, b.exits, c.exits]).toEqual([['the claw went away'], ['the claw went away'], []]);
		expect(poolLog.find((l) => l.evt === 'jvm-lost')).toMatchObject({ id: one, reason: 'the claw went away', matches: ['m-0000000000d1', 'm-0000000000d2'] });
		expect(pool.jvms().map((j) => j.hostId)).toEqual([two]);
	});

	it('a match asked to stop leaves the JVM record at once: a JVM killed on the way out must not offer it to the next server', () => {
		const { launcher, jvms } = scriptedLauncher();
		const workDir = mkdtempSync(join(scratch, 'scripted-'));
		const pool = jvmHostFactory({ ...config, workDir, perJvm: 2 }, { warm: false, launcher, log: () => undefined });
		const stopping = pool('m-0000000000d6', SPEC, recorder());
		pool('m-0000000000d7', SPEC, recorder());
		const [hostId] = [...jvms.keys()];
		stopping.stop();
		expect(readJvmRecord(join(workDir, hostId!))!.matches.map((m) => m.matchId)).toEqual(['m-0000000000d7']);
	});

	it('a JVM let go on the way out names only the matches it handed over: one being stopped is not taken back', () => {
		const { launcher, jvms } = scriptedLauncher();
		const workDir = mkdtempSync(join(scratch, 'scripted-'));
		const pool = jvmHostFactory({ ...config, workDir, perJvm: 2 }, { warm: false, launcher, log: () => undefined });
		const handed = pool('m-0000000000d4', SPEC, recorder());
		const ending = pool('m-0000000000d5', SPEC, recorder());
		const [hostId] = [...jvms.keys()];
		jvms.get(hostId!)!.say({ t: 'warm', bootMs: 1, match: hostId });
		handed.remember?.({ epoch: 'e-4', owners: ['p-a', 'p-b'] });
		expect(handed.handOver?.()).toBe(true);
		ending.stop();
		expect(ending.handOver?.()).toBe(false);
		expect(pool.reapOnExit()).toEqual({ killed: [], kept: [hostId], left: [] });
		const record = readJvmRecord(join(workDir, hostId!))!;
		expect(record.orphanedAt).toEqual(expect.any(String));
		expect(record.matches.map((m) => [m.matchId, m.epoch])).toEqual([['m-0000000000d4', 'e-4']]);
	});
});

/**
 * hosting-test-plan C6, H4 and H5, on a filesystem that is really full: a small tmpfs mounted
 * in a user + mount namespace of its own (`unshare -rm`, no root), held open by a `sleep` and
 * reached from here through `/proc/<that pid>/root`. Nothing outside the namespace sees it.
 */
const canUnshare = spawnSync('unshare', ['-rm', 'true']).status === 0;
describe.skipIf(!canUnshare)(`a full disk${canUnshare ? '' : ' — SKIPPED: unshare -rm (an unprivileged user namespace) is not available here'}`, () => {
	let holder: ReturnType<typeof spawn> | null = null;
	let workDir = '';
	const filler = (): string => join(workDir, '..', 'filler');

	beforeAll(async () => {
		const mount = mkdtempSync(join(scratch, 'full-'));
		holder = spawn('unshare', ['-rm', 'sh', '-c', `mount -t tmpfs -o size=1m tmpfs ${mount} && echo mounted && exec sleep 600`], { stdio: ['ignore', 'pipe', 'inherit'] });
		await new Promise<void>((done, fail) => {
			holder?.stdout?.on('data', (d: Buffer) => d.toString().includes('mounted') && done());
			holder?.on('exit', (code) => fail(new Error(`unshare exited ${code}`)));
		});
		workDir = join(`/proc/${holder.pid}/root`, mount, 'runs');
		mkdirSync(workDir);
	});
	afterAll(() => {
		holder?.kill('SIGKILL');
	});
	afterEach(() => rmSync(filler(), { force: true }));

	/** Fill the filesystem to the last byte. */
	function fill(): void {
		const chunk = Buffer.alloc(4096);
		const fd = openSync(filler(), 'a');
		try {
			for (;;) writeSync(fd, chunk);
		} catch (err) {
			expect((err as NodeJS.ErrnoException).code).toBe('ENOSPC');
		} finally {
			closeSync(fd);
		}
	}

	it('a record rewrite that does not fit leaves the old record whole and degrades the match it lost; a stream that breaks degrades its match; handover is refused in words', async () => {
		const pool = jvmHostFactory({ ...config, workDir }, { warm: false, sweep: false });
		pools.push(pool);
		const [a, b] = [recorder(), recorder()];
		const hostA = track(pool('m-0000000000e1', SPEC, a));
		const hostB = track(pool('m-0000000000e2', SPEC, b));
		await waitUntil(() => ready(a) && ready(b), 'ready');
		const dir = join(workDir, pool.jvms()[0]!.hostId);
		expect(readJvmRecord(dir)?.matches.map((m) => m.matchId)).toEqual(['m-0000000000e1', 'm-0000000000e2']);

		fill();
		// Bigger than the page the old record held: an in-place rewrite truncates, then cannot finish.
		hostA.remember?.({ epoch: 'e'.repeat(6000), owners: [null, null] });
		expect(readJvmRecord(dir)?.matches.map((m) => [m.matchId, m.epoch])).toEqual([
			['m-0000000000e1', null],
			['m-0000000000e2', null],
		]);
		expect(a.logs.find((l) => l.evt === 'match-degraded')).toMatchObject({ level: 'error', matchId: 'm-0000000000e1' });
		expect(a.logs.find((l) => l.evt === 'match-degraded')?.why).toMatch(/^its record could not be written \(ENOSPC/);

		// More than the stream's last page has left, so the append needs a page the disk does not have.
		hostB.send({ t: 'reply', seat: 0, callId: 'c-1', result: 'r'.repeat(8000) });
		expect(b.logs.find((l) => l.evt === 'match-degraded')?.why).toMatch(/^its stream could not be written \(ENOSPC/);
		expect(existsSync(streamFile(dir, 'm-0000000000e2'))).toBe(false);
		// The matches still play in this process.
		await waitUntil(() => b.lines.some((l) => l.t === 'rejected' && l.message === 'echo'), 'the echo');

		expect(hostA.handOver?.()).toBe(false);
		expect(hostB.handOver?.()).toBe(false);
		expect(b.logs.find((l) => l.evt === 'jvm-handover-refused')?.why).toMatch(/^this match cannot be kept across a restart: its stream could not be written \(ENOSPC/);
	});

	it('a start that needs a JVM that does not fit throws, and leaves no half-staged run directory and no JVM', async () => {
		const pool = jvmHostFactory({ ...config, workDir }, { warm: false, sweep: false });
		pools.push(pool);
		fill();
		expect(() => pool('m-0000000000e3', SPEC, recorder())).toThrow(/ENOSPC/);
		expect(readdirSync(workDir)).toEqual([]);
		expect(liveJvmCount()).toBe(0);
	});

	it('a warm JVM that cannot be launched onto a full disk does not throw out of the pool; it counts as a failed boot', async () => {
		fill();
		const poolLog: Record<string, unknown>[] = [];
		const pool = jvmHostFactory({ ...config, workDir }, { sweep: false, log: (e) => poolLog.push(e) });
		pools.push(pool);
		await pool.orphans();
		expect(poolLog.find((l) => l.evt === 'jvm-launch-failed')?.error).toMatch(/ENOSPC/);
		expect(liveJvmCount()).toBe(0);
	});
});
