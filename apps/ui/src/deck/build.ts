/*
 * The pure half of `#/deck/<draftId>`: what a drafted deck is on the wire.
 *
 * ## No rules here
 *
 * Legality belongs to two places and neither is this file. The count on screen
 * is `@hadoku/deck`'s `mainDeckSize` against `LIMITED_MIN_MAIN_DECK_SIZE` —
 * the same functions the server's gate calls. The verdict that refuses a match
 * is the server's (`apps/server/src/http/gate.ts`, the `draft` arm of
 * `checkSeat`), reached by `POST /api/tables/check` while you build and by
 * `POST /api/play/matches` when you press Start. A client-side validator here
 * would be a third opinion that could disagree with the one that counts.
 *
 * ## One seat shape for a drafted deck
 *
 * `draftedSeat` is the only place a drafted deck becomes a request. It is the
 * gate's own `{ deck: { dck }, rules: { kind: 'draft', draftId } }` — the arm
 * that checks the text against the CALLER's pool and forwards that same text to
 * Forge — and the text is `dckTextOf`, the writer `tables.test.ts` already
 * proves the gate accepts. Nothing else in the UI writes a drafted `.dck` for
 * play, so there is no second reader to disagree with.
 *
 * ## `splitBasics` — the one thing a `.dck` round trip loses
 *
 * A `.dck` file has no separate basics section: `toDeckFile` merges the
 * basics pile into `main` on export, and `deckFromDeckFile` reads a main
 * section back as ONE pile (see that function's own header in
 * `@hadoku/deck`). Both this wave's readers of a SAVED build —
 * `DeckEditor.tsx`'s own load, and `ConstructedScreen.tsx`'s `DRAFTED_DECK`
 * — parse exactly that file, so both need the inverse: pull the basics back
 * out before anything downstream asks `cardIndex`/`mainDeckColors` about them,
 * because neither fold can find a basic land's colour in a drafted pool's own
 * index (basics are not drafted) and a basic left in `main` therefore drops
 * out of the deck's own colour — the same fact `setBasicLand`'s counters need
 * it split for, one level up.
 */

import { cardKey, isBasicLand, manaTokensOf, type Deck } from '@hadoku/deck';
import { LIBRARY_CARD_COSTS } from '@hadoku/deck/library';
import { parseCardRequest, type DeckEntry } from '@hadoku/carddata/dck';
import { artIdIndexFromTable, scryfallIdFor, type ArtIdTableFile } from '@hadoku/carddata/art';

import { cardRequestOf, dckTextOf } from '../draft/deckFromPool.ts';
import type { DraftCard } from '../draft/types.ts';
import type { SeatChoice, DeckLine } from '../screens/tables.ts';
import { namedFace } from '../screens/DeckPeek.tsx';
import { manaValueOf } from '../screens/ConstructedScreen.tsx';
import artIdsData from '../draft/art-ids.json' with { type: 'json' };

/** The drafted seat, in the gate's shape: this deck's text, checked against your own pool. */
export function draftedSeat(draftId: string, deck: Deck): SeatChoice {
  return { deck: { dck: dckTextOf(deck) }, rules: { kind: 'draft', draftId } };
}

/** The inverse of `toDeckFile` merging basics into `main` — see the header. */
export function splitBasics(deck: Deck): Deck {
  const main: DeckEntry[] = [];
  const basics: DeckEntry[] = [...deck.basics];
  for (const entry of deck.main) {
    if (isBasicLand(entry.card)) basics.push(entry);
    else main.push(entry);
  }
  return { ...deck, main, basics };
}

/**
 * A library deck's two halves (`screens/tables.ts`'s `TableDeck.main`/
 * `.sideboard`, or the server's `GET /api/tables/decks` answer for one), as a
 * `sideboard`-mode `DeckEditor` pool — wave 72 §Q.4's "first commit measures
 * what card data the browser has": the wire sends names, and the browser
 * holds a cost per name (`LIBRARY_CARD_COSTS`) and this app's committed art
 * ids (`LIBRARY_ART_IDS`), nothing else — no type line, no oracle text. That
 * is the SAME path `ConstructedScreen.tsx`'s own deck peek already draws a
 * library card through (`namedPeekLine` → `namedFace`), reused here rather
 * than built a second time. One `DraftCard` per distinct name; `DeckEditor`'s
 * own tile-building multiplies it by each entry's count.
 */
const LIBRARY_ART_IDS = artIdIndexFromTable(artIdsData as ArtIdTableFile);

function namedLibraryFace(name: string): DraftCard {
  const cost = LIBRARY_CARD_COSTS[name] ?? '';
  return namedFace(name, manaTokensOf(cost), manaValueOf(cost), scryfallIdFor(LIBRARY_ART_IDS, name, ''));
}

/** One `DraftCard` per distinct name — the same degrade `libraryDeckPool` uses, for names from anywhere (a drafted sideboard's parsed text, not only a `TableDeck`'s own lines). */
export function namedCardPool(names: Iterable<string>): DraftCard[] {
  return [...new Set(names)].map(namedLibraryFace);
}

export function libraryDeckPool(main: readonly DeckLine[], sideboard: readonly DeckLine[]): DraftCard[] {
  return namedCardPool([...main, ...sideboard].map((l) => l.name));
}

/**
 * The same two halves, as the `.dck` text `DeckEditor`'s own `savedDeck` load
 * already knows how to open (`deckFromDeckFile(parseDck(text))`) — the one
 * load path for both a drafted save and a library one, rather than a second
 * loader that could read the format differently. `parseCardRequest` is the
 * exact function `parseDck` itself calls per line, so a bare name round-trips
 * through this the same way a line with no set or collector number already
 * does.
 */
export function libraryDeckText(main: readonly DeckLine[], sideboard: readonly DeckLine[]): string {
  const entryOf = (line: DeckLine): DeckEntry => ({ count: line.count, card: parseCardRequest(line.name) });
  const deck: Deck = { name: '', main: main.map(entryOf), sideboard: sideboard.map(entryOf), basics: [] };
  return dckTextOf(deck);
}

/** Pool cards by the key a deck entry carries, so a row can show cost and type. */
export function cardIndex(pool: readonly DraftCard[]): Map<string, DraftCard> {
  const index = new Map<string, DraftCard>();
  for (const card of pool) index.set(cardKey(cardRequestOf(card)), card);
  return index;
}

export interface MainSummary {
  creatures: number;
  spells: number;
  lands: number;
  /** Coloured pips in the maindeck's costs, per colour: what the basics are for. */
  pips: Record<'W' | 'U' | 'B' | 'R' | 'G', number>;
}

/** What the maindeck is made of — creatures, other spells, lands — and the colours it asks for. */
export function mainSummary(deck: Deck, index: ReadonlyMap<string, DraftCard>): MainSummary {
  const summary: MainSummary = { creatures: 0, spells: 0, lands: 0, pips: { W: 0, U: 0, B: 0, R: 0, G: 0 } };
  for (const entry of deck.main) {
    const card = index.get(cardKey(entry.card));
    const type = card?.typeLine ?? '';
    if (/\bLand\b/.test(type)) summary.lands += entry.count;
    else if (/\bCreature\b/.test(type)) summary.creatures += entry.count;
    else summary.spells += entry.count;
    for (const token of card?.manaCost ?? []) {
      for (const color of ['W', 'U', 'B', 'R', 'G'] as const) {
        if (token.split('/').includes(color)) summary.pips[color] += entry.count;
      }
    }
  }
  for (const entry of deck.basics) summary.lands += entry.count;
  return summary;
}
