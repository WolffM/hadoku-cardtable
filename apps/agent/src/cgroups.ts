/**
 * The agent's place in cgroup v2, and its JVMs'.
 *
 * fleet-manager runs the agent in `hosting.slice/hosting-cardtable.slice/<unit>`
 * with `Delegate=yes` and `KillMode=process`, so a restart kills only the
 * agent's own process (H15). cgroup v2 allows no process in a cgroup that has
 * children, so the agent moves itself into the leaf `agent/` and puts each JVM
 * in a leaf `run-<hostId>/` beside it; a JVM's leaf outlives the agent.
 *
 * `root` is the cgroup filesystem's mount (`/sys/fs/cgroup`), a directory in
 * tests. With `root` null (a dev box, `--no-cgroups`), nothing is delegated:
 * JVMs stay where the agent is and the slice reads as unknown.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SliceHealth } from '../../server/src/play/remote/wire.ts';

const MB = 1024 * 1024;

export class Cgroups {
	/** The agent unit's cgroup, or null when not delegated. */
	readonly service: string | null;

	constructor(
		root: string | null,
		ownCgroupFile = '/proc/self/cgroup',
		private readonly log: (what: string, data?: Record<string, unknown>) => void = () => {},
	) {
		this.service = root === null ? null : Cgroups.delegate(root, ownCgroupFile, log);
	}

	get delegated(): boolean {
		return this.service !== null;
	}

	/** Only in a hosting slice: anywhere else the cgroup is somebody else's (a shell's scope, say). */
	private static delegate(root: string, ownCgroupFile: string, log: (what: string, data?: Record<string, unknown>) => void): string | null {
		const own = readFileSync(ownCgroupFile, 'utf8').trim().split('::').pop() ?? '';
		const service = join(root, own.replace(/\/agent$/, ''));
		if (!service.includes('/hosting.slice/')) {
			log('not-delegated', { cgroup: service, why: 'not in hosting.slice' });
			return null;
		}
		try {
			mkdirSync(join(service, 'agent'), { recursive: true });
			writeFileSync(join(service, 'agent', 'cgroup.procs'), String(process.pid));
			return service;
		} catch (e) {
			log('not-delegated', { cgroup: service, error: (e as NodeJS.ErrnoException).code });
			return null;
		}
	}

	/** Put `pid` in the JVM's own leaf. */
	place(hostId: string, pid: number): string | null {
		if (this.service === null) return null;
		const leaf = join(this.service, `run-${hostId}`);
		mkdirSync(leaf, { recursive: true });
		writeFileSync(join(leaf, 'cgroup.procs'), String(pid));
		return leaf;
	}

	procs(hostId: string): number[] {
		if (this.service === null) return [];
		try {
			return readFileSync(join(this.service, `run-${hostId}`, 'cgroup.procs'), 'utf8').trim().split('\n').filter(Boolean).map(Number);
		} catch {
			return [];
		}
	}

	/** Every JVM leaf that still holds a process: what a restarted agent adopts. */
	liveLeaves(): Map<string, number[]> {
		const out = new Map<string, number[]>();
		if (this.service === null) return out;
		for (const d of readdirSync(this.service)) {
			if (!d.startsWith('run-')) continue;
			const pids = this.procs(d.slice(4));
			if (pids.length) out.set(d.slice(4), pids);
		}
		return out;
	}

	remove(hostId: string): void {
		if (this.service === null) return;
		const leaf = join(this.service, `run-${hostId}`);
		if (!existsSync(leaf)) return;
		try {
			rmdirSync(leaf);
		} catch (e) {
			this.log('rmdir', { leaf, error: (e as NodeJS.ErrnoException).code });
		}
	}

	/** The JVM leaf's `memory.events` `oom_kill`, when it has one. */
	oomKills(hostId: string): number {
		if (this.service === null) return 0;
		return counters(read(join(this.service, `run-${hostId}`, 'memory.events')))['oom_kill'] ?? 0;
	}

	/** The tenant slice (the unit's parent): what bounds every JVM together. */
	slice(): SliceHealth {
		if (this.service === null) {
			return { cgroup: null, delegated: false, memoryMaxMb: null, memoryCurrentMb: null, memoryEvents: {}, cpuStat: {}, cpus: null };
		}
		const slice = join(this.service, '..');
		const num = (f: string): number | null => {
			const v = read(join(slice, f));
			return v === null || v === 'max' ? null : Math.floor(Number(v) / MB);
		};
		const cpuMax = read(join(slice, 'cpu.max'))?.split(' ');
		const cpus = cpuMax && cpuMax[0] !== 'max' ? Math.max(1, Math.floor(Number(cpuMax[0]) / Number(cpuMax[1]))) : null;
		return {
			cgroup: slice,
			delegated: true,
			memoryMaxMb: num('memory.max'),
			memoryCurrentMb: num('memory.current'),
			memoryEvents: counters(read(join(slice, 'memory.events'))),
			cpuStat: counters(read(join(slice, 'cpu.stat'))),
			cpus,
		};
	}
}

function read(file: string): string | null {
	try {
		return readFileSync(file, 'utf8').trim();
	} catch {
		return null;
	}
}

/** "key value" lines, as `memory.events` and `cpu.stat` print them. */
export function counters(text: string | null): Record<string, number> {
	const out: Record<string, number> = {};
	for (const line of (text ?? '').split('\n')) {
		const [k, v] = line.split(' ');
		if (k && v !== undefined && Number.isFinite(Number(v))) out[k] = Number(v);
	}
	return out;
}
