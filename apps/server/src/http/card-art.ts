/*
 * GET /api/cards/art?n=<name>&n=<name>… → `{ art: { [name]: { scryfallId, backs? } } }`
 *
 * The art of a card a browser knows only by its name — a library deck's line, a basic land, a list
 * read back from its `.dck` text — decided where every other card's is (`play/art-ids.ts`), so the
 * browser holds no table of its own to look a name up in. `backs` names the faces drawn as the
 * card's back image (`<id>#back`). A name with no art is left out. Member-gated like every `/api`
 * route; a lookup in memory, so it needs no per-caller limit beyond the cap on names.
 */
import type { Request, Response, Router } from 'express';

import type { ArtIds } from '../play/art-ids.js';

/** The most names one request answers: a 75 has fewer distinct ones. */
const MAX_NAMES = 200;

export function attachCardArt(api: Router, deps: { art: ArtIds }): void {
	api.get('/cards/art', (req: Request, res: Response) => {
		const names = [req.query.n].flat().filter((n): n is string => typeof n === 'string' && n.trim() !== '');
		if (names.length > MAX_NAMES) {
			res.status(400).json({ error: `at most ${MAX_NAMES} names` });
			return;
		}
		res.json({ art: namedArt(names, deps.art) });
	});
}

/** Each name's art, and the faces drawn as its back image; a name with none is left out. */
export function namedArt(names: Iterable<string>, art: ArtIds): Record<string, { scryfallId: string; backs?: string[] }> {
	const out: Record<string, { scryfallId: string; backs?: string[] }> = {};
	for (const name of new Set(names)) {
		const found = art.card(name);
		if (found === undefined) continue;
		const backs = art.backs(name);
		out[name] = { ...found, ...(backs.length === 0 ? {} : { backs }) };
	}
	return out;
}
