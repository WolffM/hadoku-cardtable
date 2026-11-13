/*
 * Which decks the picker's filter row lets through — the operator, 2026-10-16:
 * *"next to the set symbols it would be great to have filters for decktype,
 * contained color, and even a text search. for text search if i type 'liliana'
 * it should filter out all decks that don't have a card with liliana in the
 * name."*
 *
 * Three filters, ANDed: the deck's play style is one of those picked (none
 * picked lets every style through); the deck plays EVERY colour picked (U and B
 * picked keeps a Grixis deck, not a mono-blue one); and some card in the main
 * deck or the sideboard has the search text in its name. The text match folds
 * case and accents (`jotun` finds Jötun Grunt) and reads each face of a
 * `Fire // Ice` on its own, so a search never matches across the ` // `.
 */
import type { DeckColor } from '@hadoku/deck';
import type { DeckStyle } from '@hadoku/deck/library';

export interface DeckFilter {
  readonly styles: ReadonlySet<DeckStyle>;
  readonly colors: ReadonlySet<DeckColor>;
  readonly text: string;
}

export const NO_DECK_FILTER: DeckFilter = { styles: new Set(), colors: new Set(), text: '' };

/** What the filter reads of a deck — a picker option has all of it. */
export interface FilterableDeck {
  readonly deckStyle?: DeckStyle | undefined;
  readonly colors: readonly DeckColor[];
  readonly list?: {
    readonly main: readonly { readonly name: string }[];
    readonly sideboard: readonly { readonly name: string }[];
  };
}

/** Lower case with the accents stripped, so `Jötun` and `jotun` are one key. */
export function foldForSearch(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Whether a card's name — any one of its faces — contains the (already folded) query. */
export function cardNameMatches(name: string, foldedQuery: string): boolean {
  return name.split(' // ').some((face) => foldForSearch(face).includes(foldedQuery));
}

export function isFiltering(filter: DeckFilter): boolean {
  return filter.styles.size > 0 || filter.colors.size > 0 || filter.text.trim() !== '';
}

export function deckPasses(deck: FilterableDeck, filter: DeckFilter): boolean {
  if (filter.styles.size > 0 && (deck.deckStyle === undefined || !filter.styles.has(deck.deckStyle))) return false;
  for (const color of filter.colors) if (!deck.colors.includes(color)) return false;
  const query = foldForSearch(filter.text.trim());
  if (query === '') return true;
  const lines = deck.list === undefined ? [] : [...deck.list.main, ...deck.list.sideboard];
  return lines.some((line) => cardNameMatches(line.name, query));
}
