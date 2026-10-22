/*
 * Classic's options: the room's format (the leader's tabs and era, or the
 * pool as text for everyone else), Free pick's browse, and the leader's
 * switches — one line beside the mode row.
 *
 * The format tab selector is wave 48 §U's; the row used to open the deck card
 * ("Your deck"), and moved here with the mode row (the operator, 2026-10-21).
 */

import { useEffect, useState } from 'react';

import { erasOf, FORMAT_TABS, FREE_PICK, newestFormat, poolIsOnTab, type FormatFamily, type TableFormat } from '../tables.ts';

/** Free pick's browse: a format's library, or the decks you drafted (`#/decks`). */
export type BrowseTab = FormatFamily | 'mine';
const BROWSE_TABS: ReadonlyArray<{ id: BrowseTab; label: string }> = [...FORMAT_TABS, { id: 'mine', label: 'My decks' }];

export interface Browse {
  family: BrowseTab;
  era: string;
}

function poolLabel(formats: readonly TableFormat[], id: string): string {
  const found = formats.find((f) => f.id === id);
  if (found === undefined) return id;
  return found.source === 'free' ? found.name : `${found.id} — ${found.name}`;
}

export function ClassicOptions({
  formats,
  poolId,
  leader,
  disabled,
  onPool,
  browse,
  onBrowse,
  handSmoothing,
  onHandSmoothing,
}: {
  formats: readonly TableFormat[];
  /** The room's pool: an era's id, or `FREE_PICK`. */
  poolId: string;
  /** Only the leader moves the room; everybody else reads the pool as text. */
  leader: boolean;
  /** A start is in flight or a match is live. */
  disabled: boolean;
  onPool: (poolId: string) => void;
  browse: Browse;
  onBrowse: (browse: Browse) => void;
  handSmoothing: boolean;
  onHandSmoothing: () => void;
}) {
  /** Free pick: every library deck, whatever its era. No tab is the table's while it is on. */
  const freePick = poolId === FREE_PICK;
  /** Which tab the table is actually on: its era's family. */
  const tabOfPool = formats.find((f) => f.id === poolId)?.family ?? 'standard';
  /**
   * The LEADER's format tab (operator, 2026-10-05: *"i'll need a tab selector
   * at the top for picking the format as well obviously"*).
   *
   * Opens on the table's own era's family and FOLLOWS it there — the effect
   * below re-syncs whenever `poolId` moves (every write that moved the room's
   * pool, mine or another browser's) and whenever `tabOfPool` does, which
   * without a pool move is only the catalogue arriving after the room and
   * naming the era's family at last. Switching tabs by hand changes neither,
   * so it only BROWSES which eras the `<select>` below offers; nothing is sent
   * until an option in it is chosen, same as the control always worked.
   */
  const [formatTab, setFormatTab] = useState<FormatFamily>(tabOfPool);
  useEffect(() => setFormatTab(tabOfPool), [poolId, tabOfPool]);
  /**
   * Whether the room's actual pool is one of THIS tab's own options.
   *
   * False while browsing a tab the room is not on (its own era is a different
   * family). The `<select>` below reads this to decide whether to show
   * `poolId` as chosen or nothing at all — see the comment on the select
   * itself for why "nothing at all" is the one safe answer.
   */
  const poolOnTab = poolIsOnTab(formats, formatTab, poolId);

  return (
    <>
          {/* The table's pool: "Format" — one pool, both seats, checked
              against the same list, across Standard, Modern and Legacy
              alike (wave 48 §U). The LEADER gets a control; everybody else reads
              the same text and cannot move it, which is the whole of
              *"people who join can only select from the deck
              dropdown"*. */}
          {leader ? (
            <>
              {/* On Free pick the leader's switch says so and the browse tabs
                  name themselves; the label would only push the switch onto
                  a second line, and that line comes off the deck grid. */}
              {!freePick && (
                <label className="lobby__field" htmlFor="format">
                  Format
                </label>
              )}
              {/* The format tab selector (wave 48 §U), replacing the single
                  "Matched Standard" optgroup: Standard, Modern, Legacy. The active tab opens
                  on the table's own era and only browses which eras the
                  select below offers; nothing moves the room until an option
                  in it is chosen. No prose: the tabs are the explanation. */}
              {!freePick && (
                <div className="lobby__format-tabs" role="tablist" data-testid="format-tabs">
                  {FORMAT_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      className="ct-toggle"
                      role="tab"
                      aria-selected={formatTab === tab.id}
                      data-testid={`format-tab-${tab.id}`}
                      disabled={disabled}
                      onClick={() => {
                        setFormatTab(tab.id);
                        // A tab whose eras do not include the room's pool chooses its first era
                        // (newest, the list's order) at once, rather than showing nothing chosen
                        // until the leader picks (the operator, 2026-10-07: "selecting modern
                        // should default the year selection to the first available").
                        if (!poolIsOnTab(formats, tab.id, poolId)) {
                          const first = erasOf(formats, tab.id)[0];
                          if (first !== undefined) onPool(first.id);
                        }
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              )}
              {/* The era the room is ACTUALLY on is not always one this
                  tab offers (you are browsing Modern while the room
                  sits on a Standard era), and a native `<select>`
                  whose `value` matches none of its `<option>`s falls
                  back to showing the FIRST one as already selected —
                  which then fires no `change` event if that is the
                  very one you click, so the room could never be moved
                  to it (found live, w48 §U: `selectOption` on that
                  first option sent no PATCH). A disabled, hidden,
                  EMPTY placeholder option — never any text — keeps
                  the select correctly showing nothing chosen on this
                  tab, so every real era here is a genuine change. */}
              {!freePick && (
                <select
                  id="format"
                  data-testid="format"
                  value={poolOnTab ? poolId : ''}
                  disabled={disabled}
                  onChange={(e) => onPool(e.target.value)}
                >
                  {!poolOnTab && <option value="" disabled hidden />}
                  {erasOf(formats, formatTab).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.id} — {f.name}
                    </option>
                  ))}
                </select>
              )}
            </>
          ) : (
            <>
              {/* "Free pick" names itself; the label beside it would wrap
                  the browse row (found at 1024x700 on the CI runner's fonts). */}
              {!freePick && <span className="lobby__field">Format</span>}
              <span className="lobby__pool" data-testid="format-fixed" data-format={poolId}>
                {poolLabel(formats, poolId)}
              </span>
            </>
          )}
          {/* On Free pick, everybody's own browse — see `shownOptions`. */}
          {freePick && (
            <>
              <div className="lobby__format-tabs" role="tablist" data-testid="browse-tabs">
                {BROWSE_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className="ct-toggle"
                    role="tab"
                    aria-selected={browse.family === tab.id}
                    data-testid={`browse-tab-${tab.id}`}
                    onClick={() => onBrowse({ family: tab.id, era: '' })}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              {/* My decks have no years. */}
              {browse.family !== 'mine' && (
                <select
                  data-testid="browse-era"
                  aria-label={`${browse.family} year`}
                  value={browse.era}
                  onChange={(e) => onBrowse({ family: browse.family, era: e.target.value })}
                >
                  <option value="">All years</option>
                  {/* A format has one era a year, so the year names it, and a
                      short option keeps this row one line high. */}
                  {erasOf(formats, browse.family).map((f) => (
                    <option key={f.id} value={f.id} title={f.name}>
                      {f.effective.slice(0, 4)}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
          {/* The leader's switches, together at the row's far end. */}
          {leader && (
            <span className="lobby__switches">
              {/* Free pick is a switch of its own, not a fourth tab: on, the
                  whole library is the pool and everyone browses it by format
                  on this row; off, the leader's tabs pick the room's era again. Off
                  lands on the era being browsed, else that format's newest. */}
              <button
                type="button"
                className="lobby__free-pick ct-toggle"
                aria-pressed={freePick}
                data-testid="free-pick"
                disabled={disabled}
                onClick={() => {
                  if (!freePick) {
                    onBrowse({ family: formatTab, era: '' });
                    onPool(FREE_PICK);
                    return;
                  }
                  const family = browse.family === 'mine' ? 'standard' : browse.family;
                  const era = browse.era || erasOf(formats, family)[0]?.id;
                  onPool(era ?? newestFormat(formats));
                }}
              >
                Free pick
              </button>
              {/* The room's first match setting: the opening hand nearer the
                  deck's land ratio, each mulligan weighted toward it. */}
              <button
                type="button"
                className="lobby__free-pick ct-toggle"
                aria-pressed={handSmoothing}
                data-testid="hand-smoothing"
                disabled={disabled}
                onClick={onHandSmoothing}
              >
                Hand smoothing
              </button>
            </span>
          )}
    </>
  );
}
