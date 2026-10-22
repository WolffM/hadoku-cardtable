/*
 * The pure half of the deck editor: what a drafted deck is on the wire, and the land suggestion.
 *
 * ## No rules here
 *
 * The count on screen is `@hadoku/deck`'s `mainDeckSize` against the deck's
 * floor (`LIMITED_MIN_MAIN_DECK_SIZE` for a drafted pool). The verdict is the
 * server's: `POST /api/tables/check` once the build reaches its floor (it is
 * what enables Play), and the room's gate at ready and start.
 *
 * ## One seat shape for a drafted deck
 *
 * `draftedSeat` is the only place a drafted deck becomes a request: the gate's
 * own `{ deck: { dck }, rules: { kind: 'draft', draftId } }`, the arm that
 * checks the text against the CALLER's pool, with the text from `dckTextOf`.
 */

import { cardKey, DECK_COLORS, isBasicLand, manaTokensOf, type Deck, cardRequestOf } from '@hadoku/deck';
import { LIBRARY_CARD_COSTS } from '@hadoku/deck/library';
import { parseCardRequest, type DeckEntry } from '@hadoku/carddata/dck';
import { artIdIndexFromTable, backFaceNames, scryfallIdFor, type ArtIdTableFile } from '@hadoku/carddata/art';

import { dckTextOf } from '../draft/deckFromPool.ts';
import type { DraftCard } from '../draft/types.ts';
import type { SeatChoice, DeckLine } from '../screens/tables.ts';
import { namedFace } from '../screens/DeckPeek.tsx';
import { manaValueOf } from '../screens/ConstructedScreen.tsx';
import artIdsData from '../draft/art-ids.json' with { type: 'json' };

/** The drafted seat, in the gate's shape: this deck's text, checked against your own pool. */
export function draftedSeat(draftId: string, deck: Deck): SeatChoice {
  return { deck: { dck: dckTextOf(deck) }, rules: { kind: 'draft', draftId } };
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
  const id = scryfallIdFor(LIBRARY_ART_IDS, name, '');
  return namedFace(name, manaTokensOf(cost), manaValueOf(cost), id, backFaceNames(LIBRARY_ART_IDS, id));
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
      for (const color of DECK_COLORS) {
        if (token.split('/').includes(color)) summary.pips[color] += entry.count;
      }
    }
  }
  for (const entry of deck.basics) summary.lands += entry.count;
  return summary;
}

export type BasicCounts = Record<'W' | 'U' | 'B' | 'R' | 'G', number>;

/**
 * How many of each basic the maindeck wants — Forge's
 * `DeckgenUtil.suggestBasicLandCount` (`forge-gui/src/main/java/forge/deck/DeckgenUtil.java`),
 * ported with its order and rounding, over the deck WITHOUT its current
 * basics (the editor's Auto replaces them rather than adding to them).
 *
 * Forge's steps: the lands to add are the target size less the main deck; each colour in W, U, B, R, G order takes its rounded share of
 * what is left by its count of pure coloured symbols, at least one if it has
 * any. Forge's last step, a rounding leftover handed to the first colour that
 * got lands, is not ported: the last colour with symbols always takes exactly
 * what is left (its share of the remaining total is the whole of it), so no
 * leftover can reach it.
 *
 * The target is the caller's: the editor's own floor, 40 for a drafted pool.
 * Forge picks it from the non-land count instead (under 30 is 40, over 60 is
 * 100, else 60), which is a constructed rule: a drafted build of 30
 * spells came back padded to 60.
 *
 * Two edges Forge leaves open are closed here: a deck already at or over its
 * target adds nothing (Forge would hand back negative counts), and a deck
 * with no coloured symbols adds nothing (Forge divides by zero).
 */
export function suggestBasics(deck: Deck, index: ReadonlyMap<string, DraftCard>, target: number): BasicCounts {
  const none: BasicCounts = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  let size = 0;
  const shards: BasicCounts = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const entry of deck.main) {
    if (isBasicLand(entry.card)) continue;
    const card = index.get(cardKey(entry.card));
    size += entry.count;
    for (const token of card?.manaCost ?? []) {
      if (token === 'W' || token === 'U' || token === 'B' || token === 'R' || token === 'G') shards[token] += entry.count;
    }
  }
  let toAdd = target - size;
  let total = shards.W + shards.U + shards.B + shards.R + shards.G;
  if (toAdd <= 0 || total === 0) return none;

  const out: BasicCounts = { ...none };
  for (const c of DECK_COLORS) {
    // A colour with no symbols takes none (Forge's share of 0, without its 0/0
    // once every coloured colour has been served); one with any takes at least one.
    const n = shards[c] === 0 ? 0 : Math.max(1, Math.round((toAdd * shards[c]) / total));
    out[c] = n;
    toAdd -= n;
    total -= shards[c];
  }
  return out;
}
