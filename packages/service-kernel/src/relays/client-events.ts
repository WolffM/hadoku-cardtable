/**
 * A browser relay for page telemetry from a screen with no match: a flat `{ page, kind, data }`
 * event, posted here and logged as a `client` line keyed by page and user. Nothing is stored and
 * nothing is answered but 204. The schema, the mount path, the per-second cap and the caller's id
 * are all parameters — this module knows no game's event shape.
 */
import type { Request, Response } from 'express';
import { Router } from 'express';

import { bodyErrors } from '../limits/limits.ts';

/** How much of a client-chosen name (a kind, a `what`, a field's key) a `client-malformed` line keeps. */
const NAME_MAX = 32;

function shortName(value: unknown): string | undefined {
	return typeof value === 'string' ? value.slice(0, NAME_MAX) : undefined;
}

/**
 * What a `client-malformed` line says about telemetry the schema turned away: the event's `kind` and
 * `data.what`, when they are strings, and each failing field by its path. Never a value. "Invalid input"
 * alone could not say which report or which field.
 */
export function malformedFacts(raw: unknown, issues: readonly { path: readonly PropertyKey[]; message: string }[]): Record<string, unknown> {
	const event = typeof raw === 'object' && raw !== null ? (raw as { kind?: unknown; data?: unknown }) : {};
	const data = typeof event.data === 'object' && event.data !== null ? (event.data as { what?: unknown }) : {};
	return {
		kind: shortName(event.kind),
		what: shortName(data.what),
		errors: issues.slice(0, 3).map((i) => `${i.path.map((k) => String(k).slice(0, NAME_MAX)).join('.') || '(event)'}: ${i.message}`),
	};
}

export interface PageEventSchema<T> {
	safeParse(body: unknown):
		| { success: true; data: T }
		| { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
}

export interface ClientEventsOptions<T extends { page: unknown; kind: unknown; data: Record<string, unknown> }> {
	/** The event's schema. */
	schema: PageEventSchema<T>;
	/** The mount path under `api`, e.g. `/api/<path>`. */
	path: string;
	/** Per-user events-per-second cap; the rest of the second is dropped silently (204). */
	maxPerSecond: number;
	userIdOf: (req: Request) => string;
	log?: (entry: Record<string, unknown>) => void;
	now?: () => number;
}

export function attachClientEvents<T extends { page: unknown; kind: unknown; data: Record<string, unknown> }>(
	api: Router,
	opts: ClientEventsOptions<T>,
): void {
	const log = opts.log ?? (() => {});
	const now = opts.now ?? Date.now;
	/** Per user, the second being counted and how many arrived in it. */
	const sent = new Map<string, { second: number; count: number }>();
	const events = Router();

	events.post('/', (req: Request, res: Response) => {
		const parsed = opts.schema.safeParse(req.body);
		const userId = opts.userIdOf(req);
		if (!parsed.success) {
			log({ evt: 'client-malformed', userId, ...malformedFacts(req.body, parsed.error.issues) });
			return res.status(400).json({ error: 'not a page event' });
		}
		const second = Math.floor(now() / 1000);
		const window = sent.get(userId);
		if (window === undefined || window.second !== second) {
			for (const [id, w] of sent) if (w.second !== second) sent.delete(id);
			sent.set(userId, { second, count: 1 });
		} else {
			window.count += 1;
			if (window.count > opts.maxPerSecond) return res.status(204).end();
		}
		log({ evt: 'client', page: parsed.data.page, userId, kind: parsed.data.kind, ...parsed.data.data });
		return res.status(204).end();
	});

	api.use(`/${opts.path}`, events);
	api.use(`/${opts.path}`, bodyErrors((name) => log({ evt: 'client-error', name })));
}
