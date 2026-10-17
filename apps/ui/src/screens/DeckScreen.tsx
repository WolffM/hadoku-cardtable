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
 * The grid, the basics, the legality panel and the Play button are
 * `deck/DeckEditor.tsx`; the pool→deck model is `deck/build.ts`. This file only
 * decides whether there is a pool to build from, and says so in words when
 * there is not.
 *
 * ## Play
 *
 * The old builder's Start button used to launch Forge's AI with a library deck
 * in the other seat. That seam is gone: Play remembers a create-room preset
 * (`rooms/api.ts`'s `presetCreate`, format `draft:<podId>`) and sends the
 * drafter to the room list, which opens its create form on that preset
 * (`RoomList.tsx`, lane B) — a friend room on this pod is where the deck is
 * actually played.
 *
 * `store` and `client` exist for tests. `App.tsx` passes neither, so
 * production gets the real API.
 */

import { useEffect, useMemo, useState } from 'react';

import { DeckEditor } from '../deck/DeckEditor.tsx';
import { deckStoreClient, type DeckStoreClient, type Mine } from '../deck/deckStore.ts';
import { presetCreate } from '../rooms/api.ts';
import { navigate } from './route.ts';
import { tablesClient, type TablesClient } from './tables.ts';
import { SettingsGear } from '../settings/Settings.tsx';
import { Disclaimer } from '../components/Disclaimer.tsx';

export interface DeckScreenProps {
  draftId: string;
  /** Tests pass a stub store over a stub fetch. Production leaves it undefined and gets the real API. */
  store?: DeckStoreClient;
  /** Tests pass a client over a stub fetch. Production passes nothing. */
  client?: TablesClient;
  /** Passed through to the editor; tests set 0. */
  checkDelayMs?: number;
  saveDelayMs?: number;
}

type Loaded = { kind: 'no-seat' } | { kind: 'ready'; mine: Mine };

export function DeckScreen({ draftId, store: givenStore, client: givenClient, checkDelayMs, saveDelayMs }: DeckScreenProps) {
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

  const play = (): void => {
    presetCreate(`draft:${draftId}`);
    navigate({ kind: 'lobby' });
  };

  return (
    <div className="shell" data-testid="deck">
      <header className="shell__head">
        <h1 className="shell__title">Your deck</h1>
        <p className="shell__sub">
          Pod <strong>{draftId}</strong>
        </p>
        <SettingsGear />
      </header>

      {loadError !== null && (
        <p className="lobby__error" role="alert" data-testid="deck-load-error">
          Could not load your pool: {loadError}
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
              {loaded === null && (
                <>
                  <h2>Fetching your pool</h2>
                  <p className="lobby__note">Asking pod {draftId} for the cards you drafted.</p>
                </>
              )}
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

      <footer className="shell__foot">
        <Disclaimer />
        <p>
          <a
            className="shell__link"
            href="#/"
            onClick={(e) => {
              e.preventDefault();
              navigate({ kind: 'lobby' });
            }}
          >
            Back to the lobby
          </a>
        </p>
      </footer>
    </div>
  );
}
