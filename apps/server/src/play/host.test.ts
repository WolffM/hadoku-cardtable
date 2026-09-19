/**
 * The JVM pool — warm spare, addressing, ceiling, a spare that dies — against
 * `fixtures/fake-bridge.mjs`, a real child process speaking the bridge's line
 * protocol. CI has no Java; the same paths against a real Forge JVM are in
 * `jvm.test.ts` (the warm-spare run) and measured by `dev/spare-bench.ts`.
 */

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
	CRASH_RECORDS_KEPT,
	CRASH_RECORD_FILES,
	CRASH_RECORD_MAX_AGE_MS,
	SPARE_MAX_FAILURES,
	jvmHostFactory,
	liveJvmCount,
	sweepRunDirs,
	withHeapCap,
	type BridgeLine,
	type HostEvents,
	type JvmHostConfig,
	type JvmHostFactory,
	type MatchHost,
	type MatchSpec,
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
