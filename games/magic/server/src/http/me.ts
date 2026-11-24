/**
 * `/api/me` — the caller's own document in the per-person store (`users/`), and nobody else's.
 *
 *   GET    /api/me/library              → 200 { favourites, decks, built, poolFavourites }
 *   PUT    /api/me/favourites/:deckId   { on } → 200 { favourites }
 *   PUT    /api/me/pool-favourites/:poolKey { on } → 200 { poolFavourites } | 400 | 409 (at the limit)
 *   PUT    /api/me/built/:builtId       { name, format, dck } → 200 { built } | 400 | 409 (at the limit)
 *   DELETE /api/me/built/:builtId       → 204 | 404
 *   GET    /api/me/art                  → 200 { oldest, picks }
 *   PUT    /api/me/art                  { oldest, picks } → 200 { oldest, picks }
 *
 * `favourites` is deck id → when it was starred; `decks` is deck id → `{ lastPlayedAt }`, which the
 * server stamps at match end (`stats/index.ts`); `built` is the caller's built decks, each with its
 * `built:<uuid>` id, newest change first. A `:builtId` is that id or its bare uuid. `poolFavourites`
is the cubes and sets they starred, pool key (`cube:<cubeId>`, `set:<code>`) → when; a key is not
checked against the lists, as a deck id is not, and the same cap bounds it.
 *
 * The caller is the edge's `X-User-Id`, the key the document is stored under: a request the edge
 * named nobody on is refused, since there is no document it could be. Every write is a costly act
 * (`perCallerLimit`), though a cheap one: one small file.
 */

import express, { type Request, type Response, type Router } from 'express';
import type { RateLimitConfig } from '@wolffm/rooms-server';
import { z } from 'zod';
import { accountIdOf } from '@hadoku/game-server/edge-auth';
import { bodyErrors, parseBody, perCallerLimit } from '@hadoku/game-server/http/request';
import { isStorableUserId } from '@hadoku/game-server/users/store';
import { jsonLogger } from '@hadoku/service-kernel/log';
import { POOL_KEY_PATTERN } from '@hadoku/shared';
import {
	ArtRulesSchema,
	BUILT_DCK_MAX_BYTES,
	BUILT_DECKS_MAX,
	BUILT_ID_PREFIX,
	BUILT_NAME_MAX,
	normalisePicks,
	type MagicUserDoc,
	type MagicUserStore,
} from '../users/index.js';

/** Writes a person may make: a burst of 60, then one every 2 s. Starring a row of decks is a burst. */
export const ME_WRITE_RATE_LIMIT: RateLimitConfig = { capacity: 60, refillAmount: 1, refillIntervalMs: 2_000 };
/** Favourites one person may keep: decks, and separately cubes and sets. */
export const FAVOURITES_MAX = 1000;
/** Hand-picked arts one person may keep. */
export const ART_PICKS_MAX = 5000;

const DECK_ID = /^[A-Za-z0-9:_-]{1,200}$/;
const BUILT_UUID = /^[A-Za-z0-9-]{1,64}$/;
const SCRYFALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const FavouriteBodySchema = z.strictObject({ on: z.boolean() });
const BuiltBodySchema = z.strictObject({
	name: z.string().trim().min(1).max(BUILT_NAME_MAX),
	format: z.string().min(1).max(64),
	dck: z.string().refine((s) => Buffer.byteLength(s, 'utf8') <= BUILT_DCK_MAX_BYTES, `a deck is at most ${BUILT_DCK_MAX_BYTES} bytes`),
});
const ArtBodySchema = z.strictObject({
	oldest: z.boolean(),
	picks: z
		.record(z.string().min(1).max(200), z.string().regex(SCRYFALL_ID, 'a pick is a Scryfall id'))
		.refine((p) => Object.keys(p).length <= ART_PICKS_MAX, `at most ${ART_PICKS_MAX} picks`),
});

export interface BuiltDeckView {
	id: string;
	name: string;
	format: string;
	dck: string;
	createdAt: number;
	updatedAt: number;
}

export function builtDecksOf(doc: MagicUserDoc): BuiltDeckView[] {
	return Object.entries(doc.built)
		.map(([id, b]) => ({ id, ...b }))
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** `built:<uuid>` from either spelling of the route's `:builtId`, or null. */
function builtIdOf(raw: string): string | null {
	const uuid = raw.startsWith(BUILT_ID_PREFIX) ? raw.slice(BUILT_ID_PREFIX.length) : raw;
	return BUILT_UUID.test(uuid) ? `${BUILT_ID_PREFIX}${uuid}` : null;
}

export interface MeDeps {
	users: MagicUserStore;
	/**
	 * A card's printings (`printingsOf(catalog, name)`), null for a card the catalog does not know.
	 * A pick is kept only when its id is one of its card's printings: the picks are drawn for both
	 * players, so an id for some other card (or one the catalog never heard of) is refused.
	 */
	printings: (name: string) => { printings: readonly { scryfallId: string }[] } | null;
	/** Overrides {@link ME_WRITE_RATE_LIMIT}; `null` is none (`perCallerLimit`). */
	rateLimit?: RateLimitConfig | null;
	log?: (entry: Record<string, unknown>) => void;
	now?: () => number;
}

export function attachMe(api: Router, deps: MeDeps): void {
	const log = deps.log ?? jsonLogger('cardtable-me');
	const now = deps.now ?? Date.now;
	const writeLimit = perCallerLimit(deps.rateLimit === undefined ? ME_WRITE_RATE_LIMIT : deps.rateLimit, 'too many changes; wait a moment and try again', { act: 'me-write', now });
	const me = express.Router();
	me.use(express.json({ limit: '64kb' }));

	/** The caller's userId, or the refusal already sent. */
	const callerOf = (req: Request, res: Response): string | null => {
		const userId = accountIdOf(req);
		if (userId === null || !isStorableUserId(userId)) {
			res.status(401).json({ error: 'sign in to keep a library' });
			return null;
		}
		return userId;
	};

	/** Run a handler, answering 500 (and logging) when the store fails. */
	const handle =
		(fn: (req: Request, res: Response) => Promise<void>) =>
		(req: Request, res: Response): void => {
			fn(req, res).catch((err: unknown) => {
				log({ evt: 'me-failed', path: req.path, error: (err as Error).message });
				if (!res.headersSent) res.status(500).json({ error: 'your library could not be read or saved' });
			});
		};

	me.get(
		'/library',
		handle(async (req, res) => {
			const userId = callerOf(req, res);
			if (userId === null) return;
			const doc = await deps.users.get(userId);
			res.json({ favourites: doc.favourites, decks: doc.decks, built: builtDecksOf(doc), poolFavourites: doc.poolFavourites });
		}),
	);

	/** A star: `PUT /<path>/:<param>` sets `field[<param>]` when first starred, `FAVOURITES_MAX` at most. */
	const starRoute = (path: string, param: string, field: 'favourites' | 'poolFavourites', key: RegExp, notOne: string): void => {
		me.put(
			`/${path}/:${param}`,
			handle(async (req, res) => {
				const userId = callerOf(req, res);
				if (userId === null) return;
				const id = String(req.params[param]);
				if (!key.test(id)) {
					res.status(400).json({ error: notOne });
					return;
				}
				const body = parseBody(FavouriteBodySchema, req, res);
				if (body === null || !writeLimit(req, res)) return;
				let full = false;
				const doc = await deps.users.update(userId, (d) => {
					const stars = d[field];
					if (!body.on) delete stars[id];
					else if (stars[id] !== undefined) return;
					else if (Object.keys(stars).length >= FAVOURITES_MAX) full = true;
					else stars[id] = now();
				});
				if (full) {
					res.status(409).json({ error: `at most ${FAVOURITES_MAX} favourites` });
					return;
				}
				res.json({ [field]: doc[field] });
			}),
		);
	};
	starRoute('favourites', 'deckId', 'favourites', DECK_ID, 'not a deck id');
	starRoute('pool-favourites', 'poolKey', 'poolFavourites', POOL_KEY_PATTERN, 'not a cube or set');

	me.put(
		'/built/:builtId',
		handle(async (req, res) => {
			const userId = callerOf(req, res);
			if (userId === null) return;
			const id = builtIdOf(String(req.params.builtId));
			if (id === null) {
				res.status(400).json({ error: 'not a built deck id' });
				return;
			}
			const body = parseBody(BuiltBodySchema, req, res);
			if (body === null || !writeLimit(req, res)) return;
			let full = false;
			const doc = await deps.users.update(userId, (d) => {
				const was = d.built[id];
				if (was === undefined && Object.keys(d.built).length >= BUILT_DECKS_MAX) {
					full = true;
					return;
				}
				const at = now();
				d.built[id] = { ...body, createdAt: was?.createdAt ?? at, updatedAt: at };
			});
			if (full) {
				res.status(409).json({ error: `at most ${BUILT_DECKS_MAX} built decks` });
				return;
			}
			log({ evt: 'built-deck-saved', builtId: id });
			res.json({ built: { id, ...doc.built[id] } });
		}),
	);

	me.delete(
		'/built/:builtId',
		handle(async (req, res) => {
			const userId = callerOf(req, res);
			if (userId === null) return;
			const id = builtIdOf(String(req.params.builtId));
			if (id === null) {
				res.status(404).json({ error: 'no such built deck' });
				return;
			}
			if (!writeLimit(req, res)) return;
			let found = false;
			await deps.users.update(userId, (d) => {
				found = d.built[id] !== undefined;
				// Its star and its last-played stamp go with it.
				delete d.built[id];
				delete d.favourites[id];
				delete d.decks[id];
			});
			if (!found) {
				res.status(404).json({ error: 'no such built deck' });
				return;
			}
			log({ evt: 'built-deck-deleted', builtId: id });
			res.status(204).end();
		}),
	);

	me.get(
		'/art',
		handle(async (req, res) => {
			const userId = callerOf(req, res);
			if (userId === null) return;
			res.json(ArtRulesSchema.parse((await deps.users.get(userId)).art));
		}),
	);

	me.put(
		'/art',
		handle(async (req, res) => {
			const userId = callerOf(req, res);
			if (userId === null) return;
			const body = parseBody(ArtBodySchema, req, res);
			if (body === null) return;
			const wrong = Object.entries(body.picks).find(([name, id]) => !(deps.printings(name)?.printings.some((p) => p.scryfallId === id) ?? false));
			if (wrong !== undefined) {
				res.status(400).json({ error: `${JSON.stringify(wrong[1])} is not a printing of ${JSON.stringify(wrong[0])}` });
				return;
			}
			if (!writeLimit(req, res)) return;
			const doc = await deps.users.update(userId, (d) => {
				d.art = { oldest: body.oldest, picks: normalisePicks(body.picks) };
			});
			res.json(doc.art);
		}),
	);

	api.use('/me', me);
	api.use('/me', bodyErrors());
}
