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

import { useEffect, useMemo, useState } from 'react';

import { DeckEditor } from '../deck/DeckEditor.tsx';
import { deckStoreClient, type DeckStoreClient, type Mine } from '../deck/deckStore.ts';
import { navigate } from './route.ts';
import { livePodSource, playPod, usePodContext, type PodSource } from './pod/client.ts';
import { PodBuilding } from './pod/PodBuilding.tsx';
import { tablesClient, type TablesClient } from './tables.ts';

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
}

type Loaded = { kind: 'no-seat' } | { kind: 'ready'; mine: Mine };

export function DeckScreen({
  draftId,
  store: givenStore,
  client: givenClient,
  checkDelayMs,
  saveDelayMs,
  podSource = livePodSource,
}: DeckScreenProps) {
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
  useEffect(() => {
    if (rounds) navigate({ kind: 'room', roomId: draftId }, { replace: true });
  }, [rounds, draftId]);

  const [playError, setPlayError] = useState<string | null>(null);
  // The build as it stands is saved first: the editor's own save is debounced,
  // and the pod seats whatever was saved last.
  const play = (dck: string): void => {
    setPlayError(null);
    store
      .save(draftId, dck)
      .then((saved) => {
        if (!saved.ok) {
          setPlayError(saved.issues.join(' '));
          return;
        }
        // Done building: to the room, which (re)joins it. While others are
        // still building, the pod screen hands this one back here; once rounds
        // start it starts their table.
        return playPod(draftId).then((r) => {
          if (r.ok) navigate({ kind: 'room', roomId: draftId });
          else setPlayError(r.message);
        });
      })
      .catch((err: unknown) => setPlayError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="shell shell--fit deck-screen" data-testid="deck">
      {ctx !== null && pod !== null && pod.phase === 'building' && (
        <PodBuilding pod={pod} nameOf={(id) => ctx.names[id] ?? id} />
      )}

      {loadError !== null && (
        <p className="lobby__error" role="alert" data-testid="deck-load-error">
          Could not load your pool: {loadError}
        </p>
      )}

      {playError !== null && (
        <p className="lobby__error deck-screen__error" role="alert" data-testid="deck-play-error">
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
          onPlay={play}
        />
      ) : (
        loadError === null && (
          <main className="lobby">
            <section className="lobby__card" data-testid={loaded === null ? 'deck-joining' : 'deck-no-seat'}>
              {loaded === null && <h2>Fetching your pool</h2>}
              {loaded !== null && loaded.kind === 'no-seat' && <h2>You have no seat in this pod</h2>}
              <button
                type="button"
                className="lobby__go"
                data-testid="back-to-pod"
                onClick={() => navigate({ kind: 'draft', draftId })}
              >
                Back to the pod
              </button>
            </section>
          </main>
        )
      )}
    </div>
  );
}
