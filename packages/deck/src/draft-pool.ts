/*
 * From a drafted pool to the `.dck` entries Forge opens and a deck is checked against.
 *
 * A draft ends with 45 `DraftCard`s. A `.dck` file wants `CardRequest`s. This
 * is the whole of the mapping between them, in one place, because it is the
 * seam where a wire type meets a file format and both of them belong to
 * somebody else.
 *
 * ## Why every field is spelled out rather than spread
 *
 * `DraftCard` and `CardRequest` share two field names and mean different things
 * by most of the rest — `DraftCard.collectorNumber` is always a string,
 * `CardRequest.collectorNumber` is `string | null` where null means "the line
 * named none". A spread would compile and would write `.dck` lines carrying an
 * `oracleText`-shaped nothing. So the mapping is explicit and the defaults are
 * justified:
 *
 *  - `set` ← `setCode`, which the envelope always carries
 *    (`packages/shared/src/draft.ts`), so a drafted card always names its
 *    printing and Forge never has to pick one.
 *  - `artIndex` ← `DEFAULT_ART_INDEX` (1). The envelope has no art index, and
 *    Forge's writer omits a `minimal` art index of 1 entirely, so this is the
 *    value that produces the shortest correct line rather than a guess.
 *  - `collectorNumber` ← the card's, when it has one. It pins the exact
 *    printing, which is the point of drafting from a curated cube.
 *  - `foil`, `backFace` ← false. Neither is on the envelope. A cube draft deals
 *    non-foil front faces, and inventing either would put a `+` or a `$alt` on
 *    a line that must round-trip.
 *  - `flags` ← null. Forge's `#{...}` segment carries editor state we have
 *    none of.
 *
 * The browser writes a drafted deck with these, and the server checks a deck
 * against its pool (`deckIssues`, by `cardKey`) with the same ones, so a legal
 * drafted deck can never read `more-copies-than-drafted`.
 *
 * ## Two copies of one card are two entries, not `2 Card`
 *
 * `poolEntries` emits one entry per `DraftCard`, and `newDeck` merges them by
 * `cardKey` — so two copies of the same printing become `2 Lightning Bolt` in
 * the file, while two different printings stay two lines. That is Forge's own
 * identity rule (`PaperCard.equals`, PaperCard.java:272) and it is `deck.ts`'s
 * job, not this module's. Doing the counting here as well would be a second
 * implementation of it that could disagree.
 */

import { DEFAULT_ART_INDEX, type CardRequest, type DeckEntry } from '@hadoku/carddata/dck';

/** The fields of a drafted card (`@hadoku/shared`'s `DraftCard`) the mapping reads. */
export interface DraftedPrinting {
  name: string;
  setCode: string;
  collectorNumber: string;
}

/** One drafted card as a `.dck` card reference. */
export function cardRequestOf(card: DraftedPrinting): CardRequest {
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

/** A drafted pool as deck entries, one per card, in pick order. */
export function poolEntries(pool: readonly DraftedPrinting[]): DeckEntry[] {
  return pool.map((card) => ({ count: 1, card: cardRequestOf(card) }));
}
