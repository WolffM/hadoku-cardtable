/**
 * The agent's place in cgroup v2, and its JVMs'.
 *
 * fleet-manager runs the agent in `hosting.slice/hosting-cardtable.slice/<unit>`
 * with `Delegate=yes` and `KillMode=process`, so a restart kills only the
 * agent's own process (H15). cgroup v2 allows no process in a cgroup that has
 * children, so the agent moves itself into the leaf `agent/` and puts each JVM
 * in a leaf `run-<hostId>/` beside it; a JVM's leaf outlives the agent.
 *
 * A capped service (today, only the draft bot) lives one level further down,
 * under `caps/<name>/`, with its own `subtree_control` holding `+memory`. For
 * `caps/` to offer `memory` to its own children, the unit's own
 * `subtree_control` must also carry `+memory` — cgroup v2 enables a controller
 * one hop at a time, so every ancestor between the unit and the leaf using it
 * needs the grant, not just the leaf's own parent. `placeCapped`/`killLeaf`
 * keep both levels in step, so **whenever nothing is capped, the unit's
 * `subtree_control` is empty again** — but while the draft bot IS up, the
 * unit's own grant is necessarily non-empty too. That is the one case `caps/`
 * by itself does not cover, and it is exactly cgroup v2's "no internal
 * process" rule: a process can never be added to a cgroup whose own
 * `subtree_control` is non-empty, and systemd places a restarted unit's new
 * main process directly into the unit's own cgroup before this code ever
 * runs. A canary restart on a claw found exactly this: the agent had enabled
 * `+memory` on the unit's root the first time the draft bot ran and never
 * retracted it, so every later restart (old build included) hit "Device or
 * resource busy".
 *
 * Three pieces close it, none alone:
 *   1. **`caps/` + retraction** (this file): once nothing is capped, both
 *      levels clear, so a restart with the draft bot NOT currently up always
 *      succeeds. **`migrate()` is NOT by itself a fix for a stuck legacy
 *      grant.** With the unit's own `subtree_control` already non-empty,
 *      systemd refuses to place a new main process before ANY of this code —
 *      `migrate()` included — ever runs; that is the identical refusal
 *      described above, not something `migrate()` can reach past. It only
 *      ever gets to run for real once piece 3 lands (systemd places the main
 *      process in `agent/` directly, sidestepping the block) or after a
 *      human clears the stuck grant by hand — at which point it cleans up a
 *      leftover leaf safely, since the draft bot never outlives a restart
 *      anyway (`DraftbotService.killLeftover`): there is nothing live to
 *      preserve there, only the stuck grant and the leftover leaf.
 *   2. **A graceful shutdown** (`Agent.shutdown`, wired to `SIGTERM`/`SIGINT`
 *      in `main.ts`): every PLANNED restart (`deploy.sh install`, `systemctl
 *      restart`) sends one of those first, and `Agent.close()` already stops
 *      the draft bot before the process exits — so by the time systemd spawns
 *      the replacement, nothing is capped and (1) already applies.
 *   3. **`DelegateSubgroup=`** (a hadoku-fleet-manager ask,
 *      `docs/requests/2026-11-12-fleet-manager-agent-delegate-subgroup.md`):
 *      the only real fix for a CRASH (`SIGKILL`, an OOM) while the draft bot
 *      is up, AND the only way `migrate()` ever runs against a stuck legacy
 *      grant on its own — this code never gets to run before systemd's
 *      placement fails, so no agent-side logic can save that restart. Until
 *      it lands, a crash with the draft bot up needs a claw recovered by
 *      hand, the way the canary restart above was.
 * A live JVM leaf (`run-*`) is never touched by any of this, in any of the
 * three pieces.
 *
 * `root` is the cgroup filesystem's mount (`/sys/fs/cgroup`), a directory in
 * tests. With `root` null (a dev box, `--no-cgroups`), nothing is delegated:
 * JVMs stay where the agent is and the slice reads as unknown.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SliceHealth } from '@hadoku/host-wire';

const MB = 1024 * 1024;
/** Where every capped leaf lives, one level below the unit's own cgroup. */
const CAPS = 'caps';

export class Cgroups {
	/** The agent unit's cgroup, or null when not delegated. */
	readonly service: string | null;
	/** Names of every leaf this process currently holds under `caps/`. Tracked in memory, not by
	 * reading the tree back: a killed leaf's directory is left in place (as `run-*` leaves always
	 * were — `killLeaf` reuses it next time, same as `placeCapped`'s `mkdirSync` already did), so
	 * "is anything still capped" can never be answered by asking whether `caps/` looks empty. Once
	 * this is empty, the grant is retracted. */
	private readonly capped = new Set<string>();

	constructor(
		root: string | null,
		ownCgroupFile = '/proc/self/cgroup',
		private readonly log: (what: string, data?: Record<string, unknown>) => void = () => {},
	) {
		this.service = root === null ? null : Cgroups.delegate(root, ownCgroupFile, log);
		if (this.service !== null) this.migrate();
	}

	/**
	 * Cleanup, not a fix on its own — see this file's own doc comment for why it can only ever run
	 * once the process is already running (`DelegateSubgroup=`, or a human clearing the unit's own
	 * `subtree_control` by hand first). A legacy capped leaf (anything directly under the unit that
	 * is neither `agent/`, a `run-` JVM leaf, nor `caps/` itself) is killed — the draft bot does not
	 * survive a restart regardless (`DraftbotService.killLeftover`), so there is nothing live to
	 * preserve — and the unit's own `subtree_control` is retracted unconditionally: a freshly
	 * constructed `Cgroups` has placed nothing of its own yet, so nothing below it can need the
	 * grant. Idempotent: a clean start (claw-10's shape today, with no legacy leaf) still retracts,
	 * a no-op when already empty.
	 */
	private migrate(): void {
		if (this.service === null) return;
		let found = false;
		// `withFileTypes`: the unit's own cgroup also lists its kernfs pseudo-files here
		// (`cgroup.procs`, `cgroup.subtree_control`, `memory.max`, …) — only a child *directory* can
		// ever be a leaf.
		for (const d of readdirSync(this.service, { withFileTypes: true })) {
			if (!d.isDirectory() || d.name === 'agent' || d.name === CAPS || d.name.startsWith('run-')) continue;
			found = true;
			const leaf = join(this.service, d.name);
			// `cgroup.kill` is the real-kernel path (every member killed atomically, descendants
			// included); the explicit loop beside it is what makes this killable in the fake cgroup
			// tree the unit tests use, which does not interpret that write at all.
			try {
				writeFileSync(join(leaf, 'cgroup.kill'), '1');
			} catch {
				// no live members, or it is not a cgroup at all; either way, nothing to kill.
			}
			for (const pid of readProcs(leaf)) {
				try {
					process.kill(pid, 'SIGKILL');
				} catch {
					// already gone.
				}
			}
			try {
				rmdirSync(leaf);
			} catch (e) {
				this.log('migrate-rmdir', { leaf, error: (e as NodeJS.ErrnoException).code });
			}
		}
		if (found) this.log('cgroup-migrated', { note: 'a legacy capped leaf sat directly under the unit root; killed, and moves under caps/ from here' });
		this.retract();
	}

	/** Drop the memory grant, from `caps/` back up to the unit's own `subtree_control`. */
	private retract(): void {
		if (this.service === null) return;
		disable(join(this.service, CAPS), 'memory');
		disable(this.service, 'memory');
	}

	get delegated(): boolean {
		return this.service !== null;
	}

	/**
	 * Only in a hosting slice: anywhere else the cgroup is somebody else's (a shell's scope, say).
	 * Reads where THIS process actually is, never assuming it starts at the unit's own root: with
	 * fleet-manager's `DelegateSubgroup=agent` (asked for,
	 * `docs/requests/2026-11-12-fleet-manager-agent-delegate-subgroup.md`), systemd itself places a
	 * restarted main process into `<unit>/agent/` — the same leaf name this code has always used for
	 * itself — so `own` already ends in `/agent` and stripping it back to the unit is exactly the
	 * `mkdirSync`/`writeFileSync` below with nothing to do (the pid is already there).
	 */
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

	/**
	 * Put `pid` in leaf `caps/<name>` under a memory cap of its own. The memory controller is
	 * enabled one level at a time — the unit's own `subtree_control` first (legal here because no
	 * process ever sits in the unit's own cgroup by the time this runs), then `caps/`'s — never left
	 * enabled on anything `run-*` leaves depend on. Null when not delegated, or the cap cannot be
	 * set: the process then runs uncapped beside the agent, and the caller says so.
	 */
	placeCapped(name: string, pid: number, maxMb: number): string | null {
		if (this.service === null) return null;
		const capsDir = join(this.service, CAPS);
		const leaf = join(capsDir, name);
		try {
			enable(this.service, 'memory');
			mkdirSync(capsDir, { recursive: true });
			enable(capsDir, 'memory');
			mkdirSync(leaf, { recursive: true });
			writeFileSync(join(leaf, 'memory.max'), String(maxMb * MB));
			writeFileSync(join(leaf, 'cgroup.procs'), String(pid));
			this.capped.add(name);
			return leaf;
		} catch (e) {
			this.log('cap-failed', { leaf, error: (e as NodeJS.ErrnoException).code ?? (e as Error).message });
			return null;
		}
	}

	/**
	 * Every process in capped leaf `name`, children included, killed at once (`cgroup.kill`); the
	 * leaf's own directory is left in place, to be reused (`placeCapped`'s `mkdirSync` is a no-op on
	 * it). Once nothing is capped any more, the memory grant is retracted all the way back up to the
	 * unit's own `subtree_control`, so the next restart is never refused the way a canary restart
	 * found claw-10's was.
	 */
	killLeaf(name: string): void {
		if (this.service === null) return;
		const leaf = join(this.service, CAPS, name);
		if (existsSync(leaf)) {
			try {
				writeFileSync(join(leaf, 'cgroup.kill'), '1');
			} catch (e) {
				this.log('kill-leaf', { leaf, error: (e as NodeJS.ErrnoException).code });
			}
		}
		this.capped.delete(name);
		if (this.capped.size === 0) this.retract();
	}

	/** Capped leaf `name`'s `memory.current` in MB; null without one. */
	memoryMb(name: string): number | null {
		if (this.service === null) return null;
		const v = read(join(this.service, CAPS, name, 'memory.current'));
		return v === null ? null : Math.floor(Number(v) / MB);
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

/** `leaf`'s `cgroup.procs`, as a list of pids; empty without one. */
function readProcs(leaf: string): number[] {
	try {
		return readFileSync(join(leaf, 'cgroup.procs'), 'utf8').trim().split('\n').filter(Boolean).map(Number);
	} catch {
		return [];
	}
}

/**
 * Enable `controller` for `dir`'s children. Unconditional: re-enabling an already-enabled
 * controller is a harmless no-op on a real kernel, and checking first by reading the file back
 * cannot be made to agree with both a real kernel (which echoes the bare name, "memory") and the
 * fake cgroup tree the unit tests use (which echoes exactly what was last written, "+memory") —
 * so this never reads, only writes.
 */
function enable(dir: string, controller: string): void {
	writeFileSync(join(dir, 'cgroup.subtree_control'), `+${controller}`);
}

/**
 * Retract `controller` from `dir`'s own grant to its children. Unconditional for the same reason
 * `enable` is; disabling an already-disabled controller is also a harmless no-op. Best effort: a
 * missing `dir` (nothing was ever capped there) or a real refusal both fall through quietly — a
 * future `migrate()` retries it.
 */
function disable(dir: string, controller: string): void {
	try {
		writeFileSync(join(dir, 'cgroup.subtree_control'), `-${controller}`);
	} catch {
		// left for the next start's migrate() to retry.
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
