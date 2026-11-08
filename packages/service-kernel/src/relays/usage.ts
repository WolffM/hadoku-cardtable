/**
 * A browser relay for usage batches: which screens were shown and which controls pressed, counted
 * here and posted to telemetry as one `usage` event per window — how often, by how many people,
 * by tier. Nothing per click is kept, and nothing is answered but 204. The schema, the mount path
 * and the caller's tier/id are all parameters — this module knows no game's usage shape.
 *
 * A caller sending more than `maxBatchesPerMinute` is a client bug or a script; the rest of that
 * minute is dropped and counted as `dropped`, so the event says so.
 */
import type { Request, Response } from 'express';
import { Router } from 'express';

import { bodyErrors } from '../limits/limits.ts';
import { report as defaultReport, type Report } from '../telemetry/telemetry.ts';

export const USAGE_WINDOW_MS = 5 * 60_000;
export const MAX_BATCHES_PER_MINUTE = 10;
/** How many (kind, screen, target) rows one event lists, busiest first. */
export const USAGE_TOP = 60;

export interface UsageEntry {
	kind: string;
	screen: string;
	target?: string;
}

export interface UsageSchema<T extends { entries: readonly UsageEntry[] }> {
	safeParse(body: unknown): { success: true; data: T } | { success: false };
}

export interface UsageOptions<T extends { entries: readonly UsageEntry[] }> {
	schema: UsageSchema<T>;
	/** The mount path under `api`, e.g. `/api/<path>`. */
	path: string;
	tierOf: (req: Request) => string;
	userIdOf: (req: Request) => string;
	report?: Report;
	now?: () => number;
	windowMs?: number;
	maxBatchesPerMinute?: number;
	top?: number;
}

export interface UsageCounter {
	/** Post the window counted so far, if anything arrived, and start a new one. */
	flush(): void;
	stop(): void;
}

export function attachUsage<T extends { entries: readonly UsageEntry[] }>(api: Router, opts: UsageOptions<T>): UsageCounter {
	const report = opts.report ?? defaultReport;
	const now = opts.now ?? Date.now;
	const maxBatchesPerMinute = opts.maxBatchesPerMinute ?? MAX_BATCHES_PER_MINUTE;
	const top = opts.top ?? USAGE_TOP;
	let counts = new Map<string, number>();
	let users = new Map<string, string>();
	let batches = 0;
	let dropped = 0;
	let windowStart = now();
	const perMinute = new Map<string, { minute: number; n: number }>();

	const router = Router();
	router.post('/', (req: Request, res: Response) => {
		const parsed = opts.schema.safeParse(req.body);
		if (!parsed.success) return res.status(400).json({ error: 'not a usage batch' });
		const userId = opts.userIdOf(req);
		const minute = Math.floor(now() / 60_000);
		const seen = perMinute.get(userId);
		if (seen === undefined || seen.minute !== minute) {
			for (const [id, w] of perMinute) if (w.minute !== minute) perMinute.delete(id);
			perMinute.set(userId, { minute, n: 1 });
		} else if (++seen.n > maxBatchesPerMinute) {
			dropped += 1;
			return res.status(204).end();
		}
		batches += 1;
		users.set(userId, opts.tierOf(req));
		for (const e of parsed.data.entries) {
			const key = `${e.kind} ${e.screen}${e.target === undefined ? '' : ` ${e.target}`}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return res.status(204).end();
	});
	api.use(`/${opts.path}`, router);
	api.use(`/${opts.path}`, bodyErrors());

	const flush = (): void => {
		const start = windowStart;
		windowStart = now();
		if (batches === 0 && dropped === 0) return;
		const tiers: Record<string, number> = {};
		for (const tier of users.values()) tiers[tier] = (tiers[tier] ?? 0) + 1;
		const rows = [...counts].sort((a, b) => b[1] - a[1]);
		report('usage', {
			from: new Date(start).toISOString(),
			minutes: Math.round((windowStart - start) / 60_000),
			users: users.size,
			tiers,
			batches,
			dropped,
			views: rows.filter(([k]) => k.startsWith('view ')).reduce((n, [, c]) => n + c, 0),
			clicks: rows.filter(([k]) => k.startsWith('click ')).reduce((n, [, c]) => n + c, 0),
			top: Object.fromEntries(rows.slice(0, top)),
		});
		counts = new Map();
		users = new Map();
		batches = 0;
		dropped = 0;
	};
	const timer = setInterval(flush, opts.windowMs ?? USAGE_WINDOW_MS);
	timer.unref();
	return { flush, stop: () => clearInterval(timer) };
}
