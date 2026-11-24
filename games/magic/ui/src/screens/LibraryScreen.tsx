/*
 * `#/library` — the Library (wave 125): Decks, Cubes and Cards, one page from one lobby button.
 * `#/decks` and `#/inventory`, the two pages it replaced, move to their tab (`Screen.tsx`).
 *
 * ## Decks
 *
 * Every deck you built (`builtDecks.ts`) and every draft you finished, in one grid of the room's
 * own deck tiles (`DeckChooser`), in three sections (the operator, 2026-11-23): Favourites, then
 * Your decks (built, or a drafted deck you renamed, rebuilt, starred or played outside its
 * tournament), then From drafts (untouched, muted), each sorted by last played unless another sort
 * is picked. A drafted deck whose tournament still runs is not yours yet: it wears the "In
 * tournament" chip and offers no delete. Every tile has a star (`favourites.ts`). The filter row
 * is the room's colours and one text box (a deck's name, a card in it, or its cube or set), with the sort beside it.
 * "Last played" is the server's own stamp (`games/magic/server/src/stats/index.ts`), read from the
 * person's document with their favourites and built decks (`GET /api/me/library`): nothing on this
 * page reads Cloudflare for it. The W–L on each tile is the stats store's, as it always was.
 *
 * Nothing but the tiles' outlines is drawn until the decks, their records, every tile's art and
 * its credit have all arrived — art landing a second after its tile is the flash the operator
 * asked never to see (2026-10-19).
 *
 * ## Cubes
 *
 * Every cube (`#/inventory` before), each with how many of your decks were drafted from it, which
 * opens the Decks tab with the cube's name in its text box. An imported cube is refreshed, deleted (its importer only)
 * and imported here, never in a room (AF305 §B, the operator 2026-10-22: "when i'm in a room i
 * wouldn't want to mess with the refresh state of the cube").
 *
 * ## Cards
 *
 * Which printing each of your cards is drawn as (`LibraryCards.tsx`): search a card, open its
 * printings, pick one or reset it to the default. The picks are the server's (`GET`/`PUT /api/me/art`).
 */

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@wolffm/themes';
import { parseDck } from '@hadoku/carddata/dck';
import { deckColorsByName } from '@hadoku/deck';
import { LIBRARY_CARD_COSTS } from '@hadoku/deck/library';
import { cubePoolKey, type CubeListing, type ImportCubeBody } from '@hadoku/shared';
import { navigate, routeHash, type LibraryTab } from '@hadoku/game-ui/screens/route.ts';
import { useChromeShell } from '@hadoku/ui-shell/chrome/shell';
import { uiLength } from '@hadoku/ui-shell/settings';

import { myDecksClient, type MyDeck, type MyDecksClient } from '../deck/myDecks.ts';
import type { BuiltDeck } from '../deck/builtDecks.ts';
import { favouritesClient, type FavouritesClient, type MyLibrary } from '../deck/favourites.ts';
import { useArtLoaded } from '../draft/useArtLoaded.ts';
import { useArtistLookup } from '../draft/artists.ts';
import { cardsCount } from '../draft/PoolPicker.tsx';
import { CubeArt } from '../draft/CubeArt.tsx';
import { ImportCube } from '../draft/ImportCube.tsx';
import { usePoolFavourites, type PoolFavourites } from '../draft/poolFavourites.ts';
import { DEFAULT_POOL_SORT, sortPools, type PoolSort } from '../draft/poolSort.ts';
import { PoolSortBar, PoolStar } from '../draft/PoolSortBar.tsx';
import { poolsClient, type PoolsClient } from '../rooms/api.ts';
import { latestReads } from '../rooms/latest.ts';
import type { DeckRecords } from '../stats/deckOrder.ts';
import { fetchDeckRecords } from '../stats/source.ts';
import { DeckChooser, draftedDeckOption, openDraftedDeck, type DeckOption } from './ConstructedScreen.tsx';
import { assignDeckArt, libraryDeckArt } from './deckArt.ts';
import { DeckFilterBar } from './DeckFilterBar.tsx';
import { DeleteConfirm } from './DeckManage.tsx';
import {
  NO_DECK_FILTER,
  libraryDeckPasses,
  librarySections,
  playedLine,
  type DeckFilter,
  type LibraryEntry,
  type LibrarySection,
  type LibrarySort,
} from './deckFilter.ts';
import { HomeHead } from './HomeHead.tsx';
import { LibraryCards } from './LibraryCards.tsx';
import { libraryPeekList, useNamedArt } from './libraryPeek.ts';
import './LibraryScreen.css';
import '@hadoku/game-ui/components/Button.css';

export interface LibraryScreenProps {
  /** The route's tab; absent, Decks. */
  tab?: LibraryTab | undefined;
  /** A cube's name, which the Decks tab's text box starts with (the Cubes tab's "N decks" link). */
  cube?: string | undefined;
  /** Tests pass stubs. Production passes nothing. */
  decks?: MyDecksClient;
  deckRecords?: () => Promise<DeckRecords>;
  library?: FavouritesClient;
  pools?: PoolsClient;
}

/** The stats id a drafted deck's games are reported under (`games/magic/server/src/http/routes.ts`'s `draftedDeckId`). */
export const draftedDeckStatsId = (podId: string): string => `draft:${podId}`;

const TABS: readonly { tab: LibraryTab | undefined; id: string; label: string }[] = [
  { tab: undefined, id: 'decks', label: 'Decks' },
  { tab: 'cubes', id: 'cubes', label: 'Cubes' },
  { tab: 'cards', id: 'cards', label: 'Cards' },
];

const SECTION_TITLE: Record<LibrarySection, string> = { favourites: 'Favourites', yours: 'Your decks', drafts: 'From drafts' };
/** The box names everything it matches. */
const LIBRARY_SEARCH = { placeholder: 'Deck, card or cube', ariaLabel: 'Deck name, card or cube' } as const;

const SORTS: readonly { sort: LibrarySort; label: string }[] = [
  { sort: 'played', label: 'Last played' },
  { sort: 'winrate', label: 'Win rate' },
  { sort: 'name', label: 'Name' },
  { sort: 'newest', label: 'Newest' },
];

/** One tile: what it draws, and what the Library sorts it by. */
export interface LibraryTile extends LibraryEntry {
  option: DeckOption;
  /** Its stats and document id: `draft:<podId>` or `built:<uuid>`. */
  deckId: string;
  /** The drafted deck behind it, for its delete. */
  drafted?: MyDeck;
  cube?: string;
}

/** A built deck as a tile: its list by name, as a library deck's is. */
function builtDeckOption(deck: BuiltDeck): DeckOption {
  const file = parseDck(deck.dck);
  const lines = (section: string) => (file.sections.get(section) ?? []).map((e) => ({ name: e.card.name, count: e.count, set: e.card.set ?? undefined }));
  const list = libraryPeekList(lines('main'), lines('sideboard'));
  return {
    value: deck.id,
    label: deck.name,
    colors: deckColorsByName(
      list.main.map((l) => l.name),
      LIBRARY_CARD_COSTS,
    ),
    list,
    art: libraryDeckArt(list),
  };
}

/** Every deck as a tile, art chosen over the whole page so no two tiles repeat a card. */
export function libraryTiles(decks: readonly MyDeck[], library: MyLibrary, records: DeckRecords): LibraryTile[] {
  const recordOf = (deckId: string) => records.get(deckId) ?? { games: 0, wins: 0, losses: 0, draws: 0 };
  const tile = (deckId: string, option: DeckOption, entry: Omit<LibraryEntry, 'favourite' | 'lastPlayedAt' | 'games' | 'wins'>): LibraryTile => {
    const record = recordOf(deckId);
    const favourite = library.favourites.has(deckId);
    const lastPlayedAt = library.lastPlayed.get(deckId) ?? null;
    return {
      ...entry,
      deckId,
      favourite,
      // A star makes a deck yours this moment, before the server next says so.
      touched: entry.touched || favourite,
      lastPlayedAt,
      games: record.games,
      wins: record.wins,
      option: { ...option, pilot: `${record.wins}–${record.losses} · ${playedLine({ kind: entry.kind, lastPlayedAt, createdAt: entry.createdAt })}` },
    };
  };
  const tiles = [
    ...library.built.map((b) => tile(b.id, builtDeckOption(b), { kind: 'built', name: b.name, touched: true, inTournament: false, createdAt: b.createdAt })),
    ...decks.map((d) => ({
      ...tile(draftedDeckStatsId(d.id), draftedDeckOption(d.id, d.name, openDraftedDeck(d.deck, d.id, d.pool), d.pool, d.coverArtId), {
        kind: 'drafted',
        name: d.name,
        touched: d.touched,
        inTournament: d.inTournament,
        createdAt: d.createdAt,
      }),
      drafted: d,
      cube: d.cube,
    })),
  ];
  const artIds = assignDeckArt(tiles.map((t) => t.option.art ?? []));
  return tiles.map((t, i) => ({ ...t, option: { ...t.option, artId: artIds[i] } }));
}

/**
 * Whether every one of these pieces of art can be drawn with its credit on
 * the first frame: the art itself (`useArtLoaded`), and the artist table,
 * since `DeckArt` shows art only once it can credit it. `null` is "not known
 * yet", never ready.
 */
function useArtDrawable(artIds: readonly (string | undefined)[] | null): boolean {
  const loaded = useArtLoaded(artIds);
  const credits = useArtistLookup(artIds !== null && artIds.some((id) => id !== undefined));
  return loaded && (artIds === null || artIds.every((id) => id === undefined) || credits !== undefined);
}

const defaultPools = poolsClient();

export function LibraryScreen({ tab, cube, decks: givenDecks, deckRecords = fetchDeckRecords, library: givenLibrary, pools = defaultPools }: LibraryScreenProps) {
  const shellRef = useChromeShell('fit');
  const decksClient = useMemo(() => givenDecks ?? myDecksClient(), [givenDecks]);
  const libraryClient = useMemo(() => givenLibrary ?? favouritesClient(), [givenLibrary]);
  const [decks, setDecks] = useState<MyDeck[] | null>(null);
  const [records, setRecords] = useState<DeckRecords | null>(null);
  const [library, setLibrary] = useState<MyLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    decksClient
      .list()
      .then((d) => live && setDecks(d))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    deckRecords()
      .then((r) => live && setRecords(r))
      .catch((err: unknown) => {
        // A record is a garnish: without the stats service the decks still open, at 0–0.
        console.warn('[cardtable] deck records are unavailable', err);
        if (live) setRecords(new Map());
      });
    libraryClient
      .library()
      .then((l) => live && setLibrary(l))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [decksClient, deckRecords, libraryClient]);

  const decksCount = decks === null || library === null ? undefined : decks.length + library.built.length;

  return (
    <div ref={shellRef} className="shell shell--fit library" data-testid="library">
      <HomeHead title="Library">
        <nav className="library__tabs" aria-label="Library sections">
          {TABS.map((t) => (
            <a
              key={t.id}
              className="library__tab"
              href={routeHash(t.tab === undefined ? { kind: 'library' } : { kind: 'library', tab: t.tab })}
              aria-current={t.tab === tab ? 'page' : undefined}
              data-testid={`library-tab-${t.id}`}
            >
              {t.label}
              {t.id === 'decks' && decksCount !== undefined && <span className="library__count">{decksCount}</span>}
            </a>
          ))}
        </nav>
      </HomeHead>
      <main className="lobby lobby--room">
        {error !== null && (
          <p className="ct-error" role="alert" data-testid="library-error">
            {error}
          </p>
        )}
        {tab === undefined && error === null && (
          <DecksTab
            decks={decks}
            records={records}
            library={library}
            cube={cube}
            decksClient={decksClient}
            libraryClient={libraryClient}
            onDeleted={(id) => setDecks((held) => held?.filter((d) => d.id !== id) ?? null)}
            onStarred={(deckId, on) =>
              setLibrary((held) => {
                if (held === null) return held;
                const favourites = new Set(held.favourites);
                if (on) favourites.add(deckId);
                else favourites.delete(deckId);
                return { ...held, favourites };
              })
            }
            onFault={setError}
          />
        )}
        {tab === 'cubes' && <CubesTab pools={pools} decks={decks} />}
        {tab === 'cards' && <LibraryCards />}
      </main>
    </div>
  );
}

function DecksTab({
  decks,
  records,
  library,
  cube,
  decksClient,
  libraryClient,
  onDeleted,
  onStarred,
  onFault,
}: {
  decks: MyDeck[] | null;
  records: DeckRecords | null;
  library: MyLibrary | null;
  cube: string | undefined;
  decksClient: MyDecksClient;
  libraryClient: FavouritesClient;
  onDeleted: (podId: string) => void;
  onStarred: (deckId: string, on: boolean) => void;
  onFault: (message: string) => void;
}) {
  // A basic's or a built deck's art is the server's answer for its name: drawn again when it arrives.
  const namedArt = useNamedArt();
  const tiles = useMemo(
    () => (decks === null || records === null || library === null ? null : libraryTiles(decks, library, records)),
    [decks, records, library, namedArt],
  );
  const drawable = useArtDrawable(useMemo(() => tiles?.map((t) => t.option.artId) ?? null, [tiles]));
  const ready = drawable && tiles !== null;

  // A cube's "N decks" link (`#/library/cube/<name>`) opens this tab with its name in the box.
  const [filter, setFilter] = useState<DeckFilter>(() => ({ ...NO_DECK_FILTER, text: cube ?? '' }));
  useEffect(() => {
    if (cube !== undefined) setFilter((held) => ({ ...held, text: cube }));
  }, [cube]);
  const [sort, setSort] = useState<LibrarySort>('played');
  const sections = useMemo(
    () =>
      ready
        ? librarySections(
            tiles.filter((t) => libraryDeckPasses({ ...t.option, name: t.name, cube: t.cube }, filter)),
            sort,
          )
        : [],
    [ready, tiles, filter, sort],
  );

  const star = (t: LibraryTile): void => {
    const on = !t.favourite;
    onStarred(t.deckId, on);
    void libraryClient.setFavourite(t.deckId, on).then((r) => {
      if (r.ok) return;
      onStarred(t.deckId, !on);
      onFault(r.message);
    });
  };

  const tileAction = (byValue: ReadonlyMap<string, LibraryTile>) => (option: DeckOption) => {
    const t = byValue.get(option.value);
    if (t === undefined) return null;
    return (
      <>
        <span className="library__marks">
          <button
            type="button"
            className="library__star"
            aria-pressed={t.favourite}
            aria-label={t.favourite ? `Unstar ${t.name}` : `Star ${t.name}`}
            data-testid="library-tile-star"
            onClick={() => star(t)}
          >
            <Icon name="star" size={uiLength('0.9rem')} />
          </button>
          {t.inTournament && (
            <span className="library__locked" data-testid="library-tile-locked">
              <Icon name="lock" size={uiLength('0.7rem')} />
              In tournament
            </span>
          )}
        </span>
        {t.drafted !== undefined && !t.inTournament && (
          <DeleteConfirm deck={t.drafted} client={decksClient} onDeleted={() => onDeleted(t.drafted!.id)} testId="decks-tile-delete" className="decks__tile-actions" />
        )}
      </>
    );
  };

  return (
    <section className="lobby__card lobby__decks library__decks">
      <div className="lobby__setsrow library__toolbar">
        <DeckFilterBar filter={filter} onChange={setFilter} styles={[]} search={LIBRARY_SEARCH} />
        <label className="library__sort">
          <span className="lobby__field">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as LibrarySort)} data-testid="library-sort">
            {SORTS.map((s) => (
              <option key={s.sort} value={s.sort}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="ct-action library__new" data-testid="library-new-deck" onClick={() => navigate({ kind: 'decks', draftId: 'new' })}>
          <Icon name="plus" size={uiLength('0.9rem')} />
          <span className="ct-action__label">New deck</span>
        </button>
      </div>
      <span className="lobby__field lobby__field--hidden" id="deck-mine-label">
        Your decks
      </span>
      {!ready && <DeckChooser options={[]} value="" disabled pending onChoose={() => undefined} />}
      {ready && sections.length === 0 && <DeckChooser options={[]} value="" disabled={false} empty={tiles.length === 0 ? 'No decks yet' : 'No decks'} onChoose={() => undefined} />}
      {sections.map(({ section, decks: inIt }) => {
        const byValue = new Map(inIt.map((t) => [t.option.value, t]));
        return (
          <div key={section} className={`library__section library__section--${section}`} data-testid={`library-section-${section}`}>
            <h2 className="library__section-title">
              {SECTION_TITLE[section]}
              <span className="library__count">{inIt.length}</span>
            </h2>
            <div className="library__grid">
              <DeckChooser
                options={inIt.map((t) => t.option)}
                value=""
                disabled={false}
                swapKey={section}
                onChoose={(id) => navigate({ kind: 'decks', draftId: id })}
                tileAction={tileAction(byValue)}
              />
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** "3 minutes ago", "4 hours ago", "5 days ago" — never the raw ISO string. `null` reads as "just now". */
function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return '';
  const ms = now - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function CubeCard({
  cube,
  decks,
  busy,
  stars,
  onRefresh,
  onDelete,
}: {
  cube: CubeListing;
  decks: number | undefined;
  busy: boolean;
  stars: PoolFavourites;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const key = cubePoolKey(cube.id);
  return (
    <div className="inventory__card poolsort__card" data-testid={`inventory-cube-${cube.id}`}>
      <CubeArt artId={cube.artId} name={cube.name} />
      <div className="inventory__body">
        <span className="inventory__name">{cube.name}</span>
        <span className="inventory__meta" data-testid={`inventory-meta-${cube.id}`}>
          {cardsCount(cube.size)}
          {cube.importerName !== null ? ` · ${cube.importerName}` : ''}
          {cube.refreshedAt !== null ? ` · refreshed ${relativeTime(cube.refreshedAt)}` : ''}
        </span>
        <span className="inventory__actions">
          {decks !== undefined && decks > 0 && (
            <a className="inventory__action ct-action" href={routeHash({ kind: 'library', cube: cube.name })} data-testid={`library-cube-decks-${cube.id}`}>
              <span className="ct-action__label">{decks === 1 ? '1 deck' : `${decks} decks`}</span>
            </a>
          )}
          {cube.origin === 'cubecobra' && (
            <button type="button" className="inventory__action ct-action" data-testid={`inventory-refresh-${cube.id}`} disabled={busy} onClick={() => onRefresh(cube.id)}>
              <span className="ct-action__label">Refresh</span>
            </button>
          )}
          {cube.mine && (
            <button type="button" className="inventory__action ct-action" data-testid={`inventory-delete-${cube.id}`} disabled={busy} onClick={() => onDelete(cube.id)}>
              <span className="ct-action__label">Delete</span>
            </button>
          )}
        </span>
      </div>
      <PoolStar name={cube.name} on={stars.favourites.has(key)} onToggle={() => stars.toggle(key)} />
    </div>
  );
}

/**
 * Every cube: the shortlist's (read-only, here only for the decks you drafted from them) and the
 * imported ones, managed. The room picker's bar is over them (`PoolSortBar`, wave 127 §D): one
 * search box and one Sort select, the caller's starred cubes first; Newest keeps the server's order.
 */
function CubesTab({ pools, decks }: { pools: PoolsClient; decks: MyDeck[] | null }) {
  const [cubes, setCubes] = useState<CubeListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stars = usePoolFavourites(pools);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<PoolSort>(DEFAULT_POOL_SORT);

  /** The list's reads, latest-wins (`../rooms/latest.ts`): every write is followed by a fresh read, so a read is kept or dropped. */
  const [reads] = useState(latestReads);
  const load = (): void => {
    const landed = reads.read();
    pools.listCubes().then(
      (list) => {
        if (landed() !== 'keep') return;
        setCubes(list);
        setError(null);
      },
      (e: unknown) => {
        if (landed() === 'keep') setError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  useEffect(() => void load(), []);

  const withWrite = (call: () => Promise<{ ok: true } | { ok: false; message: string }>): void => {
    setBusy(true);
    void call().then((r) => {
      setBusy(false);
      if (r.ok) load();
      else setError(r.message);
    });
  };
  const deckCount = (name: string): number | undefined => decks?.filter((d) => d.cube === name).length;
  // A shortlist cube has nothing to manage: it is listed only for the decks drafted from it.
  const listed = cubes?.filter((c) => c.origin !== 'shortlist' || (deckCount(c.name) ?? 0) > 0);
  const shown = listed === undefined ? undefined : sortPools(listed, (c) => cubePoolKey(c.id), { sort, query, favourites: stars.favourites });
  const fault = error ?? stars.error;

  return (
    <section className="lobby__card" data-testid="inventory">
      {fault !== null && (
        <p className="ct-error" role="alert" data-testid="inventory-error">
          {fault}
        </p>
      )}
      <PoolSortBar testId="library-cubes" query={query} onQuery={setQuery} sort={sort} onSort={setSort} search={{ placeholder: 'Search cubes', ariaLabel: 'Search cubes' }} />
      <div className="inventory__gallery">
        {shown?.map((cube) => (
          <CubeCard
            key={cube.id}
            cube={cube}
            decks={deckCount(cube.name)}
            busy={busy}
            stars={stars}
            onRefresh={(id) => withWrite(() => pools.refreshCube(id))}
            onDelete={(id) => withWrite(() => pools.deleteCube(id))}
          />
        ))}
        <ImportCube busy={busy} onImport={(source: ImportCubeBody) => withWrite(() => pools.importCube(source))} />
      </div>
    </section>
  );
}
