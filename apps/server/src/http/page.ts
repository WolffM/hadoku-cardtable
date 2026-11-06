/**
 * The page: every client-routed path serves the same index.html.
 *
 * Scoped to GET/HEAD: a POST to a path that does not exist is a bug in the
 * caller, and answering it with an HTML page hides that. Mounted LAST, below
 * every route that owns a path, or it answers for them.
 *
 * Per caller, a page load is a costly act: each one boots the whole app, about
 * eight requests, each a line in this server's log and a row in the edge's. A
 * browser reloading in a loop (a proof script once did, 120 loads a minute for
 * eight hours) is refused with a 429 and `rate-limited` telemetry naming it,
 * while the busiest real caller (20 a minute) never meets the ceiling.
 */

import type { RateLimitConfig } from '@wolffm/rooms-server';
import type { Express, NextFunction, Request, Response } from 'express';

import { diagnosticPage, sendIndex, type BasePathVerdict } from '../base-path.js';
import { perCallerLimit } from './request.js';

export const PAGE_LOAD_RATE_LIMIT: RateLimitConfig = {
	capacity: 30,
	refillAmount: 1,
	refillIntervalMs: 2_000,
};

export interface PageDeps {
	indexHtml: string;
	basePath: BasePathVerdict;
	basePrefix: string;
	/** `null` is no limit (the e2e stacks); omitted is {@link PAGE_LOAD_RATE_LIMIT}. */
	rateLimit?: RateLimitConfig | null;
	now?: () => number;
}

export function attachPage(app: Express, deps: PageDeps): void {
	const limit = perCallerLimit(deps.rateLimit === undefined ? PAGE_LOAD_RATE_LIMIT : deps.rateLimit, 'too many page loads; wait a moment and reload', {
		act: 'page-load',
		now: deps.now,
	});
	app.get(/.*/, (req: Request, res: Response, next: NextFunction) => {
		if (!deps.basePath.ok) {
			res.status(503).type('html').send(diagnosticPage(deps.basePath, deps.basePrefix));
			return;
		}
		if (!limit(req, res)) return;
		sendIndex(res, deps.indexHtml, (err) => err && next(err));
	});
}
