/*
 * The card catalog, asked by name (wave 125 §B, the contract in `docs/planning/wave125-2026-11-23.md`):
 *
 * GET /api/cards/search?q=<text>&sets=<CODE,CODE>&limit=<≤100> → `{ cards: DraftCard[] }`
 *
 *   The deck builder's search: every card whose name starts with `q`, then every card whose name
 *   contains it, each group by name (`pools/catalog.ts`'s `searchCatalog`). Alchemy is never in the
 *   catalog, and no plane, scheme, token or other card no deck holds is answered. `sets` (Scryfall
 *   codes, an era's list) narrows it to the cards printed in one of them, each as that set printed it.
 *
 * GET /api/cards/printings?name=<card name> → `{ name, printings: [{ scryfallId, set, collectorNumber, releasedAt, artist }] }`
 *
 *   A card's paper printings with art, oldest first (`printingsOf`): the art picker's choices, and
 *   `printings[0]` is what "always use oldest art" means. 404 for a name the catalog does not know.
 *
 * Both answer from memory, but a search walks every card name, and one is sent per keystroke: each
 * is limited per caller (`perCallerLimit`) like every costly act. Member-gated like every `/api` route.
 */
import type { Request, Response, Router } from 'express';
import type { RateLimitConfig } from '@wolffm/rooms-server';
import { perCallerLimit } from '@hadoku/game-server/http/request';
import { jsonLogger } from '@hadoku/service-kernel/log';

import { printingsOf, searchCatalog, SEARCH_MAX, type CardCatalog } from '../pools/catalog.js';

export interface CardsDeps {
	catalog: CardCatalog;
	/** Overrides {@link CARDS_RATE_LIMIT}; `null` is none (the e2e stacks). */
	rateLimit?: RateLimitConfig | null;
	log?: (entry: Record<string, unknown>) => void;
}

/** A burst of 60 asks, then four a second: someone typing a name, not a script walking the catalog. */
export const CARDS_RATE_LIMIT: RateLimitConfig = { capacity: 60, refillAmount: 4, refillIntervalMs: 1_000 };

/** The longest query or card name either route reads. */
const TEXT_MAX = 200;
/** The most sets one era names. */
const SETS_MAX = 300;
const SET_CODE = /^[A-Za-z0-9]{2,8}$/;

/** A single query-string value, or null for an absent or repeated one. */
function one(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

export function attachCards(api: Router, deps: CardsDeps): void {
	const log = deps.log ?? jsonLogger('cardtable-cards');
	const cfg = deps.rateLimit === undefined ? CARDS_RATE_LIMIT : deps.rateLimit;
	const searchLimit = perCallerLimit(cfg, 'too many card searches; wait a little and try again', {
		act: 'cards-search',
		onRefused: () => log({ evt: 'cards-search-limited' }),
	});
	const printingsLimit = perCallerLimit(cfg, 'too many printing lookups; wait a little and try again', {
		act: 'cards-printings',
		onRefused: () => log({ evt: 'cards-printings-limited' }),
	});

	api.get('/cards/search', (req: Request, res: Response) => {
		const q = one(req.query.q);
		if (q === null || q.trim() === '' || q.length > TEXT_MAX) {
			res.status(400).json({ error: `q is the text to search for, 1 to ${TEXT_MAX} characters` });
			return;
		}
		const limitRaw = req.query.limit;
		let limit: number | undefined;
		if (limitRaw !== undefined) {
			const text = one(limitRaw);
			limit = text === null || !/^\d+$/.test(text) ? NaN : Number(text);
			if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX) {
				res.status(400).json({ error: `limit is a whole number from 1 to ${SEARCH_MAX}` });
				return;
			}
		}
		let sets: string[] | undefined;
		if (req.query.sets !== undefined) {
			const text = one(req.query.sets);
			sets = text === null ? [] : text.split(',').map((s) => s.trim()).filter((s) => s !== '');
			if (text === null || sets.length > SETS_MAX || sets.some((s) => !SET_CODE.test(s))) {
				res.status(400).json({ error: `sets is a comma-separated list of at most ${SETS_MAX} set codes` });
				return;
			}
		}
		if (!searchLimit(req, res)) return;
		res.json({ cards: searchCatalog(deps.catalog, q, { ...(sets === undefined ? {} : { sets }), ...(limit === undefined ? {} : { limit }) }) });
	});

	api.get('/cards/printings', (req: Request, res: Response) => {
		const name = one(req.query.name);
		if (name === null || name.trim() === '' || name.length > TEXT_MAX) {
			res.status(400).json({ error: `name is a card name, 1 to ${TEXT_MAX} characters` });
			return;
		}
		if (!printingsLimit(req, res)) return;
		const found = printingsOf(deps.catalog, name);
		if (found === null) {
			res.status(404).json({ error: 'no card by that name' });
			return;
		}
		res.json(found);
	});
}
