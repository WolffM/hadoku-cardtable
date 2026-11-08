/*
 * Which Scryfall id a card is: the one place that decides it, for every card a browser is sent —
 * a match's faces (`visibility.ts` stamps them), its art preload (`art.ts`), a library deck's lines.
 * Forge's wire names a card by `Name`, its Forge `SetCode` and an `ImageKey`, never an id, and a
 * browser holds no table to look one up in: it draws the id it is given.
 *
 * In order, for a face:
 *
 *   1. a token by the tokenscript its image key names (`t:c_3_3_a_phyrexian_wurm_deathtouch|2XM|…`):
 *      Wurmcoil Engine's two Wurms share one name and not one image;
 *   2. a face that is not its card's front (a transformed card's back, an adventure, a split half):
 *      that face of the card its front names, so a back is its own front's printing;
 *   3. the card by its name and set ({@link ArtIds.card});
 *   4. the card a `c:` image key names: an effect ("Teferi's Effect") draws its source's art;
 *   5. an emblem draws the card that made it.
 *
 * And a card by its name and set. A card this match's decks name is drawn as the deck's own line
 * names it — its set, and a drafted line's collector number — whatever set Forge reports for it, so
 * the board shows the printing the deck builder, the sideboard step and the deck peek showed. Then
 * the exact printing, the committed tables' `Name|SET` row (the bundled cube's
 * `pool.json`, then `art-ids.json`, which `scripts/art/build-art-ids.ts` writes: every basic under
 * every Forge set code, the constructed lists, the scenarios' cards, the token rows), the catalog's
 * printing in that set, the tables' bare-name row, then any printing the catalog knows.
 *
 * A face's art is a {@link CardArt}, not a bare id, so another field decided by the same lookup is
 * stamped beside the id in the same place.
 */
import { artIdIndex, artIdIndexFromTable, artIdKey, BACK_FACE, backFaceNames, mergeArtIdIndexes, tokenArtId, type ArtIdSource, type ArtIdTableFile } from '@hadoku/carddata/art';
import { toScryfallSetCode } from '@hadoku/carddata/set-codes';
import { parseDck } from '@hadoku/carddata/dck';
import type { DraftCard } from '@hadoku/shared';

import pool from '../../../ui/src/draft/pool.json' with { type: 'json' };
import table from './art-ids.json' with { type: 'json' };

/** What the resolver asks the card catalog (`../pools/catalog.ts`'s `CardCatalog`). */
export interface ArtCatalog {
	byName(name: string): DraftCard | null;
	byPrinting(set: string, collectorNumber: string): DraftCard | null;
	byNameInSet(name: string, set: string): DraftCard | null;
}

/** What a browser is told about a card's art. */
export interface CardArt {
	scryfallId: string;
}

/** A face as Forge's wire names it, and the name of its card's front face when that is another. */
export interface ArtFace {
	name: string;
	/** Forge's set code. */
	set: string;
	imageKey?: string | null;
	front?: string | null;
}

export interface ArtIds {
	face(face: ArtFace): CardArt | undefined;
	/** A card by its name and the Forge set a list names it by (none: any printing). */
	card(name: string, set?: string | null): CardArt | undefined;
	/** A card's id, then its back image's (`<id>#back`) when it has one. */
	images(name: string, set?: string | null): string[];
	/** The names of a card's faces drawn as its back image: a transformed card's other side. */
	backs(name: string, set?: string | null): string[];
}

/** The bundled cube's printings first (a cube card is the printing its cube was built from), then the committed table. */
const TABLE = mergeArtIdIndexes(artIdIndex((pool as { cards: ArtIdSource[] }).cards), artIdIndexFromTable(table as ArtIdTableFile));

const EMBLEM_NAME = /^Emblem\s*[—–-]\s*/;
const CARD_KEY = /^c:([^|]+)\|([A-Za-z0-9]+)/;

/** A printing a deck's line names: its set, and its collector number when the line has one. */
interface DeckPrinting {
	set: string;
	collector: string | null;
}

/** Each card name these `.dck` texts pin a set for → the printings their lines name, in file order. */
function deckPrintings(decks: readonly (string | null)[]): Map<string, DeckPrinting[]> {
	const out = new Map<string, DeckPrinting[]>();
	for (const deck of decks) {
		if (deck === null) continue;
		for (const entries of parseDck(deck).sections.values()) {
			for (const { card } of entries) {
				if (card.set === null) continue;
				const lines = out.get(card.name) ?? [];
				if (!lines.some((l) => sameSet(l.set, card.set!) && l.collector === card.collectorNumber)) lines.push({ set: card.set, collector: card.collectorNumber });
				out.set(card.name, lines);
			}
		}
	}
	return out;
}

/** One edition, whichever vocabulary names it: a drafted line writes Scryfall's code, Forge's wire its own. */
function sameSet(a: string, b: string): boolean {
	const scryfall = (code: string): string => (toScryfallSetCode(code) ?? code).trim().toUpperCase();
	return a.trim().toUpperCase() === b.trim().toUpperCase() || scryfall(a) === scryfall(b);
}

const art = (scryfallId: string | undefined): CardArt | undefined => (scryfallId === undefined ? undefined : { scryfallId });

/** The art resolver for a match whose seats play these `.dck` texts; `catalog` null answers from the table alone. */
export function createArtIds(catalog: ArtCatalog | null, decks: readonly (string | null)[] = []): ArtIds {
	const printings = deckPrintings(decks);

	/**
	 * The printing to draw `name` as, asked by `set`: the deck line naming it in that set, else the
	 * first line any deck names it by (Forge reports a set of its own for a printing it could not
	 * find), else `set` itself with no collector number.
	 */
	function printingOf(name: string, set: string | null | undefined): { set: string | null | undefined; collector: string | null } {
		const lines = printings.get(name);
		const line = lines?.find((l) => set != null && sameSet(l.set, set)) ?? lines?.[0];
		return line ?? { set, collector: null };
	}

	/** A collector number names a drafted printing, whose set is Scryfall's own code; a Forge code is mapped first. */
	function byPrinting(c: ArtCatalog, set: string, collector: string): DraftCard | null {
		const scryfallSet = toScryfallSetCode(set);
		return (scryfallSet === null ? null : c.byPrinting(scryfallSet, collector)) ?? c.byPrinting(set, collector);
	}

	/** The catalog's card for this name: the deck's printing, the set's own, else the one it chose. */
	function catalogCard(name: string, asked: string | null | undefined): DraftCard | null {
		if (catalog === null) return null;
		const { set, collector } = printingOf(name, asked);
		const scryfallSet = toScryfallSetCode(set);
		const printed = collector === null || set == null ? null : byPrinting(catalog, set, collector);
		return printed ?? (scryfallSet === null ? null : catalog.byNameInSet(name, scryfallSet)) ?? catalog.byName(name);
	}

	function cardId(name: string, asked: string | null | undefined): string | undefined {
		if (name.trim() === '') return undefined;
		const { set, collector } = printingOf(name, asked);
		const scryfallSet = toScryfallSetCode(set);
		return (
			(catalog === null || collector === null || set == null ? undefined : byPrinting(catalog, set, collector)?.scryfallId) ??
			(set == null || set === '' ? undefined : TABLE.get(artIdKey(name, set))) ??
			(catalog === null || scryfallSet === null ? undefined : catalog.byNameInSet(name, scryfallSet)?.scryfallId) ??
			TABLE.get(name) ??
			catalog?.byName(name)?.scryfallId
		);
	}

	/** Whether `name` is a face of the card `front` names with an image of its own (a back), or one printed on the front's (a split half, an adventure); undefined when neither says. */
	function backOf(name: string, front: string, set: string): boolean | undefined {
		const face = catalogCard(front, set)?.faces?.find((f) => f.name === name);
		if (face !== undefined) return face.scryfallId?.endsWith(BACK_FACE) === true;
		return (TABLE.get(artIdKey(name, set)) ?? TABLE.get(name))?.endsWith(BACK_FACE) === true ? true : undefined;
	}

	/** A face that is not its card's front: drawn from the front's own printing. */
	function otherFaceId(name: string, front: string, set: string): string | undefined {
		const back = backOf(name, front, set);
		const id = back === undefined ? undefined : cardId(front, set);
		return id === undefined ? undefined : back === true ? `${id}${BACK_FACE}` : id;
	}

	const ids: ArtIds = {
		card: (name, set) => art(cardId(name, set)),
		face({ name, set, imageKey, front }) {
			const token = tokenArtId(TABLE, imageKey);
			if (token !== undefined) return art(token);
			const other = front == null || front === name || front.trim() === '' ? undefined : otherFaceId(name, front, set);
			const keyed = CARD_KEY.exec(imageKey ?? '');
			const emblem = EMBLEM_NAME.test(name) ? name.replace(EMBLEM_NAME, '') : undefined;
			return art(
				other ??
					cardId(name, set) ??
					(keyed === null ? undefined : cardId(keyed[1]!, keyed[2]!)) ??
					(emblem === undefined ? undefined : cardId(emblem, set)),
			);
		},
		images(name, set) {
			const id = cardId(name, set);
			if (id === undefined) return [];
			return ids.backs(name, set).length > 0 && !id.endsWith(BACK_FACE) ? [id, `${id}${BACK_FACE}`] : [id];
		},
		backs(name, set) {
			const faces = catalogCard(name, set)?.faces?.filter((f) => f.scryfallId?.endsWith(BACK_FACE) === true).map((f) => f.name);
			return faces !== undefined && faces.length > 0 ? faces : backFaceNames(TABLE, cardId(name, set));
		},
	};
	return ids;
}
