/*
 * Classic's options: the room's format (the leader's tabs and year, or the
 * pool as text for everyone else) and Free pick's browse — one line beside the
 * mode row. The switches that were at its far end, Free pick and Hand
 * smoothing, are in the room's Match rules (`MatchRules.tsx`).
 *
 * The format tab selector is wave 48 §U's; the row used to open the deck card
 * ("Your deck"), and moved here with the mode row (the operator, 2026-10-21).
 * The year is a slider, not a dropdown of full dates and set names (the
 * operator, 2026-11-02: "lets get rid of the dropdown and just make it a
 * left-to-right slider"). The tabs stay: a year does not name its format, since
 * Standard, Modern and Legacy each have an era in every year from 2011 on.
 */

import { useEffect, useState } from 'react';

import { FREE_PICK } from '@hadoku/shared';
import { YearSlider, type YearStop } from '../../components/YearSlider.tsx';
import { formatEraLabel } from '../../front/formatLabel.ts';
import { erasOf, FORMAT_TABS, newestFormat, type FormatFamily, type TableFormat } from '../tables.ts';
import { eraStops, FormatTabs, type FormatTab } from './FormatTabs.tsx';

/** Free pick's browse: a format's library, or the decks you drafted (`#/decks`). */
export type BrowseTab = FormatFamily | 'mine';
const BROWSE_TABS: readonly FormatTab<BrowseTab>[] = [...FORMAT_TABS, { id: 'mine', label: 'My decks' }];

export interface Browse {
  family: BrowseTab;
  era: string;
}

/**
 * The room's pool after the Free pick switch is pressed, and the browse to show with it. On, the whole
 * library is the pool and everyone browses it from the format the table was on; off lands on the era
 * being browsed, else that format's newest.
 */
export function toggledFreePick(formats: readonly TableFormat[], poolId: string, browse: Browse): { pool: string; browse?: Browse } {
  if (poolId !== FREE_PICK) return { pool: FREE_PICK, browse: { family: formats.find((f) => f.id === poolId)?.family ?? 'standard', era: '' } };
  const family = browse.family === 'mine' ? 'standard' : browse.family;
  const era = browse.era || erasOf(formats, family)[0]?.id;
  return { pool: era ?? newestFormat(formats) };
}

/** Free pick's browse stop that is not a year: every year of the tab at once. */
const ALL_YEARS: YearStop = { id: '', label: 'All', year: null };

function poolLabel(formats: readonly TableFormat[], id: string): string {
  const found = formats.find((f) => f.id === id);
  if (found === undefined) return id;
  return found.source === 'free' ? found.name : formatEraLabel(found.id);
}

export function ClassicOptions({
  formats,
  poolId,
  leader,
  disabled,
  onPool,
  browse,
  onBrowse,
}: {
  formats: readonly TableFormat[];
  /** The room's pool: an era's id, or `FREE_PICK`. */
  poolId: string;
  /** Only the leader moves the room; everybody else reads the pool as text. */
  leader: boolean;
  /** A start is in flight or a match is live. */
  disabled: boolean;
  /** Ask the room to move to `poolId`; `settled` runs once it has answered, either way. */
  onPool: (poolId: string, settled: () => void) => void;
  browse: Browse;
  onBrowse: (browse: Browse) => void;
}) {
  /**
   * The year the leader last chose, from the moment it is chosen until the room answers: the slider
   * holds it rather than spring back to the room's year for the round trip and then jump forward.
   * A refusal clears it, and the slider is back on what the room is on, beside the room's own words.
   */
  const [asked, setAsked] = useState<string | null>(null);
  const shownPool = asked ?? poolId;
  const ask = (id: string): void => {
    setAsked(id);
    onPool(id, () => setAsked((now) => (now === id ? null : now)));
  };
  /** Free pick: every library deck, whatever its era. No tab is the table's while it is on. */
  const freePick = poolId === FREE_PICK;
  /** Which tab the table is on: its era's family. */
  const tabOfPool = formats.find((f) => f.id === shownPool)?.family ?? 'standard';
  /**
   * The LEADER's format tab (operator, 2026-10-05: *"i'll need a tab selector
   * at the top for picking the format as well obviously"*).
   *
   * Opens on the table's own era's family and FOLLOWS it there — the effect
   * below re-syncs whenever the pool moves (every write that moved the room's
   * pool, mine or another browser's) and whenever `tabOfPool` does, which
   * without a pool move is only the catalogue arriving after the room and
   * naming the era's family at last. A tab press moves the room onto that
   * tab's newest year at once (the operator, 2026-10-07: "selecting modern
   * should default the year selection to the first available").
   */
  const [formatTab, setFormatTab] = useState<FormatFamily>(tabOfPool);
  useEffect(() => setFormatTab(tabOfPool), [shownPool, tabOfPool]);

  return (
    <>
      {/* The table's pool: one pool, both seats, checked against the same
          list, across Standard, Modern and Legacy alike (wave 48 §U). The
          LEADER gets the tabs and the year; everybody else reads the same
          pool as text and cannot move it. */}
      {leader && !freePick && (
        <>
          <FormatTabs
            tabs={FORMAT_TABS}
            value={formatTab}
            disabled={disabled}
            testId="format"
            onChoose={(tab) => {
              setFormatTab(tab);
              const first = erasOf(formats, tab)[0];
              if (first !== undefined && formats.find((f) => f.id === shownPool)?.family !== tab) ask(first.id);
            }}
          />
          <YearSlider
            testId="format"
            label={`${FORMAT_TABS.find((t) => t.id === formatTab)!.label} year`}
            stops={eraStops(erasOf(formats, formatTab))}
            value={shownPool}
            disabled={disabled}
            busy={asked !== null}
            onChange={(id) => {
              if (id !== shownPool) ask(id);
            }}
          />
        </>
      )}
      {!leader && (
        <span className="lobby__pool" data-testid="format-fixed" data-format={poolId} aria-label={`Format: ${poolLabel(formats, poolId)}`}>
          {poolLabel(formats, poolId)}
        </span>
      )}
      {/* On Free pick, everybody's own browse — see `shownOptions`. */}
      {freePick && (
        <>
          <FormatTabs tabs={BROWSE_TABS} value={browse.family} testId="browse" onChoose={(family) => onBrowse({ family, era: '' })} />
          {/* My decks have no years. Every year at once sits left of the oldest. */}
          {browse.family !== 'mine' && (
            <YearSlider
              testId="browse-era"
              label={`${FORMAT_TABS.find((t) => t.id === browse.family)!.label} year`}
              stops={[ALL_YEARS, ...eraStops(erasOf(formats, browse.family))]}
              value={browse.era}
              onChange={(era) => onBrowse({ family: browse.family, era })}
            />
          )}
        </>
      )}
    </>
  );
}
