/*
 * GET /api/art/<scryfallId>[/back][?size=small|large] → 302 to the image: where every card image a
 * browser draws comes from. Our own copy on `cdn.hadoku.me` when the art mirror holds one
 * (`pools/art-keys.ts`; it copies the `normal` size), Scryfall's image otherwise — so the server
 * alone decides a card's image, and repointing one is a data edit here, never a browser rebuild.
 * The redirect is cached by the browser a day: a repoint reaches a returning player within one.
 *
 * GET /api/art/<scryfallId>[/back]/artist → `{ artist: string }`, or 404 for an id nothing credits.
 * The ability chip and the deck chooser's tiles show art with no card frame around it, so Scryfall's
 * image guidelines ask that they carry the artist themselves — most of the time from the committed,
 * cube-and-library-pool table `useArtist` loads once and reads instantly (`draft/art-artists.json`,
 * built by `scripts/art/build-art-artists.ts`). That table is built to cover the bundled cube and the
 * committed `art-ids.json` rows; a CONSTRUCTED deck can name any card ever printed (e.g.
 * Dragonologist, then Betor, Kin to All — neither in any cube), and a table built to cover every
 * card a constructed deck might name would be most of Scryfall, which defeats the point of it being
 * a small, lazy, bundled chunk. So an id the committed table does not know falls back to this route,
 * which answers live from the same Scryfall corpus (`cards.jsonl`) the catalog's own daily refresh
 * already keeps current (`pools/refresh.ts`) and `build-art-artists.ts` reads offline — read once,
 * cached in memory, and re-read only when the file's own mtime moves. `AbilityChip.tsx` asks here
 * only once the committed table has answered "no" for an id, never before, and never for an id that
 * has none at all (an emblem, an effect, a token the art index gave no id to).
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
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Request, Response, Router } from 'express';
import { corpusDir } from '@hadoku/carddata/corpus-dir';
import { BACK_FACE, cdnUrlFor, parseCardRef, resolveArtUrl, type ArtImageSize } from '@hadoku/carddata/art';

import type { ArtKeys } from '../pools/art-keys.js';
import type { ArtIds } from '../play/art-ids.js';

/** The most cards one request answers: a 75 has fewer distinct ones. */
const MAX_NAMES = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIZES: readonly ArtImageSize[] = ['small', 'normal', 'large'];

/** One `cards.jsonl` line, narrowed to what an artist is decided from — the same shape `scripts/art/build-art-artists.ts` reads. */
interface CorpusPrinting {
	id?: unknown;
	artist?: unknown;
	card_faces?: readonly { artist?: unknown }[];
}

/** A face's artist: its own when the faces were drawn by different hands, else the card's — `scripts/art/build-art-artists.ts`'s `artistOf`, the only other reader of this field. */
function artistOfPrinting(printing: CorpusPrinting, back: boolean): string | null {
	const face = printing.card_faces?.[back ? 1 : 0]?.artist;
	const artist = typeof face === 'string' ? face : typeof printing.artist === 'string' ? printing.artist : undefined;
	return artist ?? null;
}

interface ArtistIndexState {
	readonly mtimeMs: number;
	readonly byId: ReadonlyMap<string, string>;
}

let artistIndexState: ArtistIndexState | null = null;
let artistIndexLoading: Promise<ArtistIndexState> | null = null;

/** Read `cards.jsonl` once into an id → artist map (front and `<id>#back` keys), reusing the cached one while the file's mtime has not moved. */
async function loadArtistIndex(cardsPath: string): Promise<ArtistIndexState> {
	const mtimeMs = (await stat(cardsPath)).mtimeMs;
	if (artistIndexState !== null && artistIndexState.mtimeMs === mtimeMs) return artistIndexState;
	const byId = new Map<string, string>();
	const lines = createInterface({ input: createReadStream(cardsPath, { encoding: 'utf8' }), crlfDelay: Infinity });
	for await (const line of lines) {
		if (line.length === 0) continue;
		let printing: CorpusPrinting;
		try {
			printing = JSON.parse(line) as CorpusPrinting;
		} catch {
			continue;
		}
		if (typeof printing.id !== 'string') continue;
		const front = artistOfPrinting(printing, false);
		if (front !== null) byId.set(printing.id, front);
		const back = artistOfPrinting(printing, true);
		if (back !== null) byId.set(`${printing.id}${BACK_FACE}`, back);
	}
	const state: ArtistIndexState = { mtimeMs, byId };
	artistIndexState = state;
	return state;
}

/** The artist of `id` (an art id: a Scryfall id, or one carrying {@link BACK_FACE}), from the live corpus; `undefined` for an id the corpus has no printing of. `corpus` is the directory holding `cards.jsonl` — a test's own fixture, never the host's (`corpusDir()` in production). */
async function liveArtist(id: string, corpus: string): Promise<string | undefined> {
	let state: ArtistIndexState;
	try {
		artistIndexLoading ??= loadArtistIndex(join(corpus, 'cards.jsonl')).finally(() => {
			artistIndexLoading = null;
		});
		state = await artistIndexLoading;
	} catch {
		artistIndexLoading = null;
		return undefined;
	}
	return state.byId.get(id);
}

/** Where `/api/art/<id>` sends a browser: our copy of the image, else Scryfall's; null for an id that is no card's. */
export function artLocation(scryfallId: string, size: ArtImageSize, keys: ArtKeys): string | null {
	const key = size === 'normal' ? keys.keyFor(scryfallId) : undefined;
	return key === undefined ? resolveArtUrl(scryfallId, {}, { size }) : cdnUrlFor(key);
}

export function attachCardArt(api: Router, deps: { art: ArtIds; keys: ArtKeys; corpusDir?: () => string }): void {
	const corpus = deps.corpusDir ?? corpusDir;
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

	const artist = (back: boolean) => (req: Request, res: Response) => {
		const id = String(req.params.id ?? '');
		if (!UUID.test(id)) {
			res.status(404).end();
			return;
		}
		void liveArtist(back ? `${id}${BACK_FACE}` : id, corpus())
			.then((found) => {
				if (found === undefined) {
					res.status(404).end();
					return;
				}
				res.set('Cache-Control', 'public, max-age=86400').json({ artist: found });
			})
			.catch(() => res.status(404).end());
	};
	api.get('/art/:id/artist', artist(false));
	api.get('/art/:id/back/artist', artist(true));

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
