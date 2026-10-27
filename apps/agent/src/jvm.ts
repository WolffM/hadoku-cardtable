/**
 * One `--host` bridge JVM on this claw, launched by this agent or adopted from
 * an earlier one.
 *
 * Its run directory, `<home>/jvms/<hostId>/`, is everything that must outlive
 * the agent:
 *
 *   jvm.json        pid, its kernel start time, size, artifacts, acknowledged offset
 *   in.fifo         stdin. Both ends are opened O_RDWR, so neither the JVM nor a
 *                   restarted agent ever reads EOF from it
 *   out.jsonl       stdout, a FILE the JVM appends to: it is the line buffer the
 *                   coordinator replays from (`attach`), and a JVM never blocks on
 *                   an agent that is restarting
 *   stderr.txt      stderr; its tail goes into the exit reason
 *   gc.log          the JVM's own GC log, which is where heap and GC share come from
 *   exit.json       why it ended, once it has
 *
 * plus Forge's run layout (`res` link, `forge.profile.properties`, `user/`),
 * as `host.ts` `stageRunDir` lays it out for a local JVM, and a `bridge` link
 * to the main class's artifact.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { RECYCLE_HEAP_SHARE, type ArtifactSet, type FromAgent, type JvmHealth, type LaunchSpec } from '../../server/src/play/remote/wire.ts';
import type { Cgroups } from './cgroups.ts';

export type Log = (what: string, data?: Record<string, unknown>) => void;

interface Record_ {
	hostId: string;
	pid: number;
	/** `/proc/<pid>/stat` field 22: a reused pid has another. */
	startTicks: string;
	xmxMb: number;
	artifacts: ArtifactSet;
	launchedAt: number;
	/** The coordinator has taken every line before this byte of `out.jsonl`. */
	acked: number;
	/** The slice's `oom_kill` count at launch, to tell a kernel kill from a crash. */
	sliceOomKills: number;
}

/** The paths a launch resolved its artifacts to. */
export interface Installed {
	java: string;
	jar: string;
	res: string;
	bridge: string;
}

const READ_CHUNK = 64 * 1024;

export function procStartTicks(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		// fields[0] is field 3 (state); field 22 is starttime.
		if (fields[0] === 'Z') return null;
		return fields[19] ?? null;
	} catch {
		return null;
	}
}

function writeJson(file: string, value: unknown): void {
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(value));
	renameSync(tmp, file);
}

function stageRun(dir: string, spec: LaunchSpec, at: Installed): void {
	rmSync(dir, { recursive: true, force: true });
	for (const d of ['user/decks/constructed', 'user/preferences', 'cache', 'jvm-tmp']) mkdirSync(join(dir, d), { recursive: true });
	symlinkSync(at.res, join(dir, 'res'));
	// What the main class ships beside its classes, by a path the coordinator can name.
	symlinkSync(at.bridge, join(dir, 'bridge'));
	const made = spawnSync('mkfifo', [join(dir, 'in.fifo')], { stdio: 'pipe' });
	if (made.status !== 0) throw new Error(`mkfifo: ${made.error?.message ?? made.stderr.toString().trim()}`);
	writeFileSync(
		join(dir, 'forge.profile.properties'),
		`userDir=${dir}/user/\ncacheDir=${dir}/cache/\ndecksDir=${dir}/user/decks/\ndecksConstructedDir=${dir}/user/decks/constructed/\n`,
	);
	writeFileSync(
		join(dir, 'user', 'preferences', 'forge.preferences'),
		`${Object.entries(spec.forgePreferences)
			.map(([k, v]) => `${k}=${v}`)
			.join('\n')}\n`,
	);
}

/** Everything after the bridge's own flags: heap, OOM, CPUs, GC log, classpath, main. */
export function jvmArgs(dir: string, spec: LaunchSpec, at: Installed, cpus: number | null): string[] {
	const own = [
		`-Xms${spec.xmxMb}m`,
		`-Xmx${spec.xmxMb}m`,
		// The whole heap faulted in at start, so GC never asks the kernel for a page mid-match (H14).
		'-XX:+AlwaysPreTouch',
		'-XX:+ExitOnOutOfMemoryError',
		...(cpus === null ? [] : [`-XX:ActiveProcessorCount=${cpus}`]),
		`-Xlog:gc:file=${dir}/gc.log:uptime:filecount=2,filesize=1m`,
	];
	return [
		'-Djava.awt.headless=true',
		`-Djava.io.tmpdir=${dir}/jvm-tmp`,
		...spec.jvmFlags.filter((f) => !own.includes(f)),
		...own,
		'-cp',
		`${at.bridge}:${at.jar}`,
		spec.main,
		'--host',
		spec.hostId,
	];
}

export class Jvm {
	readonly hostId: string;
	readonly dir: string;
	private record: Record_;
	private child: ChildProcess | null = null;
	private stdin: number | null = null;
	/** Where the next line to relay starts in `out.jsonl`. */
	private sent = 0;
	private sink: ((f: FromAgent) => void) | null = null;
	private exitReason: string | null = null;
	private exitSent = false;
	private killedBy: string | null = null;
	private gcOffset = 0;
	private gcPauseMs = 0;
	private heap: { used: number; max: number } | null = null;
	private healthAt: number;
	private pidTimer: NodeJS.Timeout | null = null;

	private constructor(
		dir: string,
		record: Record_,
		private readonly cgroups: Cgroups,
		private readonly log: Log,
		private readonly now: () => number,
	) {
		this.dir = dir;
		this.hostId = record.hostId;
		this.record = record;
		this.sent = record.acked;
		this.healthAt = now();
	}

	get pid(): number {
		return this.record.pid;
	}
	get xmxMb(): number {
		return this.record.xmxMb;
	}
	get artifacts(): ArtifactSet {
		return this.record.artifacts;
	}
	get exited(): boolean {
		return this.exitReason !== null;
	}
	get attached(): boolean {
		return this.sink !== null;
	}

	static launch(dir: string, spec: LaunchSpec, at: Installed, cgroups: Cgroups, log: Log, now: () => number = Date.now): Jvm {
		stageRun(dir, spec, at);
		const stdinFd = openSync(join(dir, 'in.fifo'), 'r+');
		const outFd = openSync(join(dir, 'out.jsonl'), 'a');
		const errFd = openSync(join(dir, 'stderr.txt'), 'a');
		let child: ChildProcess;
		try {
			// `detached`: its own process group, so nothing aimed at the agent's reaches it.
			child = spawn(at.java, jvmArgs(dir, spec, at, cgroups.slice().cpus), { cwd: dir, stdio: [stdinFd, outFd, errFd], detached: true });
		} finally {
			for (const fd of [stdinFd, outFd, errFd]) closeSync(fd);
		}
		if (child.pid === undefined) throw new Error(`could not start ${at.java}`);
		child.unref();
		cgroups.place(spec.hostId, child.pid);
		const record: Record_ = {
			hostId: spec.hostId,
			pid: child.pid,
			startTicks: procStartTicks(child.pid) ?? '',
			xmxMb: spec.xmxMb,
			artifacts: spec.artifacts,
			launchedAt: now(),
			acked: 0,
			sliceOomKills: cgroups.slice().memoryEvents['oom_kill'] ?? 0,
		};
		writeJson(join(dir, 'jvm.json'), record);
		const jvm = new Jvm(dir, record, cgroups, log, now);
		jvm.child = child;
		child.on('error', (e) => jvm.ended({ error: e.message }));
		child.on('exit', (code, signal) => jvm.ended({ code, signal }));
		jvm.openStdin();
		log('jvm-launched', { hostId: spec.hostId, pid: child.pid, xmxMb: spec.xmxMb });
		return jvm;
	}

	/** The JVM an earlier agent left in `dir`: live, or already ended while nobody watched. */
	static adopt(dir: string, cgroups: Cgroups, log: Log, now: () => number = Date.now): Jvm | null {
		let record: Record_;
		try {
			record = JSON.parse(readFileSync(join(dir, 'jvm.json'), 'utf8')) as Record_;
		} catch (e) {
			log('adopt-skipped', { dir, error: (e as Error).message });
			return null;
		}
		const jvm = new Jvm(dir, record, cgroups, log, now);
		const done = existsSync(join(dir, 'exit.json')) ? (JSON.parse(readFileSync(join(dir, 'exit.json'), 'utf8')) as { reason: string }) : null;
		if (done !== null) {
			jvm.exitReason = done.reason;
			return jvm;
		}
		if (!jvm.alive()) {
			jvm.ended({ adopted: true });
			return jvm;
		}
		jvm.openStdin();
		jvm.pidTimer = setInterval(() => {
			if (!jvm.alive()) jvm.ended({ adopted: true });
		}, 500);
		log('jvm-adopted', { hostId: record.hostId, pid: record.pid, acked: record.acked, cgroupProcs: cgroups.procs(record.hostId) });
		return jvm;
	}

	private alive(): boolean {
		return this.record.startTicks !== '' && procStartTicks(this.record.pid) === this.record.startTicks;
	}

	private openStdin(): void {
		this.stdin = openSync(join(this.dir, 'in.fifo'), 'r+');
	}

	/** One line to the JVM's stdin. Dropped once it has exited. */
	write(line: string): void {
		if (this.exited || this.stdin === null) return;
		writeSync(this.stdin, `${line}\n`);
	}

	/** End it now. `by` is the reason it gets. */
	kill(by: string): void {
		if (this.exited) return;
		this.killedBy = by;
		try {
			process.kill(this.record.pid, 'SIGKILL');
		} catch (e) {
			this.log('kill-failed', { hostId: this.hostId, error: (e as NodeJS.ErrnoException).code });
		}
		// An adopted JVM is no child of ours: its exit is seen by the pid poll.
	}

	/** Relay to `sink` from byte `from` (default: what the coordinator last acknowledged). */
	attach(sink: (f: FromAgent) => void, from?: number): void {
		this.sink = sink;
		this.sent = from ?? this.record.acked;
		this.exitSent = false;
		this.pump();
	}

	/** Stop relaying; the coordinator had every line before `off`. */
	release(off?: number): void {
		this.sink = null;
		if (off !== undefined) this.ack(off);
	}

	ack(off: number): void {
		if (off <= this.record.acked) return;
		this.record = { ...this.record, acked: off };
		writeJson(join(this.dir, 'jvm.json'), this.record);
	}

	/** Relay every complete line not yet sent, then the exit once the file is drained. */
	pump(): void {
		if (this.sink === null) return;
		const file = join(this.dir, 'out.jsonl');
		let fd: number;
		try {
			fd = openSync(file, 'r');
		} catch {
			return; // nothing printed yet
		}
		try {
			const buf = Buffer.alloc(READ_CHUNK);
			let pending = Buffer.alloc(0);
			let pos = this.sent;
			for (;;) {
				const n = readSync(fd, buf, 0, READ_CHUNK, pos);
				if (n === 0) break;
				pos += n;
				pending = Buffer.concat([pending, buf.subarray(0, n)]);
				let nl: number;
				while ((nl = pending.indexOf(10)) >= 0) {
					const line = pending.subarray(0, nl).toString('utf8');
					pending = pending.subarray(nl + 1);
					this.sent += nl + 1;
					if (line !== '') this.sink({ t: 'line', h: this.hostId, off: this.sent, line });
					if (this.sink === null) return;
				}
			}
		} finally {
			closeSync(fd);
		}
		if (this.exitReason !== null && !this.exitSent) {
			this.exitSent = true;
			this.sink({ t: 'exit', h: this.hostId, reason: this.exitReason });
		}
	}

	private ended(how: { code?: number | null; signal?: string | null; error?: string; adopted?: boolean }): void {
		if (this.exitReason !== null) return;
		if (this.pidTimer !== null) clearInterval(this.pidTimer);
		this.exitReason = this.reasonFor(how);
		writeJson(join(this.dir, 'exit.json'), { reason: this.exitReason, at: this.now() });
		if (this.stdin !== null) {
			closeSync(this.stdin);
			this.stdin = null;
		}
		this.cgroups.remove(this.hostId);
		this.log('jvm-exit', { hostId: this.hostId, pid: this.record.pid, reason: this.exitReason });
		this.pump();
	}

	private reasonFor(how: { code?: number | null; signal?: string | null; error?: string; adopted?: boolean }): string {
		if (this.killedBy !== null) return this.killedBy;
		if (how.error !== undefined) return `could not start: ${how.error}`;
		const oom = this.cgroups.oomKills(this.hostId) > 0 || (this.cgroups.slice().memoryEvents['oom_kill'] ?? 0) > this.record.sliceOomKills;
		if (oom && (how.signal === 'SIGKILL' || how.adopted)) return 'kernel OOM kill (memory.events oom_kill)';
		// -XX:+ExitOnOutOfMemoryError exits with 3.
		if (how.code === 3) return `Java heap exhausted (exit 3)${this.stderrTail()}`;
		if (how.adopted) return `exited while the agent was restarting (status unknown)${this.stderrTail()}`;
		return `exited (code ${how.code ?? 'none'}, signal ${how.signal ?? 'none'})${this.stderrTail()}`;
	}

	private stderrTail(): string {
		try {
			const lines = readFileSync(join(this.dir, 'stderr.txt'), 'utf8').trim().split('\n').filter(Boolean).slice(-5);
			return lines.length ? `: ${lines.join(' | ')}` : '';
		} catch {
			return '';
		}
	}

	/** The run directory goes once the coordinator has the exit. */
	forget(): void {
		if (this.pidTimer !== null) clearInterval(this.pidTimer);
		rmSync(this.dir, { recursive: true, force: true });
	}

	health(): JvmHealth {
		this.readGcLog();
		const now = this.now();
		const window = Math.max(1, now - this.healthAt);
		const gcShare = this.gcPauseMs / window;
		this.gcPauseMs = 0;
		this.healthAt = now;
		return {
			hostId: this.hostId,
			pid: this.record.pid,
			xmxMb: this.record.xmxMb,
			rssMb: this.rssMb(),
			heapUsedMb: this.heap?.used ?? null,
			heapMaxMb: this.heap?.max ?? null,
			gcShare: Math.min(1, Math.round(gcShare * 1000) / 1000),
			recycleWanted: this.heap !== null && this.heap.used > RECYCLE_HEAP_SHARE * this.record.xmxMb,
			attached: this.attached,
		};
	}

	private rssMb(): number | null {
		try {
			const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${this.record.pid}/status`, 'utf8'));
			return m ? Math.round(Number(m[1]) / 1024) : null;
		} catch {
			return null;
		}
	}

	/** New pause lines of `gc.log` since the last read. */
	private readGcLog(): void {
		const file = join(this.dir, 'gc.log');
		let size: number;
		try {
			size = statSync(file).size;
		} catch {
			return;
		}
		if (size < this.gcOffset) this.gcOffset = 0; // rotated
		if (size === this.gcOffset) return;
		const fd = openSync(file, 'r');
		const buf = Buffer.alloc(size - this.gcOffset);
		try {
			readSync(fd, buf, 0, buf.length, this.gcOffset);
		} finally {
			closeSync(fd);
		}
		const text = buf.toString('utf8');
		const end = text.lastIndexOf('\n') + 1;
		this.gcOffset += Buffer.byteLength(text.slice(0, end));
		const parsed = parseGcLog(text.slice(0, end));
		this.gcPauseMs += parsed.pauseMs;
		if (parsed.heap !== null) this.heap = parsed.heap;
	}
}

/**
 * Pause lines of unified GC logging (`-Xlog:gc`), e.g.
 * `[12.345s] GC(7) Pause Young (Normal) (G1 Evacuation Pause) 412M->96M(2200M) 4.512ms`:
 * the pause time, and the heap after the last pause against its size.
 */
export function parseGcLog(text: string): { pauseMs: number; heap: { used: number; max: number } | null } {
	let pauseMs = 0;
	let heap: { used: number; max: number } | null = null;
	for (const m of text.matchAll(/GC\(\d+\) Pause .*? (\d+)M->(\d+)M\((\d+)M\) ([\d.]+)ms/g)) {
		pauseMs += Number(m[4]);
		heap = { used: Number(m[2]), max: Number(m[3]) };
	}
	return { pauseMs, heap };
}
