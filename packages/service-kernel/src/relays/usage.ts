/**
 * A browser relay for usage batches: which screens were shown and which controls pressed, posted
 * to telemetry once per window as
 *
 *   - one `usage` event for everyone: how often each (screen, control) was used, by how many
 *     people, by tier;
 *   - one `usage-user` event per person active in the window: who (userId, name, tier as the edge
 *     named it) and their own ordered trail, a line per view or press (`06:41:02 click room pick`),
 *     each placed at its receipt time less the page's own `sentAt - at`, so a wrong browser clock
 *     still orders and times it right. A trail longer than `trailMax` keeps its first lines and
 *     says how many it dropped.
 *
 * Entries are screen names and `data-testid`s with ids stripped, never anything a person typed.
 * Nothing is answered but 204. The schema, the mount path and the caller's tier/id/name are all
 * parameters — this module knows no game's usage shape.
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
/** The most lines one person's `usage-user` trail keeps per window. */
export const USAGE_TRAIL_MAX = 500;

export interface UsageEntry {
	kind: string;
	screen: string;
	target?: string;
	/** The page's clock when it happened; read only against the batch's `sentAt`. */
	at?: number;
}

export interface UsageSchema<T extends { entries: readonly UsageEntry[]; sentAt?: number }> {
	safeParse(body: unknown): { success: true; data: T } | { success: false };
}

export interface UsageOptions<T extends { entries: readonly UsageEntry[]; sentAt?: number }> {
	schema: UsageSchema<T>;
	/** The mount path under `api`, e.g. `/api/<path>`. */
	path: string;
	/** The tier as the edge named it — reported as is, so it must not be an app's own remapping. */
	tierOf: (req: Request) => string;
	userIdOf: (req: Request) => string;
	/** The caller's display name, when the edge gave one. */
	nameOf?: (req: Request) => string | null;
	report?: Report;
	now?: () => number;
	windowMs?: number;
	maxBatchesPerMinute?: number;
	top?: number;
	trailMax?: number;
}

export interface UsageCounter {
	/** Post the window counted so far, if anything arrived, and start a new one. */
	flush(): void;
	stop(): void;
}

export function attachUsage<T extends { entries: readonly UsageEntry[]; sentAt?: number }>(api: Router, opts: UsageOptions<T>): UsageCounter {
	const report = opts.report ?? defaultReport;
	const now = opts.now ?? Date.now;
	const maxBatchesPerMinute = opts.maxBatchesPerMinute ?? MAX_BATCHES_PER_MINUTE;
	const top = opts.top ?? USAGE_TOP;
	const trailMax = opts.trailMax ?? USAGE_TRAIL_MAX;
	let counts = new Map<string, number>();
	let users = new Map<string, Person>();
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
		const received = now();
		const person = users.get(userId) ?? { tier: '', name: null, views: 0, clicks: 0, trail: [], dropped: 0 };
		person.tier = opts.tierOf(req);
		person.name = opts.nameOf?.(req) ?? person.name;
		users.set(userId, person);
		const { entries, sentAt } = parsed.data;
		for (const e of entries) {
			const key = `${e.kind} ${e.screen}${e.target === undefined ? '' : ` ${e.target}`}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
			if (e.kind === 'view') person.views += 1;
			else if (e.kind === 'click') person.clicks += 1;
			if (person.trail.length >= trailMax) person.dropped += 1;
			else person.trail.push({ at: placed(received, sentAt, e.at), line: key });
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
		for (const { tier } of users.values()) tiers[tier] = (tiers[tier] ?? 0) + 1;
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
		for (const [userId, p] of users) {
			report('usage-user', {
				from: new Date(start).toISOString(),
				minutes: Math.round((windowStart - start) / 60_000),
				userId,
				name: p.name,
				tier: p.tier,
				views: p.views,
				clicks: p.clicks,
				trail: p.trail.sort((a, b) => a.at - b.at).map(({ at, line }) => `${clock(at)} ${line}`),
				...(p.dropped > 0 ? { trailDropped: p.dropped } : {}),
			});
		}
		counts = new Map();
		users = new Map();
		batches = 0;
		dropped = 0;
	};
	const timer = setInterval(flush, opts.windowMs ?? USAGE_WINDOW_MS);
	timer.unref();
	return { flush, stop: () => clearInterval(timer) };
}

interface Person {
	tier: string;
	name: string | null;
	views: number;
	clicks: number;
	trail: { at: number; line: string }[];
	dropped: number;
}

/**
 * When an entry happened on this server's clock: its receipt less how long before the batch left
 * the page it was made, by the page's own clock. Never after receipt; an entry from a tab that
 * predates `at`/`sentAt` is placed at receipt.
 */
export function placed(received: number, sentAt: number | undefined, at: number | undefined): number {
	if (sentAt === undefined || at === undefined) return received;
	return received - Math.max(0, sentAt - at);
}

/** `HH:MM:SS` in UTC; the event's `from` carries the date. */
function clock(ms: number): string {
	return new Date(ms).toISOString().slice(11, 19);
}
