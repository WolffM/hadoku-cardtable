/**
 * The draft bot service (WolffM/cardtable-draftbot, CubeCobra's recommender) on this claw: one
 * process the agent runs while the coordinator asks for it, from an installed `draftbot` artifact.
 *
 * - **Started** as the artifact's own `scripts/run.sh` (it checks the weights, then runs the service;
 *   it fetches nothing, and the claw has no egress), with the agent's node first on `PATH`, on a free
 *   loopback port, with a fresh shared secret: the service answers nothing but `/healthcheck`
 *   without it, so CI on the same claw cannot use it.
 * - **Capped** in its own leaf, `draftbot/`, at `DRAFTBOT_MB` (`cgroups.ts` `placeCapped`), never
 *   inside a JVM's. The leaf is in the slice, so it ends with the slice.
 * - **Supervised**: `up` once `/healthcheck` answers; if it dies while wanted it starts again, after
 *   a delay that doubles with each death in a row. It is stateless, so fencing leaves it alone, and
 *   a restarted agent kills whatever an earlier one left and waits to be asked again.
 * - **Reached** only through the agent (`forward`): the coordinator's signed request on the agent's
 *   own port, passed on over loopback with the secret.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';

import { DRAFTBOT_MB, type DraftbotHealth } from '../../server/src/play/remote/wire.ts';
import type { Cgroups } from './cgroups.ts';
import { procStartTicks, type Log } from './jvm.ts';

export const DRAFTBOT_LEAF = 'draftbot';
/** How often a starting service's `/healthcheck` is tried. */
export const PROBE_MS = 500;
/** The first restart's delay; it doubles with each death in a row, up to `RESTART_MAX_MS`. */
export const RESTART_MIN_MS = 1000;
export const RESTART_MAX_MS = 30_000;
/** Up this long, a death is the first in a row again. */
export const STABLE_MS = 60_000;
/** A proxied call the service has not answered in this long fails. */
export const FORWARD_TIMEOUT_MS = 10_000;
/** How much of the service's log an exit reason quotes. */
const LOG_TAIL_BYTES = 600;

interface Running {
	sha: string;
	dir: string;
	child: ChildProcess | null;
	port: number;
	token: string;
	upSince: number | null;
	/** Deaths in a row: what the next restart's delay doubles with. */
	deaths: number;
	timer: NodeJS.Timeout | null;
}

export class DraftbotService {
	private run: Running | null = null;
	private health: DraftbotHealth | null = null;
	private readonly logFile: string;
	private readonly pidFile: string;

	constructor(
		private readonly home: string,
		private readonly cgroups: Cgroups,
		private readonly log: Log,
		private readonly now: () => number = Date.now,
	) {
		this.logFile = join(home, 'draftbot.log');
		this.pidFile = join(home, 'draftbot.pid');
		this.killLeftover();
	}

	/** An earlier agent's service: stateless, so it goes, and the coordinator's next word starts ours. */
	private killLeftover(): void {
		this.cgroups.killLeaf(DRAFTBOT_LEAF);
		if (!existsSync(this.pidFile)) return;
		const { pid, startTicks } = JSON.parse(readFileSync(this.pidFile, 'utf8')) as { pid: number; startTicks: string | null };
		if (startTicks !== null && procStartTicks(pid) === startTicks) {
			this.log('draftbot-leftover', { pid, note: 'an earlier agent left it running; killed' });
			killGroup(pid);
		}
		rmSync(this.pidFile, { force: true });
	}

	/** The artifact it runs (or is starting, or restarting): what holds its reserve in the slice. */
	get running(): string | null {
		return this.run?.sha ?? null;
	}

	status(): DraftbotHealth | null {
		if (this.health === null) return null;
		const pid = this.run?.child?.pid ?? null;
		return { ...this.health, pid, memoryMb: pid === null ? null : (this.cgroups.memoryMb(DRAFTBOT_LEAF) ?? rssMb(pid)) };
	}

	/** Run artifact `sha`, installed at `dir`. A no-op when it already does. */
	want(sha: string, dir: string): void {
		if (this.run?.sha === sha) return;
		this.stop();
		this.run = { sha, dir, child: null, port: 0, token: '', upSince: null, deaths: 0, timer: null };
		this.health = { sha, state: 'starting', pid: null, memoryMb: null, restarts: 0, error: null, since: this.now() };
		void this.start(this.run);
	}

	/** It cannot run here: said in the heartbeat until the coordinator asks for something else. */
	refuse(sha: string, why: string): void {
		this.stop();
		this.health = { sha, state: 'refused', pid: null, memoryMb: null, restarts: 0, error: why, since: this.now() };
		this.log('draftbot-refused', { sha, why });
	}

	/** Stop it and want nothing. */
	stop(): void {
		const run = this.run;
		this.run = null;
		this.health = null;
		if (run === null) return;
		if (run.timer !== null) clearTimeout(run.timer);
		this.kill(run);
		this.log('draftbot-stopped', { sha: run.sha });
	}

	private kill(run: Running): void {
		this.cgroups.killLeaf(DRAFTBOT_LEAF);
		if (run.child?.pid !== undefined) killGroup(run.child.pid);
		rmSync(this.pidFile, { force: true });
	}

	private set(run: Running, state: DraftbotHealth['state'], error: string | null = null): void {
		if (this.run !== run || this.health === null) return;
		this.health = { ...this.health, state, error, since: this.now() };
	}

	private async start(run: Running): Promise<void> {
		run.port = await freePort();
		run.token = randomBytes(24).toString('base64url');
		if (this.run !== run) return;
		const out = openSync(this.logFile, 'w');
		const child = spawn(join(run.dir, 'scripts', 'run.sh'), [], {
			cwd: run.dir,
			detached: true,
			stdio: ['ignore', out, out],
			// NODE_ENV stays unset: the service ships its logs to CloudWatch under `production`.
			env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: this.home, PORT: String(run.port), RECOMMENDER_SHARED_SECRET: run.token },
		});
		closeSync(out);
		run.child = child;
		run.upSince = null;
		if (child.pid === undefined) {
			child.on('error', (e) => this.died(run, child, `could not start: ${e.message}`));
			return;
		}
		writeFileSync(this.pidFile, JSON.stringify({ pid: child.pid, startTicks: procStartTicks(child.pid) }));
		const leaf = this.cgroups.placeCapped(DRAFTBOT_LEAF, child.pid, DRAFTBOT_MB);
		this.log('draftbot-started', { sha: run.sha, pid: child.pid, port: run.port, leaf, capMb: leaf === null ? null : DRAFTBOT_MB });
		child.on('exit', (code, signal) => this.died(run, child, `exited ${signal ?? `with ${code}`}`));
		this.probe(run, child);
	}

	private probe(run: Running, child: ChildProcess): void {
		run.timer = setTimeout(() => {
			if (this.run !== run || run.child !== child) return;
			fetch(`http://127.0.0.1:${run.port}/healthcheck`, { signal: AbortSignal.timeout(PROBE_MS * 2) })
				.then((res) => res.ok)
				.catch(() => false)
				.then((ok) => {
					if (this.run !== run || run.child !== child) return;
					if (!ok) return this.probe(run, child);
					run.timer = null;
					run.upSince = this.now();
					this.set(run, 'up');
					this.log('draftbot-up', { sha: run.sha, pid: child.pid, port: run.port });
				});
		}, PROBE_MS);
	}

	private died(run: Running, child: ChildProcess, how: string): void {
		if (this.run !== run || run.child !== child) return;
		if (run.timer !== null) clearTimeout(run.timer);
		// Whatever it started (tsx's esbuild) goes with it.
		this.kill(run);
		run.child = null;
		if (run.upSince !== null && this.now() - run.upSince >= STABLE_MS) run.deaths = 0;
		run.deaths += 1;
		const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** (run.deaths - 1));
		const last = tail(this.logFile);
		this.set(run, 'down', `${how}: ${last}`);
		this.log('draftbot-died', { level: 'error', sha: run.sha, pid: child.pid, how, restartInMs: delay, deaths: run.deaths, tail: last });
		run.timer = setTimeout(() => {
			if (this.run !== run) return;
			run.timer = null;
			if (this.health !== null) this.health = { ...this.health, state: 'starting', restarts: this.health.restarts + 1, since: this.now() };
			void this.start(run);
		}, delay);
	}

	/** The coordinator's call, passed to the service: its status and body, or 503 when it is not up. */
	async forward(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
		const run = this.run;
		if (run === null || this.health?.state !== 'up') return { status: 503, body: { error: `the draft bot is ${this.health?.state ?? 'not running'} here` } };
		const res = await fetch(`http://127.0.0.1:${run.port}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-internal-token': run.token },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
		});
		const text = await res.text();
		try {
			return { status: res.status, body: JSON.parse(text) as unknown };
		} catch {
			return { status: 502, body: { error: `the draft bot answered ${res.status} with no JSON: ${text.slice(0, 200)}` } };
		}
	}
}

/** The process group `pid` leads (it was spawned detached), killed whole. */
function killGroup(pid: number): void {
	try {
		process.kill(-pid, 'SIGKILL');
	} catch {
		// Already gone.
	}
}

function rssMb(pid: number): number | null {
	try {
		const kb = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
		return kb === undefined ? null : Math.floor(Number(kb) / 1024);
	} catch {
		return null;
	}
}

function tail(file: string): string {
	try {
		const text = readFileSync(file, 'utf8');
		return text.slice(-LOG_TAIL_BYTES).trim().split('\n').slice(-3).join(' | ');
	} catch {
		return '';
	}
}

/** A loopback port nobody holds right now. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}
