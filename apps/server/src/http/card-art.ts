/*
 * GET /api/art/<scryfallId>[/back][?size=small|large] → 302 to the image: where every card image a
 * browser draws comes from. Our own copy on `cdn.hadoku.me` when the art mirror holds one
 * (`pools/art-keys.ts`; it copies the `normal` size), Scryfall's image otherwise — so the server
 * alone decides a card's image, and repointing one is a data edit here, never a browser rebuild.
 * The redirect is cached by the browser a day: a repoint reaches a returning player within one.
 *
 * GET /api/cards/art?n=<ref>&n=<ref>… → `{ art: { [ref]: { scryfallId, backs? } } }`
 *
 * The art of a card a browser knows only by its name and the set its list pins (`cardRef`:
 * `Name|SET`, or a bare name) — a library deck's line, a basic land, a list read back from its
 * `.dck` text — decided where every other card's is (`play/art-ids.ts`), so a deck's card here is
 * the same printing the board draws it as, and the
 * browser holds no table of its own to look a name up in. `backs` names the faces drawn as the
 * card's back image (`<id>#back`). A name with no art is left out. Member-gated like every `/api`
 * route; a lookup in memory, so it needs no per-caller limit beyond the cap on names.
 */
import type { Request, Response, Router } from 'express';
import { BACK_FACE, cdnUrlFor, parseCardRef, resolveArtUrl, type ArtImageSize } from '@hadoku/carddata/art';

import type { ArtKeys } from '../pools/art-keys.js';
import type { ArtIds } from '../play/art-ids.js';

/** The most cards one request answers: a 75 has fewer distinct ones. */
const MAX_NAMES = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIZES: readonly ArtImageSize[] = ['small', 'normal', 'large'];

/** Where `/api/art/<id>` sends a browser: our copy of the image, else Scryfall's; null for an id that is no card's. */
export function artLocation(scryfallId: string, size: ArtImageSize, keys: ArtKeys): string | null {
	const key = size === 'normal' ? keys.keyFor(scryfallId) : undefined;
	return key === undefined ? resolveArtUrl(scryfallId, {}, { size }) : cdnUrlFor(key);
}

export function attachCardArt(api: Router, deps: { art: ArtIds; keys: ArtKeys }): void {
	const image = (back: boolean) => (req: Request, res: Response) => {
		const id = String(req.params.id ?? '');
		const size = (typeof req.query.size === 'string' ? req.query.size : 'normal') as ArtImageSize;
		const location = UUID.test(id) && SIZES.includes(size) ? artLocation(back ? `${id}${BACK_FACE}` : id, size, deps.keys) : null;
		if (location === null) {
			res.status(404).end();
			return;
		}
		res.set('Cache-Control', 'private, max-age=86400').redirect(302, location);
	};
	api.get('/art/:id', image(false));
	api.get('/art/:id/back', image(true));

	api.get('/cards/art', (req: Request, res: Response) => {
		const names = [req.query.n].flat().filter((n): n is string => typeof n === 'string' && n.trim() !== '');
		if (names.length > MAX_NAMES) {
			res.status(400).json({ error: `at most ${MAX_NAMES} names` });
			return;
		}
		res.json({ art: namedArt(names, deps.art) });
	});
}

/** Each card ref's art, and the faces drawn as its back image; a ref with none is left out. */
export function namedArt(refs: Iterable<string>, art: ArtIds): Record<string, { scryfallId: string; backs?: string[] }> {
	const out: Record<string, { scryfallId: string; backs?: string[] }> = {};
	for (const ref of new Set(refs)) {
		const { name, set } = parseCardRef(ref);
		const found = art.card(name, set);
		if (found === undefined) continue;
		const backs = art.backs(name, set);
		out[ref] = { ...found, ...(backs.length === 0 ? {} : { backs }) };
	}
	return out;
}
