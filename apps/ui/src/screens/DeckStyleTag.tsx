/*
 * A library deck's play style — aggro, midrange, control or combo — as a small
 * tag on its tile and in its peek. The operator, 2026-10-16: *"would be cool if
 * we had a little indicator on the decks in the deck selector that told us
 * whether it was combo, midrange, control, or aggro"*.
 *
 * The style is the one the deck selection gave the deck
 * (`@hadoku/deck/library`'s `LIBRARY_DECK_STYLES`); a deck with none, a
 * drafted pool or a prebuilt, draws no tag rather than a guess. The peek and
 * the filter row draw the mark with the word beside it. A grid tile draws the
 * mark alone, between the name and the colours (operator, 2026-10-16: *"put it
 * between the deck name and the mana symbols … remove the words from the
 * grid"*), and names it with `aria-label`, so the word is still part of the
 * tile's accessible name.
 */
import type { DeckStyle } from '@hadoku/deck/library';

/** The four styles, in the order the filter row offers them. */
export const DECK_STYLE_ORDER: readonly DeckStyle[] = ['aggro', 'midrange', 'control', 'combo'];

const NAMES: Readonly<Record<DeckStyle, string>> = {
  aggro: 'Aggro',
  midrange: 'Midrange',
  control: 'Control',
  combo: 'Combo',
};

export function DeckStyleTag({ style, markOnly = false }: { style: DeckStyle; markOnly?: boolean }) {
  return markOnly ? (
    <span
      className="decktag decktag--mark"
      data-testid="deck-style"
      data-style={style}
      role="img"
      aria-label={NAMES[style]}
      title={NAMES[style]}
    />
  ) : (
    <span className="decktag" data-testid="deck-style" data-style={style}>
      {NAMES[style]}
    </span>
  );
}
