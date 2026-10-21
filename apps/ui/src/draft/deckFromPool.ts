/*
 * From a drafted pool to something Forge can open.
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
 * ## Two copies of one card are two entries, not `2 Card`
 *
 * `poolEntries` emits one entry per `DraftCard`, and `newDeck` merges them by
 * `cardKey` — so two copies of the same printing become `2 Lightning Bolt` in
 * the file, while two different printings stay two lines. That is Forge's own
 * identity rule (`PaperCard.equals`, PaperCard.java:272) and it is @hadoku/deck's
 * job, not this module's. Doing the counting here as well would be a second
 * implementation of it that could disagree.
 */

// The `/dck` subpath, not the barrel. `@hadoku/carddata`'s `.` export
// re-exports the node-only Scryfall ingest, and pulling that into a program
// whose `lib` includes DOM makes `ReadableStream` the browser's — which is a
// TS2345 at `scryfall/bulk.ts:200` and, in a bundle, `node:fs` in the browser.
// `dck.ts` has no node builtins, so the browser reaches exactly the parser it
// needs. Same pattern as `cardImage.ts`'s `@hadoku/carddata/art`.
import { DEFAULT_ART_INDEX, parseDck, type CardRequest, type DeckEntry } from '@hadoku/carddata/dck';
import { cardKey, deckFromDeckFile, isBasicLand, mergeEntries, newDeck, toDeckFile, writeDck, type Deck } from '@hadoku/deck';

import type { DraftCard } from './types.ts';

/** One drafted card as a `.dck` card reference. */
export function cardRequestOf(card: DraftCard): CardRequest {
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
export function poolEntries(pool: readonly DraftCard[]): DeckEntry[] {
  return pool.map((card) => ({ count: 1, card: cardRequestOf(card) }));
}

/**
 * The deck name a draft gets when nobody has typed one.
 *
 * The draft id, because it is the only thing on the envelope that identifies
 * this draft, and a file called `Draft.dck` is a file you cannot find again.
 */
export function defaultDeckName(draftId: string): string {
  return `Cube draft ${draftId}`;
}

/**
 * Open the deck builder on a finished pool: everything sideboarded, nothing
 * played.
 *
 * That is `newDeck`'s contract and Forge's limited editor's behaviour both —
 * see `packages/deck/src/deck.ts`. The structural consequence is the one worth
 * knowing: because every card starts in the sideboard and the only operations
 * move cards between the two piles, a card that was never drafted has no way
 * into the maindeck. "You may only play what you drafted" needs no validator.
 */
export function deckFromPool(draftId: string, pool: readonly DraftCard[], name?: string): Deck {
  return newDeck(name ?? defaultDeckName(draftId), poolEntries(pool));
}

/**
 * A drafter's build: which picks are the deck and which the sideboard — ONE
 * piece of state from the first pick to the last game, saved as the pod's
 * deck (`PUT /api/drafts/:podId/deck`) by the draft's picks and the deck
 * builder alike.
 *
 * Picks are the deck in progress (the operator, 2026-10-21, Arena-style:
 * *"while drafting, picks are the deck in progress; the drafter drags the ones
 * they won't play into a sideboard area; the deck builder opens with picks =
 * main deck and the dragged ones in the sideboard"*). So the saved deck says
 * where the cards it names are, and every pick it does not account for — one
 * made since it was saved, or every pick when nothing was — is in the main
 * deck. A card the pool does not hold leaves the build (basics excepted: they
 * are never drafted), and no card is ever counted twice.
 */
export function draftBuild(draftId: string, pool: readonly DraftCard[], saved: Deck | null): Deck {
  const left = new Map<string, { card: CardRequest; n: number }>();
  for (const card of pool) {
    const request = cardRequestOf(card);
    const key = cardKey(request);
    const had = left.get(key);
    if (had) had.n += 1;
    else left.set(key, { card: request, n: 1 });
  }
  const take = (entries: readonly DeckEntry[]): DeckEntry[] =>
    entries.flatMap((entry) => {
      if (isBasicLand(entry.card) && !left.has(cardKey(entry.card))) return [entry];
      const have = left.get(cardKey(entry.card));
      const count = Math.min(entry.count, have?.n ?? 0);
      if (have === undefined || count === 0) return [];
      have.n -= count;
      return [{ count, card: entry.card }];
    });
  const sideboard = take(saved?.sideboard ?? []);
  const main = take(saved?.main ?? []);
  for (const { card, n } of left.values()) if (n > 0) main.push({ count: n, card });
  return { name: saved?.name ?? defaultDeckName(draftId), main: mergeEntries(main), sideboard: mergeEntries(sideboard), basics: saved?.basics ?? [] };
}

/** The picks as the build splits them, in pick order: of N copies with S sideboarded, the first S picked are the sideboard's. */
export function splitPicks(pool: readonly DraftCard[], build: Deck): { main: DraftCard[]; side: DraftCard[] } {
  const side = new Map<string, number>();
  for (const e of build.sideboard) side.set(cardKey(e.card), (side.get(cardKey(e.card)) ?? 0) + e.count);
  const out = { main: [] as DraftCard[], side: [] as DraftCard[] };
  for (const card of pool) {
    const key = cardKey(cardRequestOf(card));
    const n = side.get(key) ?? 0;
    if (n > 0) {
      side.set(key, n - 1);
      out.side.push(card);
    } else out.main.push(card);
  }
  return out;
}

/**
 * The one thing a `.dck` round trip loses: a `.dck` file has no basics
 * section — `toDeckFile` merges the basics pile into `main`, and
 * `deckFromDeckFile` reads a main section back as one pile. A saved build's
 * readers pull the basics back out, because no fold can find a basic land's
 * colour in a drafted pool's own index (basics are not drafted), and the
 * basics counters need them apart.
 */
export function splitBasics(deck: Deck): Deck {
  const main: DeckEntry[] = [];
  const basics: DeckEntry[] = [...deck.basics];
  for (const entry of deck.main) {
    if (isBasicLand(entry.card)) basics.push(entry);
    else main.push(entry);
  }
  return { ...deck, main, basics };
}

/** A saved build's `.dck` text as a deck (basics in their own pile when `allowBasics`), or null for none — or for a save that cannot be read, which opens a fresh build rather than crashing. */
export function savedBuild(text: string | null | undefined, allowBasics: boolean): Deck | null {
  if (typeof text !== 'string') return null;
  try {
    const deck = deckFromDeckFile(parseDck(text));
    return allowBasics ? splitBasics(deck) : deck;
  } catch {
    return null;
  }
}

/**
 * The `.dck` text for a deck, exactly as `@hadoku/carddata`'s `parseDck` reads
 * it back.
 *
 * The round trip is the contract and it is asserted, not assumed:
 * `deckFromPool.test.ts` writes a finished 45-card pool, parses the text with
 * the real parser, and compares the pool that comes back card for card. A
 * writer that is not the inverse of the parser produces a file Forge opens
 * wrong, which is worse than one it refuses.
 */
export function dckTextOf(deck: Deck): string {
  return writeDck(toDeckFile(deck));
}

/**
 * A file name that survives a download folder.
 *
 * Lower-cased, non-word runs collapsed to a single dash, trimmed. A deck name
 * comes from a draft id, which comes from a URL, so it can hold anything; a
 * name that produced a path separator would be a file written somewhere the
 * person did not ask for.
 */
export function dckFilename(deck: Deck): string {
  const slug = deck.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug === '' ? 'draft' : slug}.dck`;
}
