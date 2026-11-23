/*
 * `#/deck/<podId>` — build a deck out of the pool you drafted, and play it.
 *
 * ## Where the pool and the build come from
 *
 * `GET /api/drafts/:podId/mine` (C's contract, `docs/planning/wave70-2026-10-17.md`):
 * the caller's own drafted pool and their last saved `.dck`, resolved by the
 * same participant id the gate's draft arm uses — and it answers whether or
 * not the caller still holds a seat in the pod, through the 120 s hold and
 * past a server restart. That is new this wave, and it is what replaces the
 * live pod socket this screen used to open: a socket answers only while it is
 * connected, and the whole point of this route surviving a visit to the room
 * list and back is that it must not need one. `404` is the one refusal the
 * contract defines — the caller drafted no seat in this pod — and this screen
 * reads it as "you have no seat", the same sentence a spectator used to get
 * from the socket.
 *
 * Every move is saved back with `PUT …/deck`, debounced by `DeckEditor` itself
 * (`deck/deckStore.ts`'s `save`), so the build a reload finds is the build you
 * left, and so is the build the room screen's own picker offers
 * (`ConstructedScreen.tsx`'s `DRAFTED_DECK`) — both read the one `.dck` text C
 * stores.
 *
 * ## What is not here
 *
 * The piles, the basics and the way onward are `deck/DeckEditor.tsx`; the
 * pool→deck model is `deck/build.ts`. This file only decides whether there is
 * a pool to build from, and says so when there is not. It is a fitted screen
 * (`shell--fit`): the editor takes the whole window under the header and
 * scrolls inside itself, never the page.
 *
 * ## Play
 *
 * Play saves the build as it stands, says this drafter is done building
 * (`pod/client.ts`'s `playPod`, which seats the deck at their round's table)
 * and goes to the room. Round 1 was dealt when the draft ended, so the match is
 * waiting there. Draft, build, Play, the game: no room to make and nothing to
 * choose (the operator, 2026-10-18). A refusal stays on the build and says why.
 *
 * ## The pod
 *
 * A finished draft lands here with no screen in between (`PodScreen.tsx`), so
 * who has pressed Play is drawn here too, as one strip over the editor
 * (`pod/PodBuilding.tsx`), for as long as the pod is building or playing, so
 * it never appears under the build mid-edit. Once the pod is over this hands
 * the drafter back to the room.
 *
 * ## A deck built from nothing
 *
 * `#/decks/new` and `#/decks/built:<uuid>` open the same editor on no pool
 * (`BuiltDeckScreen`, below): a format (the eras a room offers, or "Any
 * card"), a card search over that format's sets (`GET /api/cards/search`)
 * whose answer is the editor's top area, then a name, Save and Delete
 * (`deck/builtDecks.ts`, over `/api/me/built`). Once saved, every move saves
 * itself like a drafted build does. The first save gives the deck its id, and
 * the address moves to it; the screen that remounts there opens on the very
 * state the first one left (`handoff`), not on a reload.
 *
 * `store`, `client` and `podSource` exist for tests. `App.tsx` passes none of
 * them, so production gets the real API.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CONSTRUCTED_LIMITS, type Deck } from '@hadoku/deck';
import { FREE_PICK } from '@hadoku/shared';

import { DeckEditor } from '../deck/DeckEditor.tsx';
import { builtSeat } from '../deck/build.ts';
import {
  builtDecksClient,
  cardSearch,
  facesForNames,
  isBuiltDeckId,
  type BuiltDeck,
  type BuiltDecksClient,
  type CardSearch,
} from '../deck/builtDecks.ts';
import { dckTextOf, savedBuild } from '../draft/deckFromPool.ts';
import type { DraftCard } from '../draft/types.ts';
import { FORMAT_TABS, erasOf, type TableFormat } from './tables.ts';
import { deckStoreClient, type DeckStoreClient, type Mine } from '../deck/deckStore.ts';
import { BackLink } from './BackLink.tsx';
import { navigate } from '@hadoku/game-ui/screens/route.ts';
import { DeckManage } from './DeckManage.tsx';
import { myDecksClient, type MyDeck, type MyDecksClient } from '../deck/myDecks.ts';
import { livePodSource, playPod, usePodContext, type PodSource } from './pod/client.ts';
import { PodBuilding } from './pod/PodBuilding.tsx';
import { tablesClient, type TablesClient } from './tables.ts';
import { useChromeShell } from '@hadoku/ui-shell/chrome/shell';

export interface DeckScreenProps {
  draftId: string;
  /** Tests pass a stub store over a stub fetch. Production leaves it undefined and gets the real API. */
  store?: DeckStoreClient;
  /** Tests pass a client over a stub fetch. Production passes nothing. */
  client?: TablesClient;
  /** Passed through to the editor; tests set 0. */
  checkDelayMs?: number;
  saveDelayMs?: number;
  /** Tests pass a stub. Production leaves it undefined and reads the room over the feed. */
  podSource?: PodSource;
  /**
   * Opened from the Decks page (`#/decks/<podId>`), outside any game: the
   * same build, saved the same way, with no Play, no pod status and no
   * hand-off to the room once its rounds start.
   */
  standalone?: boolean;
  /** The Decks page's client, for the standalone head's name, rename and delete. Tests pass a stub. */
  decks?: MyDecksClient;
  /** A built deck's store. Tests pass a client over a stub fetch. */
  built?: BuiltDecksClient;
  /** A built deck's card search. Tests pass a stub. */
  search?: CardSearch;
}

/** `#/decks/new`: a deck built from nothing, not yet saved. */
export const NEW_DECK = 'new';

/** The deck screen: a built deck's (`new` or `built:<uuid>`), or a drafted pool's. */
export function DeckScreen(props: DeckScreenProps) {
  return props.draftId === NEW_DECK || isBuiltDeckId(props.draftId) ? <BuiltDeckScreen {...props} /> : <PodDeckScreen {...props} />;
}

type Loaded = { kind: 'no-seat' } | { kind: 'ready'; mine: Mine };

function PodDeckScreen({
  draftId,
  store: givenStore,
  client: givenClient,
  checkDelayMs,
  saveDelayMs,
  podSource = livePodSource,
  standalone = false,
  decks: givenDecks,
}: DeckScreenProps) {
  const shellRef = useChromeShell('fit');
  const store = useMemo(() => givenStore ?? deckStoreClient(), [givenStore]);
  const client = useMemo(() => givenClient ?? tablesClient(), [givenClient]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoaded(null);
    setLoadError(null);
    store
      .mine(draftId)
      .then((mine) => {
        if (!live) return;
        setLoaded(mine === null ? { kind: 'no-seat' } : { kind: 'ready', mine });
      })
      .catch((err: unknown) => {
        if (live) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [draftId, store]);

  const ctx = usePodContext(draftId, podSource);
  const pod = ctx?.pod ?? null;
  const over = pod?.phase === 'done';
  /** Play is deciding where this player goes: the hand-off to the room below waits for it. */
  const playing = useRef(false);
  useEffect(() => {
    if (over && !standalone && !playing.current) navigate({ kind: 'room', roomId: draftId }, { replace: true });
  }, [over, draftId, standalone]);

  /** The standalone head's deck — its name, and whether it may be renamed — once the Decks list has answered. */
  const decksClient = useMemo(() => givenDecks ?? myDecksClient(), [givenDecks]);
  const [myDeck, setMyDeck] = useState<MyDeck | null>(null);
  useEffect(() => {
    if (!standalone) return;
    let live = true;
    decksClient.list().then(
      (all) => {
        if (live) setMyDeck(all.find((d) => d.id === draftId) ?? null);
      },
      (err: unknown) => console.warn('[cardtable] the deck’s name is unavailable; the editor still opens', err),
    );
    return () => {
      live = false;
    };
  }, [standalone, decksClient, draftId]);

  const [playError, setPlayError] = useState<string | null>(null);
  // The build as it stands is saved first: the editor's own save is debounced,
  // and the pod seats whatever was saved last.
  /**
   * Play: saved, marked done, and then to the room's page: the bracket, every match, and mine lit
   * once it is ready (the operator, 2026-11-19: *"the main room page should be the default landing
   * zone for whenever things are done. after building and after finishing a match it would be nice
   * to go back there. then when your next match is ready it should light up"*). It starts no game
   * and walks into none: the table's page does the first, the player's own press the second.
   */
  const play = (dck: string): void => {
    setPlayError(null);
    playing.current = true;
    const toRoom = (): void => navigate({ kind: 'room', roomId: draftId });
    const fail = (message: string): void => {
      playing.current = false;
      setPlayError(message);
    };
    void (async () => {
      const saved = await store.save(draftId, dck);
      if (!saved.ok) return fail(saved.issues.join(' '));
      const marked = await playPod(draftId);
      if (!marked.ok) return fail(marked.message ?? 'The pod refused that.');
      // The room's page is where everything lands: the bracket, and my own match lit on it once it is ready.
      toRoom();
    })().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div ref={shellRef} className="shell shell--fit deck-screen" data-testid="deck">
      {standalone && (
        <nav className="shell__head">
          <BackLink to={{ kind: 'decks' }} label="Decks" testId="back-to-decks" />
          {myDeck !== null && (
            <DeckManage deck={myDeck} client={decksClient} onRenamed={setMyDeck} onDeleted={() => navigate({ kind: 'decks' })} />
          )}
        </nav>
      )}
      {!standalone && ctx !== null && pod !== null && (pod.phase === 'building' || pod.phase === 'rounds') && (
        <PodBuilding pod={pod} nameOf={(id) => ctx.names[id] ?? id} />
      )}

      {loadError !== null && (
        <p className="ct-error" role="alert" data-testid="deck-load-error">
          Could not load your pool: {loadError}
        </p>
      )}

      {playError !== null && (
        <p className="ct-error deck-screen__error" role="alert" data-testid="deck-play-error">
          {playError}
        </p>
      )}

      {loadError === null && loaded !== null && loaded.kind === 'ready' ? (
        <DeckEditor
          mode="limited"
          draftId={draftId}
          pool={loaded.mine.pool}
          savedDeck={loaded.mine.deck}
          client={client}
          checkDelayMs={checkDelayMs}
          saveDelayMs={saveDelayMs}
          onSave={(dck) =>
            store.save(draftId, dck).then((outcome) => (outcome.ok ? { ok: true } : { ok: false, issues: outcome.issues }))
          }
          onPlay={standalone ? undefined : play}
        />
      ) : (
        loadError === null && (
          <main className="lobby">
            <section className="lobby__card" data-testid={loaded === null ? 'deck-joining' : 'deck-no-seat'}>
              {loaded === null && <h2>Fetching your pool</h2>}
              {loaded !== null && loaded.kind === 'no-seat' && <h2>You have no seat in this pod</h2>}
              {!standalone && (
                <button
                  type="button"
                  className="lobby__go"
                  data-testid="back-to-pod"
                  onClick={() => navigate({ kind: 'draft', draftId })}
                >
                  Back to the pod
                </button>
              )}
            </section>
          </main>
        )
      )}
    </div>
  );
}

/* ── a deck built from nothing ───────────────────────────────────────── */

/** What a new deck is called until it is named. */
const NEW_DECK_NAME = 'New deck';

/** How long typing rests before the search is asked. */
const SEARCH_DELAY_MS = 250;

/** One screen's state, handed to the screen the first save remounts it as (see the header). */
interface Handoff {
  deck: BuiltDeck;
  dck: string;
  faces: readonly DraftCard[];
  query: string;
  results: readonly DraftCard[];
}
const handoff = new Map<string, Handoff>();

type BuiltLoad = { kind: 'loading' } | { kind: 'missing' } | { kind: 'ready'; stored: BuiltDeck | null; dck: string | null; faces: readonly DraftCard[] };

type BuiltSaveState = 'idle' | 'saving' | 'saved' | 'error';

function BuiltDeckScreen({ draftId, client: givenClient, built: givenBuilt, search: givenSearch, checkDelayMs, saveDelayMs }: DeckScreenProps) {
  const shellRef = useChromeShell('fit');
  const client = useMemo(() => givenClient ?? tablesClient(), [givenClient]);
  const store = useMemo(() => givenBuilt ?? builtDecksClient(), [givenBuilt]);
  const search = useMemo(() => givenSearch ?? cardSearch(), [givenSearch]);
  const handed = useMemo(() => handoff.get(draftId), [draftId]);
  useEffect(() => {
    handoff.delete(draftId);
  }, [draftId]);

  /** The eras a room offers, and "Any card". */
  const [formats, setFormats] = useState<TableFormat[] | null>(null);
  useEffect(() => {
    let live = true;
    client.formats().then(
      (all) => {
        if (live) setFormats(all);
      },
      (err: unknown) => {
        console.warn('[cardtable] the formats are unavailable; a built deck offers Any card alone', err);
        if (live) setFormats([]);
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  const [load, setLoad] = useState<BuiltLoad>(() =>
    handed !== undefined
      ? { kind: 'ready', stored: handed.deck, dck: handed.dck, faces: handed.faces }
      : draftId === NEW_DECK
        ? { kind: 'ready', stored: null, dck: null, faces: [] }
        : { kind: 'loading' },
  );
  const [name, setName] = useState(handed?.deck.name ?? NEW_DECK_NAME);
  const [format, setFormat] = useState(handed?.deck.format ?? FREE_PICK);
  const [loadError, setLoadError] = useState<string | null>(null);

  const setsOf = useCallback((id: string): string[] => formats?.find((f) => f.id === id)?.sets ?? [], [formats]);

  // A saved deck: its text, then the faces of its cards, asked of the search by name.
  useEffect(() => {
    if (load.kind !== 'loading' || formats === null) return;
    let live = true;
    void (async () => {
      const all = await store.list();
      const stored = all.find((d) => d.id === draftId);
      if (stored === undefined) {
        if (live) setLoad({ kind: 'missing' });
        return;
      }
      const deck = savedBuild(stored.dck, true);
      const names = deck === null ? [] : deck.main.map((e) => e.card.name);
      const sets = formats.find((f) => f.id === stored.format)?.sets ?? [];
      const faces = await facesForNames(search, names, stored.format === FREE_PICK ? [] : sets);
      if (!live) return;
      setName(stored.name);
      setFormat(stored.format);
      setLoad({ kind: 'ready', stored, dck: stored.dck, faces });
    })().catch((err: unknown) => {
      if (live) setLoadError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      live = false;
    };
  }, [load.kind, formats, store, draftId, search]);

  /* ── the search ── */
  const [query, setQuery] = useState(handed?.query ?? '');
  const [results, setResults] = useState<readonly DraftCard[]>(handed?.results ?? []);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searched = useRef(handed === undefined ? null : `${handed.query}|${handed.deck.format}`);
  useEffect(() => {
    const q = query.trim();
    const asked = `${q}|${format}`;
    if (searched.current === asked) return;
    if (q === '') {
      searched.current = asked;
      setResults([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      search(q, format === FREE_PICK ? [] : setsOf(format)).then(
        (cards) => {
          if (!live) return;
          searched.current = asked;
          setSearchError(null);
          setResults(cards);
        },
        (err: unknown) => {
          if (live) setSearchError(err instanceof Error ? err.message : String(err));
        },
      );
    }, SEARCH_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, format, search, setsOf]);

  /* ── save and delete ── */
  const stored = load.kind === 'ready' ? load.stored : null;
  const deckRef = useRef<Deck | null>(null);
  const faces = useRef<readonly DraftCard[]>([]);
  const [saveState, setSaveState] = useState<BuiltSaveState>(stored === null ? 'idle' : 'saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const dckOf = (deck: Deck | null, as: string): string => dckTextOf({ ...(deck ?? savedBuild(load.kind === 'ready' ? load.dck : null, true) ?? { main: [], sideboard: [], basics: [] }), name: as });
  const trimmed = name.trim();

  const save = (): void => {
    if (trimmed === '') return;
    setSaveState('saving');
    setSaveError(null);
    const dck = dckOf(deckRef.current, trimmed);
    void store.save({ ...(stored === null ? {} : { id: stored.id }), name: trimmed, format, dck }).then((out) => {
      if (!out.ok) {
        setSaveState('error');
        setSaveError(out.message);
        return;
      }
      setSaveState('saved');
      if (stored === null) {
        handoff.set(out.deck.id, { deck: out.deck, dck, faces: faces.current, query, results });
        navigate({ kind: 'decks', draftId: out.deck.id }, { replace: true });
      } else setLoad((l) => (l.kind === 'ready' ? { ...l, stored: out.deck } : l));
    });
  };

  // A stored deck saves its own moves, as a drafted build does; a name or a format is saved by Save.
  const onSave = useCallback(
    (dck: string) => {
      if (stored === null) return Promise.resolve({ ok: true as const });
      const deck = savedBuild(dck, true);
      if (deck === null) return Promise.resolve({ ok: false as const, issues: ['This deck cannot be read back.'] });
      const named = dckTextOf({ ...deck, name: stored.name });
      return store.save({ id: stored.id, name: stored.name, format: stored.format, dck: named }).then((out) => (out.ok ? { ok: true as const } : { ok: false as const, issues: [out.message] }));
    },
    [stored, store],
  );

  const [arming, setArming] = useState(false);
  const remove = (): void => {
    if (stored === null) return;
    if (!arming) {
      setArming(true);
      return;
    }
    setSaveState('saving');
    void store.remove(stored.id).then((out) => {
      if (out.ok) navigate({ kind: 'decks' });
      else {
        setArming(false);
        setSaveState('error');
        setSaveError(out.message);
      }
    });
  };

  const changed = stored !== null && (trimmed !== stored.name || format !== stored.format);
  const seatOf = useCallback((deck: Deck) => builtSeat(format, deck), [format]);
  const onChange = useCallback(
    (deck: Deck): void => {
      deckRef.current = deck;
    },
    [],
  );
  // The faces the editor may need again after the first save remounts it: a saved deck's, and every result shown.
  useEffect(() => {
    if (load.kind !== 'ready') return;
    const byName = new Map<string, DraftCard>();
    for (const f of [...faces.current, ...load.faces, ...results]) if (!byName.has(f.name)) byName.set(f.name, f);
    faces.current = [...byName.values()];
  }, [load, results]);

  const fault = loadError ?? saveError ?? searchError;

  return (
    <div ref={shellRef} className="shell shell--fit deck-screen" data-testid="deck" data-built-save={saveState}>
      <nav className="shell__head deck-built__head">
        <BackLink to={{ kind: 'decks' }} label="Decks" testId="back-to-decks" />
        <input
          className="deck-built__name"
          data-testid="built-name"
          aria-label="deck name"
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <FormatSelect formats={formats} value={format} onChange={setFormat} />
        <button
          type="button"
          className="deck-built__save"
          data-testid="built-save"
          disabled={trimmed === '' || saveState === 'saving' || (stored !== null && !changed && saveState === 'saved')}
          onClick={save}
        >
          {stored !== null && !changed && saveState === 'saved' ? 'Saved' : 'Save'}
        </button>
        {stored !== null && (
          <button type="button" className="deck-built__delete" data-testid="built-delete" data-armed={arming ? '' : undefined} onClick={remove} onBlur={() => setArming(false)}>
            {arming ? 'Delete?' : 'Delete'}
          </button>
        )}
      </nav>
      {fault !== null && (
        <p className="ct-error deck-screen__error" role="alert" data-testid="built-error">
          {fault}
        </p>
      )}
      {load.kind === 'ready' ? (
        <DeckEditor
          mode="build"
          draftId={stored?.id ?? NEW_DECK}
          pool={results}
          deckFaces={load.faces}
          savedDeck={load.dck}
          client={client}
          checkDelayMs={checkDelayMs}
          saveDelayMs={saveDelayMs}
          onSave={stored === null ? undefined : onSave}
          onChange={onChange}
          seatOf={seatOf}
          minMain={CONSTRUCTED_LIMITS.minMainDeckSize}
          poolHead={
            <label className="deck-built__search">
              <svg className="deck-built__search-glyph" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <path d="M10.4 10.4 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <input type="search" data-testid="card-search" aria-label="search cards" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
          }
        />
      ) : (
        loadError === null && (
          <main className="lobby">
            <section className="lobby__card" data-testid={load.kind === 'loading' ? 'built-loading' : 'built-missing'}>
              {load.kind === 'loading' ? <h2>Fetching your deck</h2> : <h2>No such deck</h2>}
            </section>
          </main>
        )
      )}
    </div>
  );
}

/** The formats a built deck may be for: "Any card", then each family's eras, newest first. */
function FormatSelect({ formats, value, onChange }: { formats: readonly TableFormat[] | null; value: string; onChange: (id: string) => void }) {
  return (
    <select className="deck-built__format" data-testid="built-format" aria-label="format" value={value} disabled={formats === null} onChange={(e) => onChange(e.target.value)}>
      <option value={FREE_PICK}>Any card</option>
      {FORMAT_TABS.map((tab) => {
        const eras = erasOf(formats ?? [], tab.id);
        return eras.length === 0 ? null : (
          <optgroup key={tab.id} label={tab.label}>
            {eras.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}
