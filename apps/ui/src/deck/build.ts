/*
 * The pure half of `#/deck/<draftId>`: what a drafted deck is on the wire, and
 * how its piles are ordered on screen.
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
 */

import { cardKey, type Deck } from '@hadoku/deck';
// The `/dck` subpath, never the barrel — see `draft/deckFromPool.ts`.
import type { DeckEntry } from '@hadoku/carddata/dck';

import { cardRequestOf, dckTextOf } from '../draft/deckFromPool.ts';
import type { DraftCard, DraftView } from '../draft/types.ts';
import type { SeatChoice, TableDeck, TableFormat } from '../screens/tables.ts';

/** The drafted seat, in the gate's shape: this deck's text, checked against your own pool. */
export function draftedSeat(draftId: string, deck: Deck): SeatChoice {
  return { deck: { dck: dckTextOf(deck) }, rules: { kind: 'draft', draftId } };
}

/**
 * The opponent's seat: a library deck, checked against the Standard it was
 * played in.
 *
 * The draft arm checks only the caller's own pool (`gate.ts`, "Why the draft arm
 * checks only your own pool"), so the other seat cannot be a friend's drafted
 * deck — Forge reads both decks at launch. A library deck is what can sit
 * there. Its own date is the format when the server has that frozen pool,
 * which is the one it was validated legal in; otherwise the newest format,
 * and the server's verdict says what that costs.
 */
export function librarySeat(deck: TableDeck, formats: readonly TableFormat[]): SeatChoice {
  const own = formats.find((f) => f.id === deck.date);
  const format = own ?? formats[formats.length - 1];
  return { deck: { library: deck.id }, rules: { kind: 'standard', format: format?.id ?? deck.date } };
}

/** Where a draft stands, as far as building a deck from it goes. */
export type PoolReadiness =
  | { kind: 'joining' }
  | { kind: 'spectator' }
  | { kind: 'unfinished'; picked: number; total: number }
  | { kind: 'ready'; pool: DraftCard[] };

/**
 * Whether there is a finished pool to build from.
 *
 * The same arithmetic `socket.ts`'s `isComplete` uses — a seat that holds
 * `packCount × packSize` cards has taken every pick — spelled out here because
 * the screen needs the numbers, not only the boolean.
 */
export function poolReadiness(view: DraftView | null): PoolReadiness {
  if (view === null) return { kind: 'joining' };
  if (view.viewer.kind !== 'seat') return { kind: 'spectator' };
  const total = view.packCount * view.packSize;
  const picked = view.viewer.pool.length;
  return picked >= total ? { kind: 'ready', pool: view.viewer.pool } : { kind: 'unfinished', picked, total };
}

/** Pool cards by the key a deck entry carries, so a row can show cost and type. */
export function cardIndex(pool: readonly DraftCard[]): Map<string, DraftCard> {
  const index = new Map<string, DraftCard>();
  for (const card of pool) index.set(cardKey(cardRequestOf(card)), card);
  return index;
}

/** Lands last, then by mana value, then by name: the order a limited player reads a pile in. */
export function sortPile(entries: readonly DeckEntry[], index: ReadonlyMap<string, DraftCard>): DeckEntry[] {
  const rank = (entry: DeckEntry): [number, number, string] => {
    const card = index.get(cardKey(entry.card));
    const land = card !== undefined && /\bLand\b/.test(card.typeLine) ? 1 : 0;
    return [land, card?.manaValue ?? 0, entry.card.name];
  };
  return [...entries].sort((a, b) => {
    const [la, ma, na] = rank(a);
    const [lb, mb, nb] = rank(b);
    return la - lb || ma - mb || na.localeCompare(nb);
  });
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
