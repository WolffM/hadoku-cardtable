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
 *
 * The marks are one ink, never a hue (operator, 2026-10-16: *"we cannot color
 * them, it's too confusing with the mana symbols next to it"*), and are the
 * "Motion" set they picked: fast-forward for aggro, a balanced beam for
 * midrange, a stop sign for control, an infinite loop for combo.
 */
import type { ReactNode } from 'react';
import type { DeckStyle } from '@hadoku/deck/library';

/** The four styles, in the order the filter row offers them. */
export const DECK_STYLE_ORDER: readonly DeckStyle[] = ['aggro', 'midrange', 'control', 'combo'];

const NAMES: Readonly<Record<DeckStyle, string>> = {
  aggro: 'Aggro',
  midrange: 'Midrange',
  control: 'Control',
  combo: 'Combo',
};

const MARKS: Readonly<Record<DeckStyle, ReactNode>> = {
  aggro: (
    <path
      d="M4 5l7 7-7 7M12 5l7 7-7 7"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  midrange: (
    <>
      <rect x="2.5" y="6" width="19" height="3.6" rx="1.8" fill="currentColor" />
      <path d="M12 9.6l5.5 10.4h-11z" fill="currentColor" />
    </>
  ),
  control: <path fillRule="evenodd" d="M8 2h8l6 6v8l-6 6H8l-6-6V8zM6.5 10.4v3.2h11v-3.2z" fill="currentColor" />,
  combo: (
    <path
      d="M12 12c-2.2-3.1-4-4.6-6-4.6a4.6 4.6 0 0 0 0 9.2c2 0 3.8-1.5 6-4.6s4-4.6 6-4.6a4.6 4.6 0 0 1 0 9.2c-2 0-3.8-1.5-6-4.6z"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.8"
    />
  ),
};

function StyleMark({ style }: { style: DeckStyle }) {
  return (
    <svg className="decktag__mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {MARKS[style]}
    </svg>
  );
}

/** `titled: false` drops the mark's native tooltip where a hover already opens the deck's peek, which names the style. */
export function DeckStyleTag({ style, markOnly = false, titled = true }: { style: DeckStyle; markOnly?: boolean; titled?: boolean }) {
  return markOnly ? (
    <span
      className="decktag decktag--mark"
      data-testid="deck-style"
      data-style={style}
      role="img"
      aria-label={NAMES[style]}
      title={titled ? NAMES[style] : undefined}
    >
      <StyleMark style={style} />
    </span>
  ) : (
    <span className="decktag" data-testid="deck-style" data-style={style}>
      <StyleMark style={style} />
      {NAMES[style]}
    </span>
  );
}
