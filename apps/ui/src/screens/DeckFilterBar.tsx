/*
 * The deck grid's filter row: play style, colours the deck must play, and a
 * card-name search (`deckFilter.ts` has what each one means). Each style chip
 * is the same tag a deck's tile wears, and each colour is the same Mana-font
 * pip its colours are drawn with, so a filter looks like what it filters on.
 */
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

function toggled<T>(set: ReadonlySet<T>, item: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(item)) next.add(item);
  return next;
}

export function DeckFilterBar({
  filter,
  onChange,
}: {
  filter: DeckFilter;
  onChange: (next: DeckFilter) => void;
}) {
  return (
    <div className="deckfilter" role="group" aria-label="Filter decks" data-testid="deck-filter">
      <span className="deckfilter__set">
        {DECK_STYLE_ORDER.map((style: DeckStyle) => (
          <button
            key={style}
            type="button"
            className="deckfilter__chip"
            aria-pressed={filter.styles.has(style)}
            data-testid={`deck-filter-style-${style}`}
            onClick={() => onChange({ ...filter, styles: toggled(filter.styles, style) })}
          >
            <DeckStyleTag style={style} />
          </button>
        ))}
      </span>
      <span className="deckfilter__set">
        {COLORS.map(({ color, name }) => (
          <button
            key={color}
            type="button"
            className="deckfilter__chip deckfilter__color"
            aria-pressed={filter.colors.has(color)}
            aria-label={name}
            data-testid={`deck-filter-color-${color}`}
            onClick={() => onChange({ ...filter, colors: toggled(filter.colors, color) })}
          >
            <ManaPip token={color} />
          </button>
        ))}
      </span>
      <input
        type="search"
        className="deckfilter__search"
        placeholder="Card"
        aria-label="Card name"
        data-testid="deck-filter-text"
        value={filter.text}
        onChange={(e) => onChange({ ...filter, text: e.target.value })}
      />
    </div>
  );
}
