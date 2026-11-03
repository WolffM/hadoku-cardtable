/*
 * A library card known only by its name, as the wire sends it: its cost from the committed slice
 * the colours fold, its art from the play board's own table. What the room's deck chooser, the
 * Gauntlet's tiles, a table card, the deck editor's library pool (`deck/build.ts`) and the board's
 * own deck peek (`play/live/own-deck.tsx`) all draw. A module of its own so the board reads it
 * without the room screen, whose chunk carries the deck library's picker and the stats.
 */

import { artIdIndexFromTable, backFaceNames, scryfallIdFor, type ArtIdIndex, type ArtIdTableFile } from '@hadoku/carddata/art';
import type { DraftCard } from '@hadoku/shared';
import { manaTokensOf, manaValueOf } from '@hadoku/deck';
import { LIBRARY_CARD_COSTS } from '@hadoku/deck/library';

import artIdsData from '../draft/art-ids.json' with { type: 'json' };
import { namedFace, type PeekLine, type PeekList } from './DeckPeek.tsx';
import type { DeckLine } from './tables.ts';

/**
 * `Name|SET` and bare `Name` → Scryfall id, for every card the committed
 * constructed lists play.
 *
 * The same committed table the play board resolves art through
 * (`scripts/art/build-art-ids.ts` generates it; `apps/ui/src/play/adapter.ts`
 * loads it for the same reason), read here through `@hadoku/carddata/art` rather
 * than through that file, so this module does not depend on the play surface's
 * module layout. The table is a chunk of its own (`apps/ui/chunks.ts`), shared
 * with the board.
 *
 * **A lookup, not a URL** (D15): nothing here names a host. The id goes to
 * `cardImageUrl`, which is the only place in the UI that builds one, and
 * repointing a card stays a one-line edit in `art-manifest.json`.
 */
const LIBRARY_ART_IDS: ArtIdIndex = artIdIndexFromTable(artIdsData as ArtIdTableFile);

/** A library card's face by its name: no type line and no rules text, which the wire does not send. */
export function libraryFace(name: string): DraftCard {
  const printed = LIBRARY_CARD_COSTS[name] ?? '';
  const id = scryfallIdFor(LIBRARY_ART_IDS, name, '');
  return namedFace(name, manaTokensOf(printed), manaValueOf(printed), id, backFaceNames(LIBRARY_ART_IDS, id));
}

/** A deck line known by its name (`libraryFace`). */
export function namedPeekLine({ name, count }: DeckLine): PeekLine {
  const face = libraryFace(name);
  return { name, count, cost: face.manaCost, manaValue: face.manaValue, face };
}

/** A library deck's lines: the wire sends names. */
export function libraryPeekList(main: readonly DeckLine[], sideboard: readonly DeckLine[]): PeekList {
  return { main: main.map(namedPeekLine), sideboard: sideboard.map(namedPeekLine) };
}

/** A card's art id, by name, through the same table — what a table card's deck art is (`TableCard.tsx`). */
export function deckCardArtId(name: string): string | undefined {
  return scryfallIdFor(LIBRARY_ART_IDS, name, '');
}
