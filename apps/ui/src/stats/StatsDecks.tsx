/*
 * The stats page's Decks section — the operator, 2026-10-20: *"'Decks that
 * win' seems like the same thing as 'Decks'. lets just keep decks and also add
 * a filter bar to that one for format, room type, and text filter. also in the
 * rows keep the color icons and make it so the decks can be hovered and their
 * data can be seen as it can be in other places where decks are shown"*.
 *
 *   - **The filter bar** is the deck grid's own (`ChipFilterBar`'s chips and
 *     search box). Format and room are match attrs the store narrows by
 *     (`match.format`); the name search narrows the rows it answered.
 *   - **Room type is the format's other half.** A draft room's tables always
 *     play its pod's pool, reported as format `draft`, and a constructed room
 *     never does (`apps/server/src/http/routes.ts`, "A pod's tables play a
 *     DRAFTED pool") — so Constructed is the four constructed formats and Draft
 *     pod is `draft`, for every match ever recorded, with no attr to add.
 *   - **Each row draws the deck's colours** and opens its list on hover with
 *     the room picker's own peek (`DeckPeek`, `usePeekHover`): a library deck
 *     by its catalog id, a drafted one (`draft:<podId>`) from the viewer's own
 *     decks. Another player's drafted deck is theirs to show, so it opens
 *     nothing.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BreakdownSpec } from '@wolffm/game-stats-ui';
import type { BreakdownRow, StatAttrs } from '@wolffm/prefs-client/games';

import { ManaPip } from '../components/ManaPip.tsx';
import { myDecksClient, type MyDecksClient } from '../deck/myDecks.ts';
import { draftedDeckOption, libraryDeckPeek, openDraftedDeck, type PeekedDeck } from '../screens/ConstructedScreen.tsx';
import { ChipFilterBar, toggled } from '../screens/DeckFilterBar.tsx';
import { DeckPeek, usePeekHover } from '../screens/DeckPeek.tsx';
import { FORMAT_TABS, FREE_PICK, tablesClient, type FormatFamily, type TablesClient } from '../screens/tables.ts';

export type StatsFormat = FormatFamily | typeof FREE_PICK;
export type StatsRoom = 'constructed' | 'draft';

export interface DeckStatsFilter {
  formats: ReadonlySet<StatsFormat>;
  rooms: ReadonlySet<StatsRoom>;
  text: string;
}

export const NO_STATS_FILTER: DeckStatsFilter = { formats: new Set(), rooms: new Set(), text: '' };

/** The room's format tabs and Free pick: every format a constructed room plays. */
const FORMATS: readonly { id: StatsFormat; label: string }[] = [...FORMAT_TABS, { id: FREE_PICK, label: 'Free pick' }];
/** The format a match reports when its pool is none of those (`routes.ts`'s matchStart): a constructed room's too. */
const UNKNOWN_FORMAT = 'unknown';

const ROOMS: readonly { id: StatsRoom; label: string }[] = [
  { id: 'constructed', label: 'Constructed' },
  { id: 'draft', label: 'Draft pod' },
];

/** The `format` match attr values a filter keeps; undefined keeps every match. */
export function matchFormats(filter: DeckStatsFilter): string[] | undefined {
  if (filter.formats.size > 0) return [...filter.formats];
  if (filter.rooms.size === 0) return undefined;
  return [...filter.rooms].flatMap((room) => (room === 'draft' ? ['draft'] : [...FORMATS.map((f) => f.id), UNKNOWN_FORMAT]));
}

/** The rows whose deck name holds the search, ignoring case. */
export function filterDeckRows(rows: readonly BreakdownRow[], text: string): readonly BreakdownRow[] {
  const needle = text.trim().toLowerCase();
  return needle === '' ? rows : rows.filter((row) => row.value.toLowerCase().includes(needle));
}

/** The seat attrs a deck row carries off its latest seat: its pips, and what its list is found by. */
export const DECK_ROW_ATTRS = ['colors', 'deckId'] as const;

/**
 * The Decks section for a filter. The bare one (no filter) is what the lobby
 * prefetches, so the section opens drawn.
 */
export function decksSpec(filter: DeckStatsFilter = NO_STATS_FILTER, toolbar?: ReactNode): BreakdownSpec {
  const formats = matchFormats(filter);
  return {
    attr: 'deck',
    title: 'Decks',
    label: 'Deck',
    wide: true,
    with: DECK_ROW_ATTRS,
    ...(formats === undefined ? {} : { match: { format: formats } }),
    ...(filter.text.trim() === '' ? {} : { filterRows: (rows: readonly BreakdownRow[]) => filterDeckRows(rows, filter.text) }),
    ...(toolbar === undefined ? {} : { toolbar }),
  };
}

/**
 * Format chips, room chips and a deck-name search, on the deck grid's own
 * filter row. A format is a constructed one, so the format chips stand down
 * while only Draft pod is chosen, and Draft pod while a format is.
 */
export function DeckStatsFilterBar({ filter, onChange }: { filter: DeckStatsFilter; onChange: (next: DeckStatsFilter) => void }) {
  const draftOnly = filter.rooms.size === 1 && filter.rooms.has('draft');
  return (
    <ChipFilterBar
      testId="stats-deck-filter"
      sets={[
        FORMATS.map(({ id, label }) => ({
          testId: `stats-deck-format-${id}`,
          pressed: filter.formats.has(id),
          disabled: draftOnly,
          onToggle: () => onChange({ ...filter, formats: toggled(filter.formats, id) }),
          label: <span className="decktag">{label}</span>,
        })),
        ROOMS.map(({ id, label }) => ({
          testId: `stats-deck-room-${id}`,
          pressed: filter.rooms.has(id),
          disabled: id === 'draft' && filter.formats.size > 0,
          onToggle: () => onChange({ ...filter, rooms: toggled(filter.rooms, id) }),
          label: <span className="decktag">{label}</span>,
        })),
      ]}
      search={{ testId: 'stats-deck-text', placeholder: 'Deck', ariaLabel: 'Deck name', value: filter.text, onChange: (text) => onChange({ ...filter, text }) }}
    />
  );
}

/** A deck's list by the id its seat reported, or null when this viewer cannot see it. */
export type DeckLookup = (deckId: string) => Promise<PeekedDeck | null>;

const DRAFTED = 'draft:';

/**
 * The library's lists (`GET /api/decks` of the tables API) and the viewer's
 * own drafted decks (`GET /api/decks` of the Decks page), each read once, on
 * the first hover that needs it.
 */
export function deckLookup(tables: Pick<TablesClient, 'decks'> = tablesClient(), mine: Pick<MyDecksClient, 'list'> = myDecksClient()): DeckLookup {
  let library: ReturnType<TablesClient['decks']> | undefined;
  let drafted: ReturnType<MyDecksClient['list']> | undefined;
  return async (deckId) => {
    if (deckId.startsWith(DRAFTED)) {
      drafted ??= mine.list();
      const podId = deckId.slice(DRAFTED.length);
      const d = (await drafted).find((deck) => deck.id === podId);
      if (d === undefined || d.deck === null) return null;
      const option = draftedDeckOption(deckId, d.name, openDraftedDeck(d.deck, d.id, d.pool), d.pool);
      return option.list === undefined ? null : { label: option.label, colors: option.colors, list: option.list };
    }
    library ??= tables.decks();
    const d = (await library).find((deck) => deck.id === deckId);
    return d === undefined ? null : libraryDeckPeek(d);
  };
}

interface DeckHover {
  /** The deck whose list is open. */
  open: string | null;
  /** Whether a row of this deck can open a list for this page's viewer. */
  canPeek: (deckId: string) => boolean;
  enter: (deckId: string, el: HTMLElement) => void;
  leave: () => void;
}

const DeckHoverContext = createContext<DeckHover | null>(null);

/**
 * One peek for every deck row on the page, as the picker has one for its grid:
 * it opens beside the row the pointer rests on, and the pointer can move into
 * it. `ownDecks` is false on another player's page, whose drafted decks this
 * viewer has no list of.
 */
export function DeckPeekHost({ lookup, ownDecks, children }: { lookup: DeckLookup; ownDecks: boolean; children: ReactNode }) {
  const hover = usePeekHover<string>();
  const [found, setFound] = useState<ReadonlyMap<string, PeekedDeck | null>>(() => new Map());
  const close = hover.close;

  useEffect(() => {
    const onScroll = (): void => close();
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, [close]);

  const enter = useCallback(
    (deckId: string, el: HTMLElement) => {
      if (!found.has(deckId)) {
        lookup(deckId).then(
          (deck) => setFound((prev) => new Map(prev).set(deckId, deck)),
          (err: unknown) => {
            console.warn('[cardtable] a deck list for the stats page is unavailable', deckId, err);
            setFound((prev) => new Map(prev).set(deckId, null));
          },
        );
      }
      hover.openSoon(deckId, () => {
        if (!el.isConnected) return null;
        const screen = el.closest('[data-testid="stats"]') ?? document.documentElement;
        return { anchor: el.getBoundingClientRect(), bounds: screen.getBoundingClientRect() };
      });
    },
    [found, lookup, hover.openSoon],
  );

  const open = hover.peek;
  const deck = open === null ? undefined : found.get(open.key);
  const shown = deck === undefined || deck === null ? null : (open?.key ?? null);
  const value = useMemo<DeckHover>(
    () => ({ open: shown, canPeek: (deckId) => ownDecks || !deckId.startsWith(DRAFTED), enter, leave: hover.closeSoon }),
    [shown, ownDecks, enter, hover.closeSoon],
  );

  return (
    <DeckHoverContext.Provider value={value}>
      {children}
      {open !== null && deck !== undefined && deck !== null && (
        <DeckPeek
          id="stats-deck-peek"
          label={deck.label}
          name={deck.name}
          pilot={deck.pilot}
          colors={deck.colors}
          deckStyle={deck.deckStyle}
          list={deck.list}
          anchor={open.anchor}
          bounds={open.bounds}
          onPointerEnter={hover.hold}
          onPointerLeave={hover.closeSoon}
        />
      )}
    </DeckHoverContext.Provider>
  );
}

const colorsOf = (carried: StatAttrs | undefined): string[] => {
  const colors = carried?.colors;
  return Array.isArray(colors) ? colors : [];
};

/** A deck row's cell: its name, which opens its list on hover, then its colours — the picker tile's order. */
export function StatsDeckName({ name, carried }: { name: string; carried?: StatAttrs | undefined }) {
  const hover = useContext(DeckHoverContext);
  const deckId = typeof carried?.deckId === 'string' ? carried.deckId : undefined;
  const peekable = hover !== null && deckId !== undefined && hover.canPeek(deckId);
  const colors = colorsOf(carried);
  return (
    <span
      className="ct-stats-deck"
      data-testid="stats-deck"
      data-deck-id={deckId}
      aria-describedby={peekable && hover.open === deckId ? 'stats-deck-peek' : undefined}
      onPointerEnter={
        peekable
          ? (event) => {
              if (event.pointerType !== 'touch') hover.enter(deckId, event.currentTarget);
            }
          : undefined
      }
      onPointerLeave={peekable ? hover.leave : undefined}
    >
      <span className="ct-stats-deck__name">{name}</span>
      <span className="cost" data-colors={colors.join('')}>
        {colors.map((c) => (
          <ManaPip key={c} token={c} />
        ))}
      </span>
    </span>
  );
}
