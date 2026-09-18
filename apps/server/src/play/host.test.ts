/**
 * The JVM pool — warm spare, addressing, ceiling, a spare that dies — against
 * `fixtures/fake-bridge.mjs`, a real child process speaking the bridge's line
 * protocol. CI has no Java; the same paths against a real Forge JVM are in
 * `jvm.test.ts` (the warm-spare run) and measured by `dev/spare-bench.ts`.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
	SPARE_MAX_FAILURES,
	jvmHostFactory,
	liveJvmCount,
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
const java = join(scratch, 'java');
writeFileSync(java, `#!/bin/sh\nwhile [ "$1" != "BRIDGE" ]; do shift; done\nshift\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
chmodSync(java, 0o755);

const config: JvmHostConfig = {
	java,
	jar: 'unused.jar',
	res: scratch,
	workDir: join(scratch, 'runs'),
	jvmOpts: [],
	bridgeSource: 'BRIDGE',
	stopGraceMs: 1000,
	warmSpare: true,
};

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
		const pool = jvmHostFactory(config, { spare: false });
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
