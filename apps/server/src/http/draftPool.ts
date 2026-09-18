/**
 * A drafted pool as the entries a deck is checked against.
 *
 * The browser writes a drafted deck with `apps/ui/src/draft/deckFromPool.ts`'s
 * `cardRequestOf`, and `deckIssues` compares a deck to its pool by
 * `cardKey` — name, set, collector number, art index, foil, face, flags. So this
 * mapping has to produce the SAME key for the same card, or every card of a
 * legal drafted deck reads `more-copies-than-drafted`. It is therefore a field
 * for field copy of `cardRequestOf`, and each default is the one that function
 * justifies in its own header.
 *
 * It is a copy rather than an import because `apps/server` cannot import
 * `apps/ui` (a browser app, with DOM types) and the mapping lives in neither
 * shared package. The copy is pinned by `tables.test.ts`, which writes a deck
 * from a pool with `@hadoku/deck`'s own writer and asserts it checks clean.
 * If the UI's mapping moves, the right fix is to move it into `@hadoku/deck`
 * and delete both copies.
 */

import { DEFAULT_ART_INDEX, type CardRequest, type DeckEntry } from '@hadoku/carddata/dck';
import type { DraftCard } from '@hadoku/shared';

/** One drafted card as a `.dck` card reference — `cardRequestOf`, verbatim. */
export function draftCardRequest(card: DraftCard): CardRequest {
	return {
		name: card.name,
		set: card.setCode === '' ? null : card.setCode,
		artIndex: DEFAULT_ART_INDEX,
		collectorNumber: card.collectorNumber === '' ? null : card.collectorNumber,
		foil: false,
		backFace: false,
		flags: null,
	};
}

/** A drafted pool as deck entries, one per card — `poolEntries`, verbatim. */
export function draftPoolEntries(pool: readonly DraftCard[]): DeckEntry[] {
	return pool.map((card) => ({ count: 1, card: draftCardRequest(card) }));
}
