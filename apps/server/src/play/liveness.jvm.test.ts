/**
 * A match whose Forge can no longer move ends, and both seats are told — against a REAL
 * bridge JVM. Each case is one way hosting-test-plan.md's breakit lane found a match that
 * looked alive and never moved again:
 *
 * - **H9**: a throw out of the game on Forge's game thread. Forge runs a game through a
 *   bare `ExecutorService.execute`, so the thread died and nothing told anyone. Provoked
 *   with the bridge's test-only fault hook (`-Dcardtable.fault=game-throw`, never set by
 *   `host.ts`): the game thread throws an `Error` from inside the game.
 * - **H3**: a seat's loopback client dropped by Forge's own server (its read timeout,
 *   shortened here to 2 s, is how a long pause dropped them in C2b). Nothing reconnected it.
 * - **H2**: a SIGSTOPped JVM. Its pid lived, so the match stayed `running` for good.
 * - **H7**: a JVM out of heap (`-Dcardtable.fault=oom`, on a thread of its own) limped on;
 *   with `-XX:+ExitOnOutOfMemoryError` it exits, and that exit is a crash the server reports.
 * - **[nightly] H3**: Forge's 45 s client timeout is raised, so clients that send no
 *   heartbeat for longer still answer.
 *
 * Skips visibly without a Forge build, like every `*.jvm.test.ts`:
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   CI=1 node_modules/.bin/vitest run apps/server/src/play/liveness.jvm.test.ts
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientFrameSchema } from '@hadoku/forge-wire';
import type { ServerEnvelope } from '@hadoku/shared';

import { jvmHostConfig, jvmHostFactory, liveJvmCount, type JvmHostConfig, type JvmHostFactory, type MatchSpec } from './host.js';
import { createMatchRegistry, type Match } from './match.js';
import { nightly } from './scenario.js';

const available = jvmHostConfig({ ...process.env, CARDTABLE_PLAY_WARM_SPARE: '0' });
const title = available.ok
	? 'a match whose Forge cannot move any more ends, against a real bridge'
	: `a match whose Forge cannot move any more ends, against a real bridge — SKIPPED: ${available.reason}`;

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number, detail?: () => string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}${detail === undefined ? '' : `\n${detail()}`}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

function deck(name: string): string {
	return `[metadata]\nName=${name}\n[main]\n30 Mountain\n30 Memnite\n`;
}

const VS_AI: MatchSpec = {
	seed: 20261026,
	seats: [
		{ name: 'Seat 1', ai: false, deck: deck('Seat one') },
		{ name: 'Seat 2', ai: true, deck: deck('Seat two') },
	],
};

interface Run {
	match: Match;
	pool: JvmHostFactory;
	logs: Record<string, unknown>[];
	sent: { seat: number; envelope: ServerEnvelope }[];
	pid(): number;
	stderr(): string;
	/** Seat 0 was told, on its own stream, that the match ended. */
	told(): boolean;
}

const runs: Run[] = [];

afterEach(async () => {
	for (const r of runs.splice(0)) {
		r.match.stop();
		r.pool.close();
	}
	await waitUntil(() => liveJvmCount() === 0, 'every JVM to exit', 30_000);
});

function start(patch: Partial<JvmHostConfig>, spec: MatchSpec = VS_AI): Run {
	if (!available.ok) throw new Error('unreachable');
	const config = { ...available.config, ...patch, jvmOpts: [...available.config.jvmOpts, ...(patch.jvmOpts ?? [])] };
	const logs: Record<string, unknown>[] = [];
	const sent: { seat: number; envelope: ServerEnvelope }[] = [];
	const pool = jvmHostFactory(config, { spare: false, sweep: false, log: (e) => logs.push(e) });
	const registry = createMatchRegistry({
		host: pool,
		log: (e) => logs.push(e),
		overGraceMs: 60_000,
		disconnectGraceMs: 30_000,
		emit: (_m, seat, envelope) => sent.push({ seat, envelope }),
	});
	const match = registry.create(spec);
	const spawned = (): Record<string, unknown> | undefined => logs.find((l) => l.evt === 'jvm-spawned');
	const run: Run = {
		match,
		pool,
		logs,
		sent,
		pid: () => spawned()?.pid as number,
		stderr: () => readFileSync(`${spawned()?.run as string}/bridge.stderr.txt`, 'utf8'),
		told: () => sent.some((s) => s.seat === 0 && s.envelope.frame.method === 'showErrorDialog' && (s.envelope.frame as { matchEnded?: boolean }).matchEnded === true),
	};
	runs.push(run);
	return run;
}

const status = (r: Run) => (): string =>
	`status ${r.match.status}, failure ${r.match.failure}; log tail ${JSON.stringify(r.logs.slice(-6))}\nstderr tail:\n${r.stderr().split('\n').slice(-40).join('\n')}`;

describe.skipIf(!available.ok)(title, () => {
	it('H9: a throw on the game thread fails its match through the bridge\'s fatal, and the JVM exits', async () => {
		const r = start({ jvmOpts: ['-Dcardtable.fault=game-throw'] }, { ...VS_AI, skipOpening: true });
		await waitUntil(() => r.match.status === 'failed', 'the match to fail', 60_000, status(r));
		console.log(`[jvm] H9: ${r.match.failure}`);
		expect(r.match.failure).toBe("Forge's game thread failed: java.lang.Error: cardtable.fault=game-throw: a test-only failure on the game thread");
		await waitUntil(() => liveJvmCount() === 0, 'the JVM to exit', 20_000);
		expect(r.logs.find((l) => l.evt === 'jvm-exited')).toMatchObject({ code: 1 });
		expect(r.stderr()).toContain('cardtable.fault=game-throw');
	}, 120_000);

	it("H3: a seat's client dropped by Forge's own server fails the match instead of leaving it to wait for good", async () => {
		const r = start({ jvmOpts: ['-Dforge.net.heartbeatTimeout=2'] });
		await waitUntil(() => r.match.status === 'failed', 'the match to fail', 60_000, status(r));
		console.log(`[jvm] H3: ${r.match.failure}`);
		expect(r.match.failure).toBe("seat 0 lost its connection to Forge's server");
		expect(r.stderr()).toMatch(/timed out after 2 seconds without a network response/);
		expect(r.told()).toBe(true);
	}, 120_000);

	it('H2: a SIGSTOPped JVM is killed once it has said nothing for unresponsiveMs, and both seats are told', async () => {
		const r = start({ unresponsiveMs: 6000 });
		expect(await r.match.whenRunning(120_000)).toEqual({ ok: true });
		// Alive: a running bridge says so well inside the window.
		await new Promise((done) => setTimeout(done, 8000));
		expect(r.match.status).toBe('running');
		const stoppedAt = Date.now();
		process.kill(r.pid(), 'SIGSTOP');
		await waitUntil(() => r.match.status === 'failed', 'the stopped match to fail', 20_000, status(r));
		const ms = Date.now() - stoppedAt;
		console.log(`[jvm] H2: SIGSTOP → failed in ${ms} ms: ${r.match.failure}`);
		expect(ms).toBeLessThan(6000 + 3000);
		expect(r.match.failure).toMatch(/^the JVM stopped answering \(nothing from it for \d+ s\), so it was killed; see /);
		expect(r.told()).toBe(true);
		await waitUntil(() => liveJvmCount() === 0, 'the JVM to be gone', 10_000);
	}, 180_000);

	it('H7: a JVM out of heap exits (ExitOnOutOfMemoryError) and its match is failed with that exit', async () => {
		const r = start({ jvmOpts: ['-Dcardtable.fault=oom'] });
		await waitUntil(() => r.match.status === 'failed', 'the match to fail', 60_000, status(r));
		console.log(`[jvm] H7: ${r.match.failure}`);
		expect(r.match.failure).toMatch(/^the JVM exited \(code 3, signal null\)/);
		// HotSpot says so on stdout, which is the protocol pipe: it arrives as a line that is not JSON.
		expect(r.logs.some((l) => l.evt === 'bridge-noise' && /^Terminating due to java\.lang\.OutOfMemoryError/.test(String(l.text)))).toBe(true);
	}, 120_000);

	it.skipIf(!nightly)("[nightly] H3: Forge's 45 s client timeout is raised, so seats whose clients sent nothing for 50 s still answer", async () => {
		// The clients' heartbeat every 15 s is what kept Forge's 45 s read timeout from firing; turned off here.
		const r = start({ jvmOpts: ['-Dforge.net.heartbeatInterval=600'] }, { ...VS_AI, seats: [VS_AI.seats[0], { ...VS_AI.seats[0], name: 'Seat 2' }] });
		expect(await r.match.whenRunning(120_000)).toEqual({ ok: true });
		await new Promise((done) => setTimeout(done, 50_000));
		expect(r.match.status).toBe('running');
		const probe = r.match.probe(0, 'liveness.jvm.test: still connected?', 30_000);
		const isProbe = (s: { seat: number; envelope: ServerEnvelope }): boolean =>
			s.seat === 0 && s.envelope.frame.kind === 'ask' && JSON.stringify(s.envelope.frame).includes('still connected?');
		await waitUntil(() => r.sent.some(isProbe), 'the ask', 30_000);
		const ask = r.sent.find(isProbe)?.envelope.frame as { callId: string };
		expect(r.match.fromClient(0, ClientFrameSchema.parse({ kind: 'reply', callId: ask.callId, method: 'showConfirmDialog', result: true }))).toEqual({ ok: true });
		expect((await probe).answer).toBe(true);
		expect(r.stderr()).not.toMatch(/timed out after \d+ seconds without a network response/);
	}, 180_000);
});
