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
 * (`pod/client.ts`'s `playPod`) and goes to the room. The last drafter's press
 * deals round 1, and the pod screen starts each table's game by itself — a pod
 * of one plays the AI. Draft, build, Play, the game: no room to make and
 * nothing to choose (the operator, 2026-10-18). A refusal stays on the build
 * and says why.
 *
 * ## The pod
 *
 * A finished draft lands here with no screen in between (`PodScreen.tsx`), so
 * the pod's `building` phase is drawn here too, as one strip over the editor:
 * who has pressed Play (`pod/PodBuilding.tsx`). Once the pod is in `rounds`
 * this hands the drafter back to the room, whose pod screen seats them at
 * their table.
 *
 * `store`, `client` and `podSource` exist for tests. `App.tsx` passes none of
 * them, so production gets the real API.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { DeckEditor } from '../deck/DeckEditor.tsx';
import { deckStoreClient, type DeckStoreClient, type Mine } from '../deck/deckStore.ts';
import { BackLink } from './BackLink.tsx';
import { navigate } from './route.ts';
import { DeckManage } from './DeckManage.tsx';
import { myDecksClient, type MyDeck, type MyDecksClient } from '../deck/myDecks.ts';
import { livePodSource, myCurrentTable, playPod, startMyTable, usePodContext, type PodSource } from './pod/client.ts';
import { followMatchOnce, followTableOnce, openNewMatch } from '../play/live/matchStart.ts';
import { roomsClient, type RoomsClient } from '../rooms/api.ts';
import { PodBuilding } from './pod/PodBuilding.tsx';
import { tablesClient, type TablesClient } from './tables.ts';
import { useChromeShell } from '../chrome/shell.ts';

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
  /** Read after Play, to go straight to the game when it can start. Tests pass a stub. */
  rooms?: RoomsClient;
}

type Loaded = { kind: 'no-seat' } | { kind: 'ready'; mine: Mine };

export function DeckScreen({
  draftId,
  store: givenStore,
  client: givenClient,
  checkDelayMs,
  saveDelayMs,
  podSource = livePodSource,
  standalone = false,
  decks: givenDecks,
  rooms: givenRooms,
}: DeckScreenProps) {
  const shellRef = useChromeShell('fit');
  const rooms = useMemo(() => givenRooms ?? roomsClient(), [givenRooms]);
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
  const rounds = pod?.phase === 'rounds';
  /** Play is deciding where this player goes: the hand-off to the room below waits for it. */
  const playing = useRef(false);
  useEffect(() => {
    if (rounds && !standalone && !playing.current) navigate({ kind: 'room', roomId: draftId }, { replace: true });
  }, [rounds, draftId, standalone]);

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
   * Play: saved, marked done, and then straight to wherever this player ends
   * up — the game itself when my table can start now (the last Play of the pod,
   * or a game against the AI), the room only while others are still building.
   * The operator, 2026-10-19: *"when clicking play we should look to see where
   * the player will end up, if they can go straight into the game then we
   * should put them there. if the other player isn't ready yet then we can
   * show the lobby"* — not three screens in a row.
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
      const room = await rooms.get(draftId).catch(() => null);
      const mine = room?.pod?.phase === 'rounds' ? myCurrentTable(room.pod, room.tables, room.you.id) : undefined;
      if (mine === undefined) return toRoom();
      // Straight past my table's page, which this stands in for: the hub has carried me there already.
      followTableOnce(draftId, mine.id, mine.id);
      if (mine.matchId !== null) return followMatchOnce(mine.matchId, false);
      const started = await startMyTable(draftId, mine);
      if (started.ok && started.matchId !== null) openNewMatch(started.matchId);
      // The other player's table page started it in the same moment, or it is still to start: my table's
      // page follows its game in. The hub would not carry me there, since the table counts as visited.
      else navigate({ kind: 'room', roomId: draftId, tableId: mine.id });
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
      {!standalone && ctx !== null && pod !== null && pod.phase === 'building' && (
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
