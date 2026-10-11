/**
 * The warm spare, measured: cold start against spare start, same decks, same
 * seed, alternating, through the same `Match` path the socket server uses.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… \
 *   pnpm --filter @hadoku/server exec tsx src/play/dev/spare-bench.ts [--runs 5]
 *
 * Per run it reports, from `registry.create()`:
 *   first  — the first envelope any seat is sent (that seat's `openView`)
 *   running — both seats have their Forge player (`whenRunning`), which is when
 *             `POST /api/play/matches` answers
 * and the JVM's VmRSS at `running` (and the idle spare's, before adoption).
 *
 * A warm run is measured the way production meets it: the spare has finished
 * booting, and adopting it spawns the replacement spare at once, so the warm
 * match starts while another JVM boots beside it. A cold run has no spare.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { jvmHostConfig, jvmHostFactory, liveJvmCount, type MatchSpec } from '../host.js';
import { createMatchRegistry } from '../match.js';

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const available = jvmHostConfig();
if (!available.ok) {
	console.error(`no Forge: ${available.reason}`);
	process.exit(2);
}
const config = available.config;
const runs = Number(arg('runs') ?? 5);

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

function rssMb(pid: number): number {
	const status = readFileSync(`/proc/${pid}/status`, 'utf8');
	const kb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? NaN);
	return Math.round(kb / 1024);
}

function spec(): MatchSpec {
	const deck = (name: string): string => readFileSync(join(config.res, 'quest', 'precons', `${name}.dck`), 'utf8');
	return {
		seed: 20260918,
		seats: [
			{ name: 'Seat 1', ai: false, deck: deck('Spirit Flames') },
			{ name: 'Seat 2', ai: false, deck: deck('Decay') },
		],
	};
}

interface Sample {
	mode: 'cold' | 'warm';
	firstMs: number;
	runningMs: number;
	rssMb: number;
	spareIdleRssMb: number | null;
}

async function once(mode: 'cold' | 'warm'): Promise<Sample> {
	const logs: Record<string, unknown>[] = [];
	const pool = jvmHostFactory(config, { spare: mode === 'warm', log: (e) => logs.push(e) });
	let spareIdleRssMb: number | null = null;
	if (mode === 'warm') {
		await waitUntil(() => pool.spare() === 'warm', 'the spare', 120_000);
		const pid = logs.find((l) => l.evt === 'spare-warm')?.pid as number;
		// Let it settle the way an idle spare in production has.
		await new Promise((r) => setTimeout(r, 2000));
		spareIdleRssMb = rssMb(pid);
	}
	let firstAt = 0;
	const registry = createMatchRegistry({
		host: pool,
		log: (e) => logs.push(e),
		overGraceMs: 60_000,
		emit: () => {
			if (firstAt === 0) firstAt = Date.now();
		},
	});
	const t0 = Date.now();
	const match = registry.create(spec());
	const running = await match.whenRunning(120_000);
	const runningAt = Date.now();
	if (!running.ok) throw new Error(`the match failed: ${running.error}`);
	const pid = logs.find((l) => l.evt === (mode === 'warm' ? 'spare-adopted' : 'jvm-spawned') && l.pid !== undefined)?.pid as number;
	const sample: Sample = { mode, firstMs: firstAt - t0, runningMs: runningAt - t0, rssMb: rssMb(pid), spareIdleRssMb };
	match.stop();
	pool.close();
	await waitUntil(() => liveJvmCount() === 0, 'every JVM to exit', 30_000);
	return sample;
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? (s[m] as number) : Math.round(((s[m - 1] as number) + (s[m] as number)) / 2);
}

const samples: Sample[] = [];
for (let i = 0; i < runs; i++) {
	for (const mode of ['cold', 'warm'] as const) {
		const s = await once(mode);
		samples.push(s);
		console.log(
			`run ${i + 1} ${mode}: first event ${s.firstMs} ms, running ${s.runningMs} ms, RSS at running ${s.rssMb} MB` +
				(s.spareIdleRssMb === null ? '' : `, idle spare RSS ${s.spareIdleRssMb} MB`),
		);
	}
}
for (const mode of ['cold', 'warm'] as const) {
	const xs = samples.filter((s) => s.mode === mode);
	console.log(
		`${mode}: n=${xs.length}, first event median ${median(xs.map((s) => s.firstMs))} ms ` +
			`(min ${Math.min(...xs.map((s) => s.firstMs))}, max ${Math.max(...xs.map((s) => s.firstMs))}), ` +
			`running median ${median(xs.map((s) => s.runningMs))} ms, RSS median ${median(xs.map((s) => s.rssMb))} MB`,
	);
}
