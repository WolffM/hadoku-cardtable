/*
 * The cube and set galleries' bar (wave 127 §D, the operator 2026-11-23: "a sorting/filtering bar
 * that lets us sort the cube/sets differently"): one search box and one Sort select, nothing else.
 * It is the Library Decks tab's own toolbar, reused rather than redrawn: `ChipFilterBar`'s search
 * box with no chips, and the Sort select beside it on `.library__sort` and the site's one select
 * rule. The room's picker (Cube, Set and Custom's active pack) and the Library's Cubes tab draw it.
 *
 * `PoolStar` is the star on every cube and set card, the Library deck tile's own (`.library__star`);
 * only its place on the card is this file's sheet.
 */
import type { ReactNode } from 'react';
import { Icon } from '@wolffm/themes';
import { uiLength } from '@hadoku/ui-shell/settings';

import { ChipFilterBar } from '../screens/DeckFilterBar.tsx';
import { POOL_SORTS, isPoolSort, type PoolSort } from './poolSort.ts';
import '../screens/LibraryScreen.css';
import './PoolSortBar.css';

export function PoolSortBar({
  testId,
  query,
  onQuery,
  sort,
  onSort,
  search,
  children,
}: {
  /** The search box is `<testId>-search`, the select `<testId>-sort`. */
  testId: string;
  query: string;
  onQuery: (query: string) => void;
  sort: PoolSort;
  onSort: (sort: PoolSort) => void;
  /** What the search box is called. */
  search: { placeholder: string; ariaLabel: string };
  /** Drawn after the select, in the same row (the Set tab's style toggle). */
  children?: ReactNode;
}) {
  return (
    <div className="lobby__setsrow library__toolbar">
      <ChipFilterBar testId={`${testId}-filter`} label={search.ariaLabel} sets={[]} search={{ testId: `${testId}-search`, ...search, value: query, onChange: onQuery }} />
      <label className="library__sort">
        <span className="lobby__field">Sort</span>
        <select
          value={sort}
          data-testid={`${testId}-sort`}
          onChange={(e) => {
            if (isPoolSort(e.target.value)) onSort(e.target.value);
          }}
        >
          {POOL_SORTS.map((s) => (
            <option key={s.sort} value={s.sort}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      {children}
    </div>
  );
}

/**
 * A card's star. It sits inside the card's `<label>`, after the card's own radio, so the label still
 * names the radio; a press on it is the star's alone and never picks the card.
 */
export function PoolStar({ name, on, onToggle }: { name: string; on: boolean; onToggle: () => void }) {
  return (
    <span className="poolsort__mark">
      <button
        type="button"
        className="library__star"
        aria-pressed={on}
        aria-label={on ? `Unstar ${name}` : `Star ${name}`}
        data-testid="pool-star"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggle();
        }}
      >
        <Icon name="star" size={uiLength('0.9rem')} />
      </button>
    </span>
  );
}
