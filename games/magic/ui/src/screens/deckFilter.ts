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

/*
 * ── The Library's Decks tab (wave 125) ───────────────────────────────────
 *
 * The operator, 2026-11-23: a deck is "yours" once touched — renamed, rebuilt after the draft,
 * favourited, or played outside its tournament. Favourites sit above everything; your decks
 * next; untouched draft decks sink to "From drafts". A drafted deck whose tournament still runs
 * is not yours yet, so it is in "From drafts" unless starred. Each section is sorted by the
 * chosen sort, last played by default.
 */

/** A deck as the Library sorts it: built or drafted, what the server and the person's document say of it. */
export interface LibraryEntry {
  kind: 'built' | 'drafted';
  name: string;
  favourite: boolean;
  /** Renamed, rebuilt, favourited or played outside its tournament; a built deck always is. */
  touched: boolean;
  inTournament: boolean;
  lastPlayedAt: number | null;
  /** When it was drafted or built. */
  createdAt: number;
  games: number;
  wins: number;
}

export type LibrarySection = 'favourites' | 'yours' | 'drafts';
export const LIBRARY_SECTIONS: readonly LibrarySection[] = ['favourites', 'yours', 'drafts'];

export type LibrarySort = 'played' | 'winrate' | 'name' | 'newest';
export type LibrarySource = 'all' | 'built' | 'drafted' | 'live';

export function sectionOf(deck: LibraryEntry): LibrarySection {
  if (deck.favourite) return 'favourites';
  return deck.touched && !deck.inTournament ? 'yours' : 'drafts';
}

export function sourcePasses(deck: LibraryEntry, source: LibrarySource): boolean {
  switch (source) {
    case 'all':
      return true;
    case 'built':
      return deck.kind === 'built';
    case 'drafted':
      return deck.kind === 'drafted';
    case 'live':
      return deck.inTournament;
  }
}

/** Never played sorts after every played deck, newest drafted or built first among them. */
const byPlayed = (a: LibraryEntry, b: LibraryEntry): number => (b.lastPlayedAt ?? -1) - (a.lastPlayedAt ?? -1) || b.createdAt - a.createdAt;
/** A deck with no games has no win rate: after every played one. */
const rate = (d: LibraryEntry): number => (d.games === 0 ? -1 : d.wins / d.games);

const COMPARE: Record<LibrarySort, (a: LibraryEntry, b: LibraryEntry) => number> = {
  played: byPlayed,
  winrate: (a, b) => rate(b) - rate(a) || b.games - a.games || byPlayed(a, b),
  name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || byPlayed(a, b),
  newest: (a, b) => b.createdAt - a.createdAt,
};

/** The decks in their sections, in order, each sorted; a section with none is left out. */
export function librarySections<T extends LibraryEntry>(decks: readonly T[], sort: LibrarySort): { section: LibrarySection; decks: T[] }[] {
  return LIBRARY_SECTIONS.flatMap((section) => {
    const inIt = decks.filter((d) => sectionOf(d) === section).sort(COMPARE[sort]);
    return inIt.length === 0 ? [] : [{ section, decks: inIt }];
  });
}

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** The tile's when-line: "Last played Nov 19", or "Never played · drafted Oct 21". */
export function playedLine(deck: Pick<LibraryEntry, 'kind' | 'lastPlayedAt' | 'createdAt'>): string {
  if (deck.lastPlayedAt !== null) return `Last played ${DAY.format(deck.lastPlayedAt)}`;
  return `Never played · ${deck.kind === 'built' ? 'built' : 'drafted'} ${DAY.format(deck.createdAt)}`;
}
