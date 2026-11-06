/**
 * What load this server carried, and how close it came to a ceiling: sampled every `SAMPLE_MS`,
 * posted to telemetry as one `capacity` event per window with each gauge's peak and the request
 * rate and latency. Read beside the edge's request log, it says how much traffic a given amount
 * of headroom absorbed — the evidence for "how many players can this take".
 *
 * Gauges are callbacks so this file knows nothing of sockets, rooms or Forge: `index.ts` hands
 * them in, and nothing is read before `start()`. The event loop's delay is measured here (`monitorEventLoopDelay`), because a server
 * whose loop stalls is out of capacity whatever its gauges say.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { NextFunction, Request, Response } from 'express';

import { report as defaultReport, type Report } from './telemetry.js';

export const CAPACITY_WINDOW_MS = 5 * 60_000;
export const SAMPLE_MS = 15_000;

export type Gauges = Record<string, () => number>;

export interface CapacityDeps {
	gauges: Gauges;
	report?: Report;
	now?: () => number;
	windowMs?: number;
	sampleMs?: number;
	/** Counts for the window, read once as each post goes out; the reader resets its own. */
	counts?: () => Record<string, unknown>;
	/** Process memory; `process.memoryUsage` in production. */
	memory?: () => { rss: number; heapUsed: number };
}

export interface CapacitySampler {
	/** Express middleware: counts each finished request and its duration. */
	requests: (req: Request, res: Response, next: NextFunction) => void;
	/** Begin sampling. Called once the server listens: the gauges read what boot builds. */
	start(): void;
	sample(): void;
	flush(): void;
	stop(): void;
}

const MB = 1024 * 1024;

export function capacitySampler(deps: CapacityDeps): CapacitySampler {
	const report = deps.report ?? defaultReport;
	const now = deps.now ?? Date.now;
	const memory = deps.memory ?? (() => process.memoryUsage());
	const loop = monitorEventLoopDelay({ resolution: 20 });
	loop.enable();

	let windowStart = now();
	let peaks: Record<string, number> = {};
	let last: Record<string, number> = {};
	let samples = 0;
	let durations: number[] = [];
	let errors = 0;

	const sample = (): void => {
		samples += 1;
		const m = memory();
		const reading: Record<string, number> = {
			...Object.fromEntries(Object.entries(deps.gauges).map(([k, read]) => [k, read()])),
			rssMb: Math.round(m.rss / MB),
			heapMb: Math.round(m.heapUsed / MB),
		};
		for (const [k, v] of Object.entries(reading)) peaks[k] = Math.max(peaks[k] ?? v, v);
		last = reading;
	};

	const flush = (): void => {
		const start = windowStart;
		windowStart = now();
		const seconds = Math.max(1, (windowStart - start) / 1000);
		const sorted = [...durations].sort((a, b) => a - b);
		const pct = (p: number): number | null =>
			sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
		report('capacity', {
			from: new Date(start).toISOString(),
			minutes: Math.round(seconds / 60),
			samples,
			peak: peaks,
			now: last,
			requests: sorted.length,
			perMin: Math.round((sorted.length / seconds) * 60),
			p50Ms: pct(0.5),
			p95Ms: pct(0.95),
			maxMs: sorted.at(-1) ?? null,
			errors5xx: errors,
			loopP99Ms: Math.round(loop.percentile(99) / 1e6),
			loopMaxMs: Math.round(loop.max / 1e6),
			...deps.counts?.(),
		});
		peaks = {};
		samples = 0;
		durations = [];
		errors = 0;
		loop.reset();
	};

	let timers: NodeJS.Timeout[] = [];

	return {
		requests: (_req, res, next) => {
			const t = process.hrtime.bigint();
			res.on('finish', () => {
				durations.push(Number(process.hrtime.bigint() - t) / 1e6);
				if (res.statusCode >= 500) errors += 1;
			});
			next();
		},
		start: () => {
			if (timers.length > 0) return;
			windowStart = now();
			durations = [];
			loop.reset();
			timers = [
				setInterval(sample, deps.sampleMs ?? SAMPLE_MS),
				setInterval(flush, deps.windowMs ?? CAPACITY_WINDOW_MS),
			];
			for (const t of timers) t.unref();
		},
		sample,
		flush,
		stop: () => {
			for (const t of timers) clearInterval(t);
			timers = [];
			loop.disable();
		},
	};
}
