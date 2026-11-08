/**
 * `POST /api/usage`: the browser's usage batches (`apps/ui/src/usage.ts`), counted here and posted to
 * telemetry as one `usage` event per window — which screens were shown and which controls pressed,
 * how often, by how many people, by tier. Nothing per click is kept, and nothing is answered but 204.
 *
 * A caller sending more than `MAX_BATCHES_PER_MINUTE` is a client bug or a script; the rest of that
 * minute is dropped and counted as `dropped`, so the event says so.
 */
import type { Request, Response } from 'express';
import { Router } from 'express';

import { USAGE_PATH, UsageBatchSchema } from '@hadoku/shared';

import { tierOf, userIdOf } from '../edge-auth.js';
import { report as defaultReport, type Report } from '../telemetry.js';
import { bodyErrors } from './request.js';

export const USAGE_WINDOW_MS = 5 * 60_000;
export const MAX_BATCHES_PER_MINUTE = 10;
/** How many (kind, screen, target) rows one event lists, busiest first. */
export const USAGE_TOP = 60;

export interface UsageDeps {
	report?: Report;
	now?: () => number;
	windowMs?: number;
}

export interface UsageCounter {
	/** Post the window counted so far, if anything arrived, and start a new one. */
	flush(): void;
	stop(): void;
}

export function attachUsage(api: Router, deps: UsageDeps = {}): UsageCounter {
	const report = deps.report ?? defaultReport;
	const now = deps.now ?? Date.now;
	let counts = new Map<string, number>();
	let users = new Map<string, string>();
	let batches = 0;
	let dropped = 0;
	let windowStart = now();
	const perMinute = new Map<string, { minute: number; n: number }>();

	const router = Router();
	router.post('/', (req: Request, res: Response) => {
		const parsed = UsageBatchSchema.safeParse(req.body);
		if (!parsed.success) return res.status(400).json({ error: 'not a usage batch' });
		const userId = userIdOf(req);
		const minute = Math.floor(now() / 60_000);
		const seen = perMinute.get(userId);
		if (seen === undefined || seen.minute !== minute) {
			for (const [id, w] of perMinute) if (w.minute !== minute) perMinute.delete(id);
			perMinute.set(userId, { minute, n: 1 });
		} else if (++seen.n > MAX_BATCHES_PER_MINUTE) {
			dropped += 1;
			return res.status(204).end();
		}
		batches += 1;
		users.set(userId, tierOf(req));
		for (const e of parsed.data.entries) {
			const key = `${e.kind} ${e.screen}${e.target === undefined ? '' : ` ${e.target}`}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return res.status(204).end();
	});
	api.use(`/${USAGE_PATH}`, router);
	api.use(`/${USAGE_PATH}`, bodyErrors());

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
			top: Object.fromEntries(rows.slice(0, USAGE_TOP)),
		});
		counts = new Map();
		users = new Map();
		batches = 0;
		dropped = 0;
	};
	const timer = setInterval(flush, deps.windowMs ?? USAGE_WINDOW_MS);
	timer.unref();
	return { flush, stop: () => clearInterval(timer) };
}
