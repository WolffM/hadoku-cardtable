/*
 * The stats page's furniture: a section card that draws one read, a win-rate bar, and a row of
 * pill chips that picks one of a few. Each card loads through `@wolffm/game-stats-ui`'s
 * `useStatsLoad`, so a read the lobby made ahead of the page draws on the first frame and is
 * refreshed behind it, and a refused read says "Sign in to see stats." in the card's place.
 */

import { useId, type ReactNode } from 'react';
import { formatWinRate, useStatsLoad, type StatsCache } from '@wolffm/game-stats-ui';
import { winRate, type OutcomeTotals } from '@wolffm/prefs-client/games';

import type { StatsRead } from './source.ts';

export interface StatsCardProps<T> {
  title: string;
  /** A few words beside the title: what the rows count. */
  sub?: string;
  /** Beside the title, at the head's far end: the card's chips or search. */
  tools?: ReactNode;
  read: StatsRead<T>;
  cache: StatsCache;
  /** True when there is nothing to draw; the card then says `emptyText`. */
  isEmpty?: (value: T) => boolean;
  emptyText?: string;
  /** Rows edge to edge, the head inset above them: a table or a feed. */
  flush?: boolean;
  className?: string;
  testId: string;
  children: (value: T) => ReactNode;
}

export function StatsCard<T>({ title, sub, tools, read, cache, isEmpty, emptyText = 'No games yet', flush = false, className, testId, children }: StatsCardProps<T>) {
  const id = useId();
  const result = useStatsLoad(read.load, read.key, cache);
  return (
    <section
      className={['ct-stats__card', flush ? 'ct-stats__card--flush' : '', className ?? ''].filter((c) => c !== '').join(' ')}
      aria-labelledby={id}
      aria-busy={result.state === 'loading'}
      data-testid={testId}
    >
      <div className="ct-stats__card-head">
        <h2 id={id} className="ct-stats__card-title">
          {title}
        </h2>
        {sub !== undefined && <span className="ct-stats__card-sub">{sub}</span>}
        {tools}
      </div>
      {result.state === 'loading' && (
        <div className="ct-stats__pending">
          <span className="skeleton skeleton--row" />
          <span className="skeleton skeleton--row" />
        </div>
      )}
      {result.state === 'ok' && (isEmpty?.(result.value) === true ? <p className="ct-stats__note">{emptyText}</p> : children(result.value))}
      {result.state === 'error' && (
        <p className="ct-stats__note" role="alert">
          {result.message}
        </p>
      )}
    </section>
  );
}

/** A win rate as a bar: the share won, filled in the theme's success. */
export function WinBar({ totals }: { totals: OutcomeTotals }) {
  return (
    <span className="ct-winbar" aria-hidden="true">
      <span className="ct-winbar__fill" style={{ width: `${totals.games === 0 ? 0 : Math.round(winRate(totals) * 100)}%` }} />
    </span>
  );
}

/** The bar and its number, side by side: a table's Win rate cell. */
export function WinRate({ totals }: { totals: OutcomeTotals }) {
  return (
    <span className="ct-winrate">
      <WinBar totals={totals} />
      <span className="ct-winrate__pct">{formatWinRate(totals)}</span>
    </span>
  );
}

/** Pill chips that pick one of a few: what a board ranks by, which matches a feed shows. */
export function ChipGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  testId,
}: {
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  testId: string;
}) {
  return (
    <div className="ct-stats__chips" role="group" aria-label={label} data-testid={testId}>
      {options.map((o) => (
        <button key={o.id} type="button" className="ct-stats__chip" aria-pressed={o.id === value} data-testid={`${testId}-${o.id}`} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
