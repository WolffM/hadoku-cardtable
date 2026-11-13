/*
 * The stats page's decks: the Leaderboard's Winning decks, the profile's Decks table, and the
 * filter bar, peek and pips they share. The operator, 2026-10-20: *"'Decks that win' seems like
 * the same thing as 'Decks'. lets just keep decks and also add a filter bar to that one for format,
 * room type, and text filter. also in the rows keep the color icons and make it so the decks can be
 * hovered and their data can be seen as it can be in other places where decks are shown"*. The
 * redesign (2026-11-02) put everyone's best decks back on the Leaderboard and kept the filtered
 * table on each player's profile.
 *
 *   - **The filter bar** is the deck grid's own (`ChipFilterBar`'s chips and
 *     search box), drawn as the page's pills. Format and room are match attrs the store narrows by
 *     (`match.format`); the name search narrows the rows it answered.
 *   - **Room type is the format's other half.** A draft room's tables always
 *     play its pod's pool, reported as format `draft`, and a constructed room
 *     never does (`games/magic/server/src/http/routes.ts`, "A pod's tables play a
 *     DRAFTED pool") — so Constructed is the four constructed formats and Draft
 *     pod is `draft`, for every match ever recorded, with no attr to add.
 *   - **Each row draws the deck's colours** and opens its list on hover with
 *     the room picker's own peek (`DeckPeek`, `usePeekHover`): a library deck
 *     by its catalog id, a drafted one (`draft:<podId>`) from the viewer's own
 *     decks. Another player's drafted deck is theirs to show, so it opens
 *     nothing.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { primeNamedArt } from '../screens/libraryPeek.ts';
import { Icon } from '@wolffm/themes';
import { formatAgo, formatAttr, formatRecord, formatWinRate, StatsCard, WinBar, type RenderAttr, type StatsCache } from '@wolffm/game-stats-ui';
import { winRate, type BreakdownRow, type GameStatsClient, type StatAttrs } from '@wolffm/prefs-client/games';

import { myDecksClient, type MyDecksClient } from '../deck/myDecks.ts';
import type { PeekedDeck } from '../screens/ConstructedScreen.tsx';
import { ChipFilterBar, toggled } from '../screens/DeckFilterBar.tsx';
import { DeckPeek, usePeekHover } from '../screens/DeckPeek.tsx';
import { FREE_PICK } from '@hadoku/shared';
import { FORMAT_TABS, tablesClient, type FormatFamily, type TablesClient } from '../screens/tables.ts';
import { uiLength } from '@hadoku/ui-shell/settings';
import { matchAttr, Pips } from './magic.tsx';
import { everyone, loaded, onePlayer } from './source.ts';

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
          label,
        })),
        ROOMS.map(({ id, label }) => ({
          testId: `stats-deck-room-${id}`,
          pressed: filter.rooms.has(id),
          disabled: id === 'draft' && filter.formats.size > 0,
          onToggle: () => onChange({ ...filter, rooms: toggled(filter.rooms, id) }),
          label,
        })),
      ]}
      search={{
        testId: 'stats-deck-text',
        placeholder: 'Deck',
        ariaLabel: 'Deck name',
        value: filter.text,
        onChange: (text) => onChange({ ...filter, text }),
        icon: <Icon name="magnifier" size={uiLength('0.95rem')} />,
      }}
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
    // A deck's list reads as the room's picker reads it. The room screen is a chunk of its own, and
    // the stats load without it.
    const room = await import('../screens/ConstructedScreen.tsx');
    if (deckId.startsWith(DRAFTED)) {
      drafted ??= mine.list();
      const podId = deckId.slice(DRAFTED.length);
      const d = (await drafted).find((deck) => deck.id === podId);
      if (d === undefined || d.deck === null) return null;
      const deck = room.openDraftedDeck(d.deck, d.id, d.pool);
      await primeNamedArt([...deck.main, ...deck.sideboard, ...deck.basics].map((e) => e.card));
      const option = room.draftedDeckOption(deckId, d.name, deck, d.pool);
      return option.list === undefined ? null : { label: option.label, colors: option.colors, list: option.list };
    }
    library ??= tables.decks();
    const d = (await library).find((deck) => deck.id === deckId);
    if (d === undefined) return null;
    await primeNamedArt([...d.main, ...d.sideboard]);
    return room.libraryDeckPeek(d);
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

/** A deck's name, which opens its list on hover, after its colours. */
function StatsDeckName({ name, carried }: { name: string; carried?: StatAttrs | undefined }) {
  const hover = useContext(DeckHoverContext);
  const deckId = typeof carried?.deckId === 'string' ? carried.deckId : undefined;
  const peekable = hover !== null && deckId !== undefined && hover.canPeek(deckId);
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
      <Pips colors={colorsOf(carried)} />
      <span className="ct-stats-deck__name">{name}</span>
    </span>
  );
}

/**
 * Every attr the page draws. A seat's `colors` is a set and a colour breakdown row is one colour;
 * both draw as pips. A deck row draws as its name and its pips; a seat's deck, its name. A match's
 * own attrs draw as its feed's meta line says them (`matchAttr`).
 */
export const renderAttr: RenderAttr = (key, value, carried) => {
  if (key === 'deck' && carried !== undefined) return <StatsDeckName name={String(value)} carried={carried} />;
  if (key === 'colors') return <Pips colors={Array.isArray(value) ? value : [String(value)]} />;
  if (key === 'deck') return formatAttr(value);
  return matchAttr(key, value);
};

/** How many rated games a deck needs before it can be called a winner. */
const WINNING_DECK_GAMES = 5;
/** How many winning decks the Leaderboard lists. */
const WINNING_DECKS = 6;

/** Everyone's decks with enough games behind them, best win rate first, the more played first on a tie. */
export function winningDecks(rows: readonly BreakdownRow[]): BreakdownRow[] {
  return rows
    .filter((r) => r.games >= WINNING_DECK_GAMES)
    .sort((a, b) => winRate(b) - winRate(a) || b.games - a.games)
    .slice(0, WINNING_DECKS);
}

/** The Leaderboard's Winning decks: everyone's rated games, a deck to a line, its win rate as a bar. */
export function WinningDecks({ client, cache }: { client: GameStatsClient; cache: StatsCache }) {
  return (
    <StatsCard
      title="Winning decks"
      subtitle={`${WINNING_DECK_GAMES}+ games`}
      {...loaded(everyone.decks(client))}
      cache={cache}
      isEmpty={(b) => winningDecks(b.rows).length === 0}
      testId="stats-winning-decks"
    >
      {(b) => (
        <ol className="ct-windecks">
          {winningDecks(b.rows).map((row) => (
            <li key={row.value} className="ct-windecks__deck" data-testid="stats-winning-deck">
              <span className="ct-windecks__line">
                <StatsDeckName name={row.value} carried={row.attrs} />
                <span className="ct-windecks__pct">{formatWinRate(row)}</span>
              </span>
              <span className="ct-windecks__line">
                <WinBar totals={row} />
                <span className="ct-windecks__games">{`${row.games} games`}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </StatsCard>
  );
}

/** A profile's Decks table: the player's rated games per deck, narrowed by the filter bar above it, most played first. */
export function DecksTable({ client, cache, player }: { client: GameStatsClient; cache: StatsCache; player?: string | undefined }) {
  const [filter, setFilter] = useState<DeckStatsFilter>(NO_STATS_FILTER);
  const shown = (rows: readonly BreakdownRow[]): BreakdownRow[] => [...filterDeckRows(rows, filter.text)].sort((a, b) => b.games - a.games || winRate(b) - winRate(a));
  const now = Date.now();
  return (
    <div className="ct-decks">
    <StatsCard
      title="Decks"
      actions={<DeckStatsFilterBar filter={filter} onChange={setFilter} />}
      {...loaded(onePlayer.decks(client, player, matchFormats(filter)))}
      cache={cache}
      isEmpty={(b) => shown(b.rows).length === 0}
      flush
      testId="stats-decks"
    >
      {(b) => (
        <div className="ct-stats__scroll">
          <table className="ct-stats__table" data-testid="stats-decks-table">
            <thead>
              <tr>
                <th scope="col">Deck</th>
                <th scope="col" className="ct-stats__num ct-stats__games">
                  Games
                </th>
                <th scope="col" className="ct-stats__num ct-stats__record">
                  W–L
                </th>
                <th scope="col" className="ct-stats__rate">
                  Win rate
                </th>
                <th scope="col" className="ct-stats__num ct-stats__last">
                  Last played
                </th>
              </tr>
            </thead>
            <tbody>
              {shown(b.rows).map((row) => (
                <tr key={row.value}>
                  <td>
                    <StatsDeckName name={row.value} carried={row.attrs} />
                  </td>
                  <td className="ct-stats__num ct-stats__games">{row.games}</td>
                  <td className="ct-stats__num ct-stats__record">{formatRecord(row)}</td>
                  <td className="ct-stats__rate">
                    <span className="ct-winrate">
                      <WinBar totals={row} />
                      <span className="ct-winrate__pct">{formatWinRate(row)}</span>
                    </span>
                  </td>
                  <td className="ct-stats__num ct-stats__last">{row.lastPlayedAt === undefined ? '' : formatAgo(row.lastPlayedAt, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </StatsCard>
    </div>
  );
}
