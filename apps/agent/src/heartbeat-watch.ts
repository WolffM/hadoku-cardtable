/**
 * Why a heartbeat went out late, measured where it is sent.
 *
 * The coordinator fails a claw whose heartbeat it has not heard for the fence
 * window. Twice on claw-9 (2026-11-09 20:21Z, 2026-11-15 00:45Z) it did so with
 * the agent's PID unchanged, no reboot, a quiet LAN and every other claw heard,
 * and the agent's own log could not say whether its heartbeats were never sent
 * (a stalled event loop), slow to build (a cgroup or /proc read), or written
 * and stuck behind a full socket. Each heartbeat now checks the gap since the
 * last one, and a late one is logged with all three.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

/** What a late heartbeat measured. */
export type LateBeat = {
	/** Since the previous heartbeat, by the agent's clock; due every `everyMs`. */
	gapMs: number;
	/** The event loop's worst delay since the previous heartbeat. */
	loopMaxMs: number;
};

export class HeartbeatWatch {
	private last: number | null = null;
	private readonly delay: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 });

	constructor(
		private readonly everyMs: number,
		private readonly now: () => number,
	) {
		this.delay.enable();
	}

	/** At each heartbeat, before it is built: the late beat it is, or null on time. One missed beat is late. */
	beat(): LateBeat | null {
		const at = this.now();
		const gapMs = this.last === null ? 0 : at - this.last;
		this.last = at;
		const loopMaxMs = this.loopMaxMs();
		this.delay.reset();
		return gapMs > 2 * this.everyMs ? { gapMs, loopMaxMs } : null;
	}

	/**
	 * The event loop's worst delay since the last beat, in ms. The histogram counts a delay only
	 * from its first sample after a reset, so a stall that begins within one sampling tick (20 ms)
	 * of a beat reads low here; the late beat's `gapMs` still shows it.
	 */
	loopMaxMs(): number {
		return Math.round(this.delay.max / 1e6);
	}

	/** True when building and writing a heartbeat took longer than the interval it serves. */
	slow(buildMs: number): boolean {
		return buildMs > this.everyMs;
	}

	stop(): void {
		this.delay.disable();
	}
}
