/*
 * The deck grids' filter row: sets of toggle chips, then a search box
 * (`ChipFilterBar`). The room's and the Decks page's grid (`DeckFilterBar`)
 * filter on play style, colours the deck must play and a card name
 * (`deckFilter.ts` has what each one means); the stats page's Decks section
 * (`StatsDecks.tsx`) on format, room and deck name. Each style chip is the
 * same tag a deck's tile wears, and each colour is the same Mana-font pip its
 * colours are drawn with, so a filter looks like what it filters on. A grid
 * whose decks have no play style (the Decks page's drafted decks) passes
 * `styles={[]}`: a style chip there could only empty the grid.
 */
import type { ReactNode } from 'react';
import type { DeckColor } from '@hadoku/deck';
import type { DeckStyle } from '@hadoku/deck/library';

import { ManaPip } from '../components/ManaPip.tsx';
import type { DeckFilter } from './deckFilter.ts';
import { DECK_STYLE_ORDER, DeckStyleTag } from './DeckStyleTag.tsx';

const COLORS: readonly { color: DeckColor; name: string }[] = [
  { color: 'W', name: 'White' },
  { color: 'U', name: 'Blue' },
  { color: 'B', name: 'Black' },
  { color: 'R', name: 'Red' },
  { color: 'G', name: 'Green' },
];

export function toggled<T>(set: ReadonlySet<T>, item: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(item)) next.add(item);
  return next;
}

export interface FilterChip {
  testId: string;
  pressed: boolean;
  onToggle: () => void;
  label: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
  /** A colour pip's chip, drawn round. */
  color?: boolean;
}

/** Sets of toggle chips (an empty set draws nothing), then a search box. */
export function ChipFilterBar({ testId, sets, search }: { testId: string; sets: readonly (readonly FilterChip[])[]; search: { testId: string; placeholder: string; ariaLabel: string; value: string; onChange: (text: string) => void } }) {
  return (
    <div className="deckfilter" role="group" aria-label="Filter decks" data-testid={testId}>
      {sets.map(
        (chips, i) =>
          chips.length > 0 && (
            <span key={i} className="deckfilter__set">
              {chips.map((chip) => (
                <button
                  key={chip.testId}
                  type="button"
                  className={chip.color === true ? 'deckfilter__chip deckfilter__color' : 'deckfilter__chip'}
                  aria-pressed={chip.pressed}
                  aria-label={chip.ariaLabel}
                  disabled={chip.disabled}
                  data-testid={chip.testId}
                  onClick={chip.onToggle}
                >
                  {chip.label}
                </button>
              ))}
            </span>
          ),
      )}
      <input
        type="search"
        className="deckfilter__search"
        placeholder={search.placeholder}
        aria-label={search.ariaLabel}
        data-testid={search.testId}
        value={search.value}
        onChange={(e) => search.onChange(e.target.value)}
      />
    </div>
  );
}

export function DeckFilterBar({
  filter,
  onChange,
  styles = DECK_STYLE_ORDER,
}: {
  filter: DeckFilter;
  onChange: (next: DeckFilter) => void;
  /** The play styles offered as chips, in order. */
  styles?: readonly DeckStyle[];
}) {
  return (
    <ChipFilterBar
      testId="deck-filter"
      sets={[
        styles.map((style) => ({
          testId: `deck-filter-style-${style}`,
          pressed: filter.styles.has(style),
          onToggle: () => onChange({ ...filter, styles: toggled(filter.styles, style) }),
          label: <DeckStyleTag style={style} />,
        })),
        COLORS.map(({ color, name }) => ({
          testId: `deck-filter-color-${color}`,
          pressed: filter.colors.has(color),
          onToggle: () => onChange({ ...filter, colors: toggled(filter.colors, color) }),
          label: <ManaPip token={color} />,
          ariaLabel: name,
          color: true,
        })),
      ]}
      search={{ testId: 'deck-filter-text', placeholder: 'Card', ariaLabel: 'Card name', value: filter.text, onChange: (text) => onChange({ ...filter, text }) }}
    />
  );
}
