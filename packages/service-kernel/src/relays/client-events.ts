/**
 * `POST /api/client-events`: client telemetry from a screen with no match (`@hadoku/shared`'s
 * `PageEventSchema`). A match's screen sends its telemetry over the match socket and it lands in the
 * play log (`play/socket.ts`, `forge:client`); a page outside a match has no such socket, so it sends
 * the same flat facts here, and they land in the same stdout log as `client` events, under
 * `svc: 'cardtable-client'`, keyed by page and user. Nothing is stored and nothing is answered but 204.
 *
 * Read them with `grep -a '"svc":"cardtable-client"' ~/.pm2/logs/cardtable-ppe-out.log` (PPE) or
 * `cardtable-out.log` (production).
 */
import type { Request, Response } from 'express';
import { Router } from 'express';

import { CLIENT_EVENT_MAX_PER_SECOND, PAGE_EVENT_PATH, PageEventSchema } from '@hadoku/shared';

import { userIdOf } from '../edge-auth.js';
import { jsonLogger, type JsonLog } from '../log.js';
import { bodyErrors } from './request.js';

/** How much of a client-chosen name (a kind, a `what`, a field's key) a `client-malformed` line keeps. */
const NAME_MAX = 32;

function shortName(value: unknown): string | undefined {
	return typeof value === 'string' ? value.slice(0, NAME_MAX) : undefined;
}

/**
 * What a `client-malformed` line says about telemetry the schema turned away: the event's `kind` and
 * `data.what`, when they are strings, and each failing field by its path. Never a value. "Invalid input"
 * alone could not say which report or which field (#20: a refused click's `said: null`, 12 drops in e2e).
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

export interface ClientEventsDeps {
	log?: JsonLog;
	now?: () => number;
}

export function attachClientEvents(api: Router, deps: ClientEventsDeps = {}): void {
	const log = deps.log ?? jsonLogger('cardtable-client');
	const now = deps.now ?? Date.now;
	/** Per user, the second being counted and how many arrived in it: the play socket's limit, per user. */
	const sent = new Map<string, { second: number; count: number }>();
	const events = Router();

	events.post('/', (req: Request, res: Response) => {
		const parsed = PageEventSchema.safeParse(req.body);
		const userId = userIdOf(req);
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
			if (window.count > CLIENT_EVENT_MAX_PER_SECOND) return res.status(204).end();
		}
		log({ evt: 'client', page: parsed.data.page, userId, kind: parsed.data.kind, ...parsed.data.data });
		return res.status(204).end();
	});

	api.use(`/${PAGE_EVENT_PATH}`, events);
	api.use(`/${PAGE_EVENT_PATH}`, bodyErrors((name) => log({ evt: 'client-error', name })));
}
