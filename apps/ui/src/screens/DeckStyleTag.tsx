/*
 * A library deck's play style — aggro, midrange, control or combo — as a small
 * tag on its tile and in its peek. The operator, 2026-10-16: *"would be cool if
 * we had a little indicator on the decks in the deck selector that told us
 * whether it was combo, midrange, control, or aggro"*.
 *
 * The style is the one the deck selection gave the deck
 * (`@hadoku/deck/library`'s `LIBRARY_DECK_STYLES`); a deck with none, a
 * drafted pool or a prebuilt, draws no tag rather than a guess. The word is
 * the tag's text, so it is part of the tile's accessible name; the hue beside
 * it (`screens.css`, `.decktag`) is for scanning a grid, never the only signal.
 */
import type { DeckStyle } from '@hadoku/deck/library';

const NAMES: Readonly<Record<DeckStyle, string>> = {
  aggro: 'Aggro',
  midrange: 'Midrange',
  control: 'Control',
  combo: 'Combo',
};

export function DeckStyleTag({ style }: { style: DeckStyle }) {
  return (
    <span className="decktag" data-testid="deck-style" data-style={style}>
      {NAMES[style]}
    </span>
  );
}
