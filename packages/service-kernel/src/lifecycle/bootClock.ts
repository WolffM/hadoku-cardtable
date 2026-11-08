/**
 * The boot's own stopwatch: one `boot-phase` line per step between process start and listen, each
 * with its own `ms` and the `at` since the process began (`performance.now()`'s origin), logged as
 * the step ends. A boot that never listens has printed every phase it finished, so the last line
 * names the step after it as the one it is stuck in.
 */
export function bootClock(log: (entry: Record<string, unknown>) => void): (phase: string) => void {
	let last = 0;
	return (phase) => {
		const now = performance.now();
		log({ evt: 'boot-phase', phase, ms: Math.round(now - last), at: Math.round(now) });
		last = now;
	};
}
