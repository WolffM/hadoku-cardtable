/*
 * `#/deck/<draftId>` — build a deck out of the pool you drafted, and play it.
 *
 * ## Where the pool comes from
 *
 * The server, over the same socket the pod used. Joining a draft you already
 * sit in answers with your seat's view (`apps/server/src/room/socket.ts`, the
 * `join` case), and that view carries your pool — the same one the gate's draft
 * arm reads when it checks your deck (`apps/server/src/http/routes.ts`,
 * `draftPoolFor`: the caller's derived identity, never a seat number). So the
 * pool on this screen and the pool the server checks against are one pool, read
 * twice, not two copies that could drift.
 *
 * The socket stays open while you build. Leaving it would start the seat's
 * release hold, and the gate finds your pool through your seat.
 *
 * ## What is not here
 *
 * The builder and the start button are `deck/DeckBuilder.tsx`; the wire shape
 * of a drafted seat is `deck/build.ts`. This file only decides whether there is
 * a finished pool to build from, and says so in words when there is not.
 *
 * `makeTransport` and `client` exist for tests. `App.tsx` passes neither, so
 * production gets a same-origin socket.io connection and the real API.
 */

import { useEffect, useMemo, useReducer, useState } from 'react';

import { DeckBuilder } from '../deck/DeckBuilder.tsx';
import { poolReadiness } from '../deck/build.ts';
import { closeDraft, startDraft, type DraftTransport, type SocketDraft } from '../draft/socket.ts';
import { navigate } from './route.ts';
import { tablesClient, type TablesClient } from './tables.ts';
import { SettingsGear } from '../settings/Settings.tsx';

export interface DeckScreenProps {
  draftId: string;
  /** Tests pass a stub socket. Production leaves it undefined and gets socket.io. */
  makeTransport?: () => DraftTransport;
  /** Tests pass a client over a stub fetch. Production passes nothing. */
  client?: TablesClient;
  /** Passed through to the builder; tests set 0. */
  checkDelayMs?: number;
}

export function DeckScreen({ draftId, makeTransport, client: given, checkDelayMs }: DeckScreenProps) {
  const client = useMemo(() => given ?? tablesClient(), [given]);
  const [draft, setDraft] = useState<SocketDraft | null>(null);
  const [, changed] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const live = startDraft({ draftId, transport: makeTransport?.(), onChange: () => changed() });
    setDraft(live);
    return () => {
      closeDraft(live);
      setDraft(null);
    };
  }, [draftId, makeTransport]);

  const readiness = poolReadiness(draft?.view ?? null);

  return (
    <div className="shell" data-testid="deck">
      <header className="shell__head">
        <h1 className="shell__title">Your deck</h1>
        <p className="shell__sub">
          Pod <strong>{draftId}</strong>
        </p>
        <SettingsGear />
      </header>

      {draft !== null && draft.lastError !== null && (
        <p className="lobby__error" role="alert" data-testid="deck-socket-error">
          The server refused that: <strong>{draft.lastError.code}</strong>
          {draft.lastError.detail === undefined ? null : ` — ${draft.lastError.detail}`}
        </p>
      )}

      {readiness.kind === 'ready' ? (
        <DeckBuilder draftId={draftId} pool={readiness.pool} client={client} checkDelayMs={checkDelayMs} />
      ) : (
        <main className="lobby">
          <section className="lobby__card" data-testid={`deck-${readiness.kind}`}>
            {readiness.kind === 'joining' && (
              <>
                <h2>Fetching your pool</h2>
                <p className="lobby__note">Asking the pod for the cards you drafted.</p>
              </>
            )}
            {readiness.kind === 'spectator' && (
              <>
                <h2>You have no seat in this pod</h2>
              </>
            )}
            {readiness.kind === 'unfinished' && (
              <>
                <h2>The draft is not over</h2>
                <p className="lobby__note">
                  Drafted {readiness.picked} of {readiness.total}.
                </p>
              </>
            )}
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
      )}

      <footer className="shell__foot">
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
