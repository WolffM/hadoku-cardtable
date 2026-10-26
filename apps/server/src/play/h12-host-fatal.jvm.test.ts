/**
 * A `PlayBridge --host` JVM: a config with no human seat is refused, and a throw out of a
 * match's own thread ends that match as `fatal`, never as a clean `stopped`.
 *
 * Skips, saying why in its name, unless the Forge build is configured
 * (`CARDTABLE_FORGE_JAR`, `CARDTABLE_FORGE_RES`), like every `*.jvm.test.ts`.
 *
 * Two AI seats used to reach `ready`, then Forge's `HostedMatch.startGame` opened its desktop
 * spectator view for a game with no human (`GuiDesktop.getNewGuiGame` → a Swing frame →
 * `HeadlessException`, as an `ExceptionInInitializerError` on the `bridge-match-…` thread). That
 * `Error` slipped past the thread's `catch (Exception)`, and the match read as `stopped`.
 *
 * What it proves, in one JVM started with the test-only `-Dcardtable.fault=match-throw` (the
 * match's own thread throws an `Error` once the match is ready):
 * - an AI-against-AI `start` is `rejected` in words before Forge is touched, with no `ready`;
 * - a playable match that throws on its own thread says `fatal` (naming the throw) before
 *   `stopped`, and the JVM goes on: a second match starts after it, and the host exits 0.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bridgeLaunch, jvmHostConfig, stageRunDir } from './host.js';

const available = jvmHostConfig();
const title = available.ok
	? 'a --host match that cannot be played, or throws, is never a clean stop'
	: `a --host match that cannot be played, or throws, is never a clean stop — SKIPPED: ${available.reason}`;

type Line = { t: string; match: string; [k: string]: unknown };

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number, detail: () => string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}\n${detail()}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

describe.skipIf(!available.ok)(title, () => {
	const hostId = `h12-host-${process.pid}`;
	const lines: Line[] = [];
	const raw: string[] = [];
	let child: ChildProcess | null = null;
	let exited: Promise<number | null> = Promise.resolve(null);
	let run = '';
	let deck = '';

	const send = (cmd: Record<string, unknown>): void => {
		child?.stdin?.write(`${JSON.stringify(cmd)}\n`);
	};
	const of = (match: string, t?: string): Line[] => lines.filter((l) => l.match === match && (t === undefined || l.t === t));
	// The whole of bridge.stderr.txt: the cause of a thread's throw is deep in its stack trace.
	const detail = (): string =>
		`${raw.filter((l) => !l.includes('"t":"alive"')).slice(-20).join('\n')}\n--- bridge.stderr.txt\n${readFileSync(join(run, 'bridge.stderr.txt'), 'utf8')}`;

	beforeAll(async () => {
		if (!available.ok) throw new Error('unreachable');
		const config = available.config;
		deck = readFileSync(join(config.res, 'quest', 'precons', 'Spirit Flames.dck'), 'utf8');
		run = stageRunDir(config, hostId);
		const bridge = bridgeLaunch(config, () => {});
		const stderr = openSync(join(run, 'bridge.stderr.txt'), 'a');
		const jvm = spawn(
			config.java,
			[
				'-Djava.awt.headless=true',
				`-Djava.io.tmpdir=${join(run, 'jvm-tmp')}`,
				...config.jvmOpts,
				'-Dcardtable.fault=match-throw',
				...bridge.args,
				'--host',
				hostId,
			],
			{ cwd: run, stdio: ['pipe', 'pipe', stderr] },
		);
		closeSync(stderr);
		child = jvm;
		if (jvm.stdout === null) throw new Error('the JVM has no stdout pipe');
		exited = new Promise((resolve) => jvm.on('exit', (code) => resolve(code)));
		createInterface({ input: jvm.stdout }).on('line', (text) => {
			raw.push(text);
			lines.push(JSON.parse(text) as Line);
		});
		await waitUntil(() => of(hostId, 'warm').length === 1, 'the host to boot', 90_000, detail);
	}, 120_000);

	afterAll(() => {
		if (child !== null && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
		if (run !== '') rmSync(run, { recursive: true, force: true });
	});

	it('refuses a match with no human seat, in words, before Forge is touched', { timeout: 60_000 }, async () => {
		const M = `h12-ai-only-${process.pid}`;
		send({
			t: 'start',
			match: hostId,
			config: { matchId: M, seats: [{ name: 'bot one', ai: true, deck }, { name: 'bot two', ai: true, deck }] },
		});
		await waitUntil(() => of(hostId, 'rejected').some((l) => String(l.command).includes(M)), 'the start to be rejected', 30_000, detail);
		const rejected = of(hostId, 'rejected').find((l) => String(l.command).includes(M));
		expect(String(rejected?.message), detail()).toContain('a match needs a human seat');
		expect(of(M, 'ready'), detail()).toHaveLength(0);
	});

	it('a throw on a match thread is fatal for that match alone, before its stop', { timeout: 180_000 }, async () => {
		const start = (matchId: string): void =>
			send({
				t: 'start',
				match: hostId,
				config: { matchId, seats: [{ name: 'human', ai: false, deck }, { name: 'bot', ai: true, deck }] },
			});
		for (const M of [`h12-throw-a-${process.pid}`, `h12-throw-b-${process.pid}`]) {
			start(M);
			await waitUntil(() => of(M, 'stopped').length === 1, `${M} to end`, 90_000, detail);
			const mine = of(M).map((l) => l.t);
			expect(mine, detail()).toContain('ready');
			const fatal = of(M, 'fatal');
			expect(fatal, detail()).toHaveLength(1);
			expect(String(fatal[0]?.message), detail()).toBe(
				"the match failed: java.lang.Error: cardtable.fault=match-throw: a test-only failure on the match's own thread",
			);
			expect(mine.indexOf('fatal'), detail()).toBeLessThan(mine.indexOf('stopped'));
		}
		expect(readFileSync(join(run, 'bridge.stderr.txt'), 'utf8'), detail()).not.toContain('Exception in thread "bridge-match-');

		send({ t: 'stop', match: hostId });
		expect(await exited, detail()).toBe(0);
		child = null;
	});
});
