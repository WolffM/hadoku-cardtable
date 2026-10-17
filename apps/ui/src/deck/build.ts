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

import { cardKey, isBasicLand, type Deck } from '@hadoku/deck';
import type { DeckEntry } from '@hadoku/carddata/dck';

import { cardRequestOf, dckTextOf } from '../draft/deckFromPool.ts';
import type { DraftCard } from '../draft/types.ts';
import type { SeatChoice } from '../screens/tables.ts';

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
