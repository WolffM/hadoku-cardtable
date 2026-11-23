/**
 * The compact card catalog: one `DraftCard` per known card name, generated
 * offline by `games/magic/packages/carddata/src/cli/build-catalog.ts` from the Scryfall
 * sync (`cards.jsonl`) and indexed here at boot. It answers "what are this
 * card's gameplay fields" for any name a source hands it that did not come
 * with its own text — a Cube Cobra import (`cubecobra.ts` keeps only `name`
 * and `scryfall_id`, never oracle text) or a set-cube source (wave 74, names
 * only).
 *
 * Verdict-style, not a throw: a missing or malformed catalog file is a
 * reported fault and the server keeps serving (same discipline as
 * `room/pool.ts`'s `loadPool`); every `byName` lookup then answers `null`,
 * which is the honest "no text for this name" and is exactly what the
 * playability verdict's `missingText` is built from.
 *
 * `byName` tries only the two keys `@hadoku/carddata`'s own `resolve.ts`
 * tries for a bare-name reference (`normaliseName`, then `foldName`) — see
 * `build-catalog.ts`'s header for why the fold is not re-derived here. The
 * catalog file's `aliases` map already resolved every weaker spelling (a
 * front face, an accent-folded name) to its canonical key at build time.
 *
 * ## `byPrinting` and `swap` (wave 74 §G)
 *
 * `byPrinting(set, collectorNumber)` is why a realistic booster's own-set
 * card draws the SET'S OWN art rather than whatever printing `build-catalog`
 * happened to choose as the one text entry under `cards` — the whole point
 * of the method, per wave 74 §E. The catalog file's `printings` section
 * (`build-catalog.ts`'s header has the derivation) carries EVERY printing
 * `cards.jsonl` had a set + collector number for, each pointing at its
 * card's canonical key plus its OWN `scryfallId` — so the answer here is the
 * canonical card's text with the REQUESTED printing's own `setCode`,
 * `collectorNumber` and `scryfallId` laid over it, never the chosen
 * printing's. `cards`/`aliases` carry one entry per name either way; only
 * `printings` grew to cover every printing, which is why this miss rate
 * went from "nearly every real card" to "only a name the catalog could not
 * resolve at all" (still callers fall back to `byName` on a miss there).
 *
 * `swap(path?)` reloads the file at `path` (or the path this catalog was
 * built from, if omitted) and, only on a successful parse, replaces the
 * live lookup data in place — every holder of this `CardCatalog` object
 * (readers hold the object, never its internal map) sees the swap with no
 * reload of their own and no restart. A fault (missing file, malformed
 * JSON) is logged and the OLD data keeps serving, same discipline as the
 * initial load.
 *
 * ## `printingsOf` and `search` (wave 125 §B)
 *
 * `printingsOf(name)` is a card's paper printings with art, oldest first, each
 * with its own id, set, collector number, release date and artist: the art
 * picker's choices, and `printings[0]` is what "always use oldest art" means.
 * A printing is left out when it never was a paper card (`paper: false`), is
 * in an Alchemy set, or has no Scryfall id (no image to draw). The date and
 * the artist come from refs `build-catalog` writes since wave 125; a file
 * built before then still answers, its printings undated (`releasedAt: null`,
 * listed after every dated one, by set and number).
 *
 * `search(q, { sets, limit })` is the deck builder's card search: every card
 * whose name starts with `q`, then every card whose name contains it, each
 * group by name. Cards that are not deck cards (planes, schemes, vanguards,
 * dungeons, stickers, conspiracies, tokens, heroes, emblems) are never
 * answered. `sets` narrows it to cards printed in one of those sets (an era),
 * each answered as the first listed set printed it.
 *
 * Both are functions of a loaded catalog (`printingsOf(catalog, name)`), not
 * methods on `CardCatalog`: the many stand-in catalogs tests build stay the
 * shape they are, and a stand-in simply has no printings and finds nothing.
 */

import { readFileSync } from 'node:fs';
import { foldName, isAlchemySet, normaliseName } from '@hadoku/carddata';
import { DraftCardSchema, RaritySchema, type DraftCard, type Rarity } from '@hadoku/shared';
import { jsonLogger } from '@hadoku/service-kernel/log';

export interface CardCatalog {
	byName(name: string): DraftCard | null;
	/** The canonical card's text with THIS printing's own setCode/collectorNumber/scryfallId. Misses only on a name the catalog never resolved at all; callers fall back to `byName`. */
	byPrinting(set: string, collectorNumber: string): DraftCard | null;
	/** The card named `name` as `set` printed it — its art and rarity there — or `null` when the set has no printing of it; callers fall back to `byName`. */
	byNameInSet(name: string, set: string): DraftCard | null;
	/**
	 * Whether `name` is an Alchemy card (the operator, 2026-11-01: none in Cardtable). Every card
	 * `build-catalog` left out as one, any card this file printed only in an Alchemy set, and an
	 * "A-" name the catalog does not know as a paper card (a rebalanced card: `A-Town` is paper).
	 * A Forge set list or an imported cube that names one leaves it out.
	 */
	isAlchemy(name: string): boolean;
	/**
	 * Reload from `path` (default: the path this catalog was built from) and,
	 * on success, swap the live data in place. Returns `true` on a swap,
	 * `false` on a fault (the old data keeps serving).
	 */
	swap(path?: string): boolean;
}

/** One printing a card can be drawn as (`printingsOf`). */
export interface CardPrinting {
	scryfallId: string;
	/** Scryfall's set code, upper case. */
	set: string;
	collectorNumber: string;
	/** `YYYY-MM-DD`; null in a catalog built before printings carried it. */
	releasedAt: string | null;
	/** Null in a catalog built before printings carried it. */
	artist: string | null;
}

export interface CardPrintings {
	/** The card's own name, as the catalog spells it. */
	name: string;
	/** Shared between callers: never changed in place. */
	printings: readonly Readonly<CardPrinting>[];
}

interface PrintingRefFile {
	key?: unknown;
	scryfallId?: unknown;
	rarity?: unknown;
	releasedAt?: unknown;
	artist?: unknown;
	paper?: unknown;
}

interface PrintingRef {
	key: string;
	scryfallId: string | undefined;
	/** Absent on a ref from a file built before refs carried it: the canonical card's own rarity stands. */
	rarity: Rarity | undefined;
	releasedAt: string | undefined;
	artist: string | undefined;
	/** False only for a printing the file marks as never a paper card. */
	paper: boolean;
}

interface CatalogFile {
	/** Canonical name key -> the full card, re-validated against `DraftCardSchema` on load. */
	cards: Record<string, unknown>;
	/** Any other key (front-face, folded, folded-front-face) -> the canonical key above. */
	aliases: Record<string, unknown>;
	/** `<SET>:<collector_number>` -> this printing's own ref (`build-catalog.ts`'s `PrintingRef`). Absent on an older file — see `parseCatalogState`. */
	printings?: Record<string, unknown>;
	/** Normalised names `build-catalog` left out as Alchemy. Absent on an older file. */
	alchemy?: unknown;
}

interface CatalogState {
	cards: Map<string, DraftCard>;
	aliases: Map<string, string>;
	/** `<SET>:<collector_number>` -> its ref; resolved against `cards` lazily in `byPrinting`, never duplicated into a second `DraftCard` map. */
	printings: Map<string, PrintingRef>;
	/** `<SET>|<canonical key>` -> that card's printing in that set, its lowest collector number (the set's own frame, not a showcase variant). */
	inSet: Map<string, string>;
	/** Normalised names of Alchemy cards: the file's own `alchemy` list, and any card it printed only in an Alchemy set. */
	alchemy: Set<string>;
	/** Canonical key -> every printing key of that card, in file order. */
	printingsByKey: Map<string, string[]>;
	/** Every deck card, by name: what `search` scans. */
	searchable: { key: string; name: string; norm: string }[];
	/** `printingsOf`'s answers so far, by canonical key: a basic land has hundreds of printings to sort, and a match start asks for every card of two decks. */
	sortedPrintings: Map<string, readonly CardPrinting[]>;
}

const log = jsonLogger('cardtable-pools');

const EMPTY_STATE: CatalogState = { cards: new Map(), aliases: new Map(), printings: new Map(), inSet: new Map(), alchemy: new Set(), printingsByKey: new Map(), searchable: [], sortedPrintings: new Map() };

/** A type line's first word that says the card is no deck's card: a plane, a scheme, a vanguard, a sticker sheet, a token. */
const NOT_A_DECK_CARD = /^(plane|phenomenon|scheme|ongoing|vanguard|dungeon|stickers|conspiracy|token|hero|card|emblem)\b/i;

/** Most cards `search` answers at once, and its default. */
export const SEARCH_MAX = 100;
const SEARCH_DEFAULT = 40;

/** Uppercase the set so a caller's case never misses; the file's own keys are already uppercase (`build-catalog.ts` upper-cases `setCode`). */
function printingKey(setCode: string, collectorNumber: string): string {
	return `${setCode.toUpperCase()}:${collectorNumber}`;
}

/** Parse one catalog file into lookup state, or `null` on a reported fault (never throws). */
function parseCatalogState(path: string): CatalogState | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch (err) {
		log({ evt: 'catalog-load-failed', path, detail: (err as Error).message });
		return null;
	}

	if (typeof raw !== 'object' || raw === null) {
		log({ evt: 'catalog-load-failed', path, detail: 'not an object' });
		return null;
	}
	const file = raw as Partial<CatalogFile>;

	// No Alchemy (`@hadoku/carddata`'s `alchemy.ts`). A current build already left it out; a file
	// that still carries some (an older build, a hand-written fixture) serves none of it.
	const alchemy = new Set<string>();
	if (Array.isArray(file.alchemy)) {
		for (const name of file.alchemy) if (typeof name === 'string') alchemy.add(normaliseName(name));
	}
	const cards = new Map<string, DraftCard>();
	let rejected = 0;
	if (typeof file.cards === 'object' && file.cards !== null) {
		for (const [key, value] of Object.entries(file.cards)) {
			const parsed = DraftCardSchema.safeParse(value);
			if (!parsed.success) rejected++;
			else if (isAlchemySet({ code: parsed.data.setCode })) alchemy.add(key);
			else cards.set(key, parsed.data);
		}
	}

	const aliases = new Map<string, string>();
	if (typeof file.aliases === 'object' && file.aliases !== null) {
		for (const [key, value] of Object.entries(file.aliases)) {
			if (typeof value === 'string') aliases.set(key, value);
		}
	}

	// Absent on a catalog file built before this field existed (an older
	// deploy's cache, a hand-written test fixture that predates it) — a
	// catalog with no printings index is not a reported fault, every
	// `byPrinting` call on it just answers null and the caller falls back
	// to `byName`, same as a name the join never resolved.
	const printings = new Map<string, PrintingRef>();
	let printingsRejected = 0;
	if (typeof file.printings === 'object' && file.printings !== null) {
		for (const [printingKeyStr, value] of Object.entries(file.printings)) {
			const ref = value as PrintingRefFile;
			if (typeof ref.key !== 'string') {
				printingsRejected++;
				continue;
			}
			if (isAlchemySet({ code: printingKeyStr.slice(0, printingKeyStr.indexOf(':')) })) continue;
			const rarity = RaritySchema.safeParse(ref.rarity);
			printings.set(printingKeyStr, {
				key: ref.key,
				scryfallId: typeof ref.scryfallId === 'string' ? ref.scryfallId : undefined,
				rarity: rarity.success ? rarity.data : undefined,
				releasedAt: typeof ref.releasedAt === 'string' ? ref.releasedAt : undefined,
				artist: typeof ref.artist === 'string' ? ref.artist : undefined,
				paper: ref.paper !== false,
			});
		}
	}

	const inSet = new Map<string, string>();
	const number = (key: string): number => Number.parseInt(key.slice(key.indexOf(':') + 1), 10);
	for (const [key, ref] of printings) {
		const at = `${key.slice(0, key.indexOf(':'))}|${ref.key}`;
		const held = inSet.get(at);
		if (held === undefined || number(key) < number(held) || (Number.isNaN(number(held)) && !Number.isNaN(number(key)))) inSet.set(at, key);
	}

	const printingsByKey = new Map<string, string[]>();
	for (const [key, ref] of printings) {
		const list = printingsByKey.get(ref.key);
		if (list === undefined) printingsByKey.set(ref.key, [key]);
		else list.push(key);
	}

	const searchable: CatalogState['searchable'] = [];
	for (const [key, card] of cards) {
		if (NOT_A_DECK_CARD.test(card.typeLine.trim())) continue;
		searchable.push({ key, name: card.name, norm: normaliseName(card.name) });
	}
	searchable.sort((a, b) => a.name.localeCompare(b.name));

	log({ evt: 'catalog-loaded', path, cards: cards.size, aliases: aliases.size, printings: printings.size, alchemy: alchemy.size, rejected, printingsRejected });

	return { cards, aliases, printings, inSet, alchemy, printingsByKey, searchable, sortedPrintings: new Map() };
}

/** Oldest first; an undated printing after every dated one; then by set, then by collector number as a number. */
function oldestFirst(a: CardPrinting, b: CardPrinting): number {
	if (a.releasedAt !== b.releasedAt) {
		if (a.releasedAt === null) return 1;
		if (b.releasedAt === null) return -1;
		return a.releasedAt < b.releasedAt ? -1 : 1;
	}
	if (a.set !== b.set) return a.set < b.set ? -1 : 1;
	return a.collectorNumber.localeCompare(b.collectorNumber, 'en', { numeric: true });
}

/**
 * Load the catalog `build-catalog` writes. Synchronous, because this runs
 * once at boot and an async boot would only move the same failure somewhere
 * less visible (same reasoning as `loadPool`'s header).
 *
 * `DraftCardSchema` re-parses every entry even though the file was produced by
 * our own pipeline — the D13 control at the last point before a card can reach
 * a payload: the schema has no image field, so anything that should not be
 * there is dropped here rather than discovered by a UI re-validating what the
 * server sent it.
 */
export function loadCardCatalog(path: string): CardCatalog {
	let state = parseCatalogState(path) ?? EMPTY_STATE;

	/** The key `cards` holds `name` under, through its aliases. */
	const keyOf = (name: string): string | null => {
		for (const key of [normaliseName(name), foldName(name)]) {
			if (state.cards.has(key)) return key;
			const canonical = state.aliases.get(key);
			if (canonical !== undefined && state.cards.has(canonical)) return canonical;
		}
		return null;
	};

	const catalog: CardCatalog = {
		byName(name: string): DraftCard | null {
			const key = keyOf(name);
			return key === null ? null : (state.cards.get(key) ?? null);
		},

		byNameInSet(name: string, set: string): DraftCard | null {
			const key = keyOf(name);
			const printing = key === null ? undefined : state.inSet.get(`${set.toUpperCase()}|${key}`);
			if (printing === undefined) return null;
			const at = printing.indexOf(':');
			return catalog.byPrinting(printing.slice(0, at), printing.slice(at + 1));
		},

		isAlchemy(name: string): boolean {
			if (state.alchemy.has(normaliseName(name)) || state.alchemy.has(foldName(name))) return true;
			return name.trim().startsWith('A-') && keyOf(name) === null;
		},

		byPrinting(set: string, collectorNumber: string): DraftCard | null {
			const ref = state.printings.get(printingKey(set, collectorNumber));
			if (ref === undefined) return null;
			const canonical = state.cards.get(ref.key);
			if (canonical === undefined) return null;
			const printed = { setCode: set.toUpperCase(), collectorNumber, rarity: ref.rarity ?? canonical.rarity };
			const scryfallId = ref.scryfallId ?? canonical.scryfallId;
			// A face draws the card's own image or its back (`<id>#back`): the same image of THIS printing.
			const chosen = canonical.scryfallId;
			const faceArt = (id: string): string =>
				chosen !== undefined && scryfallId !== undefined && id.startsWith(chosen) ? scryfallId + id.slice(chosen.length) : id;
			const faces = canonical.faces?.map((face) => ({ ...face, ...printed, ...(face.scryfallId === undefined ? {} : { scryfallId: faceArt(face.scryfallId) }) }));
			return { ...canonical, ...printed, scryfallId, ...(faces === undefined ? {} : { faces }) };
		},

		swap(nextPath: string = path): boolean {
			const next = parseCatalogState(nextPath);
			if (next === null) {
				log({ evt: 'catalog-swap-faulted', path: nextPath });
				return false;
			}
			state = next;
			log({ evt: 'catalog-swapped', path: nextPath, cards: next.cards.size, aliases: next.aliases.size, printings: next.printings.size });
			return true;
		},
	};
	QUERIES.set(catalog, {
		printingsOf(name: string): CardPrintings | null {
			const key = keyOf(name);
			const card = key === null ? undefined : state.cards.get(key);
			if (key === null || card === undefined) return null;
			const known = state.sortedPrintings.get(key);
			if (known !== undefined) return { name: card.name, printings: known };
			const out: CardPrinting[] = [];
			for (const at of state.printingsByKey.get(key) ?? []) {
				const ref = state.printings.get(at)!;
				if (!ref.paper || ref.scryfallId === undefined) continue;
				const colon = at.indexOf(':');
				out.push({ scryfallId: ref.scryfallId, set: at.slice(0, colon), collectorNumber: at.slice(colon + 1), releasedAt: ref.releasedAt ?? null, artist: ref.artist ?? null });
			}
			out.sort(oldestFirst);
			state.sortedPrintings.set(key, out);
			return { name: card.name, printings: out };
		},

		search(query: string, options: CardSearch): DraftCard[] {
			const q = normaliseName(query);
			if (q === '') return [];
			const limit = Math.max(1, Math.min(SEARCH_MAX, Math.floor(options.limit ?? SEARCH_DEFAULT)));
			const sets = options.sets?.map((s) => s.trim().toUpperCase()).filter((s) => s !== '') ?? [];
			/** The card as the era prints it: the first listed set with a printing of it, else null (not in the era). */
			const inEra = (key: string, name: string): DraftCard | null => {
				for (const set of sets) {
					if (state.inSet.has(`${set}|${key}`)) return catalog.byNameInSet(name, set);
				}
				return null;
			};
			const prefix: DraftCard[] = [];
			const inside: DraftCard[] = [];
			for (const entry of state.searchable) {
				if (prefix.length >= limit) break;
				const at = entry.norm.indexOf(q);
				if (at < 0) continue;
				const group = at === 0 ? prefix : inside;
				if (group === inside && prefix.length + inside.length >= limit) continue;
				const card = sets.length === 0 ? (state.cards.get(entry.key) ?? null) : inEra(entry.key, entry.name);
				if (card !== null) group.push(card);
			}
			return [...prefix, ...inside].slice(0, limit);
		},
	});
	return catalog;
}

/** What a loaded catalog answers beyond `CardCatalog`, by the catalog object `loadCardCatalog` returned. */
interface CatalogQueries {
	printingsOf(name: string): CardPrintings | null;
	search(query: string, options: CardSearch): DraftCard[];
}

/** Any catalog-shaped object: a stand-in that `loadCardCatalog` never made answers nothing. */
export type CatalogLike = Pick<CardCatalog, 'byName'>;

const QUERIES = new WeakMap<CatalogLike, CatalogQueries>();

export interface CardSearch {
	/** Only cards printed in one of these sets (Scryfall codes): an era. Absent or empty: every card. */
	sets?: readonly string[];
	/** At most this many, capped at {@link SEARCH_MAX}. */
	limit?: number;
}

/** `name`'s paper printings with art, oldest first (see the header). `null` for a name the catalog does not know. */
export function printingsOf(catalog: CatalogLike, name: string): CardPrintings | null {
	return QUERIES.get(catalog)?.printingsOf(name) ?? null;
}

/** The deck builder's search: by name prefix, then substring; `sets` narrows it to an era (see the header). */
export function searchCatalog(catalog: CatalogLike, query: string, options: CardSearch = {}): DraftCard[] {
	return QUERIES.get(catalog)?.search(query, options) ?? [];
}
