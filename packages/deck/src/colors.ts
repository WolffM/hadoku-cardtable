/*
 * A deck's colours, folded out of its cards' mana costs.
 *
 * Pure string work, so the room screen, the deck builder and the server's
 * match stats all fold a deck the same way: the screen draws the pips, and
 * the server reports the same colours as a match's `colors` stat.
 */

/** WUBRG: the order every Magic interface writes the colours in — the one list of them every package reads. */
export const DECK_COLORS = ['W', 'U', 'B', 'R', 'G'] as const;

/** One of the five, and never a token. */
export type DeckColor = (typeof DECK_COLORS)[number];

/** A mana pool's letters: the colours, then colourless — Forge's `ManaAtom.MANATYPES` order. */
export const POOL_COLORS = [...DECK_COLORS, 'C'] as const;

function isDeckColor(value: string): value is DeckColor {
  return (DECK_COLORS as readonly string[]).includes(value);
}

/**
 * `"{2}{R/P}"` → `['2', 'R/P']`.
 *
 * The UI's own cards arrive as token lists already (`DraftCard.manaCost`); a
 * frozen Standard pool stores Scryfall's string, so the string half is needed
 * for library decks. Same expression as `carddata`'s `build-pool.ts`.
 */
export function manaTokensOf(cost: string): string[] {
  return [...cost.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string);
}

/**
 * The colours one cost token demands, which is NOT the colours of the card.
 *
 * **Phyrexian mana contributes nothing**, and that is the whole reason this
 * fold exists rather than a pass over Scryfall's `colors`. `{R/P}` is payable
 * with two life, so Gut Shot is a red card that a deck with no red mana plays
 * happily — and the M13 library's Mono Green Infect deck plays five such cards
 * (Gut Shot, Mental Misstep, Apostle's Blessing, Gitaxian Probe, Mutagenic
 * Growth). Folding `colors` there yields WURG for a deck whose own name, and
 * whose twelve Forests, say G.
 *
 * A hybrid contributes BOTH halves: `{W/U}` needs one of two colours and a
 * deck showing only one of them would be claiming a choice it has not made.
 * Twobrid (`{2/W}`) contributes its colour, since the generic half is a price
 * rather than an alternative colour.
 *
 * Known limitation: a cost in ORACLE TEXT is invisible here. Lingering Souls'
 * flashback is `{1}{B}` and its mana cost is `{2}{W}`, so the two `uwb-delver`
 * decks in the library fold to WU. Scryfall's `color_identity` would catch it
 * and would also drag Phyrexian back in, which is the worse error; a cost
 * parser that read oracle text would be a second rules engine.
 */
function tokenColors(token: string): DeckColor[] {
  const parts = token.toUpperCase().split('/');
  if (parts.includes('P')) return [];
  return parts.filter(isDeckColor);
}

/** Fold cost tokens into a deck's colours: deduped, WUBRG-ordered. */
export function foldDeckColors(tokens: Iterable<string>): DeckColor[] {
  const held = new Set<string>();
  for (const token of tokens) for (const color of tokenColors(token)) held.add(color);
  return DECK_COLORS.filter((c) => held.has(c));
}

/**
 * A named card list's colours, given Scryfall cost strings by name.
 *
 * This is the arm a LIBRARY deck needs — `decks/pools/*.generated.json`'s
 * `manaCost` map, keyed by every name a card answers to, against the names on a
 * `.dck` line. A deck that is a list of names rather than cards (the room
 * screen's, the server's) folds through this.
 *
 * A name the map has no entry for contributes nothing, because that is what
 * absence means there: every land is absent, and a land has no coloured pip.
 */
export function deckColorsByName(
  names: Iterable<string>,
  costs: Readonly<Record<string, string>>,
): DeckColor[] {
  const tokens: string[] = [];
  for (const name of names) tokens.push(...manaTokensOf(costs[name] ?? ''));
  return foldDeckColors(tokens);
}
