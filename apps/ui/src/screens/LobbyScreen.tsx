/*
 * The front door: a list of rooms.
 *
 * The operator's spec (2026-09-19): *"players go to cardtable and all they see
 * on the front page is a list of rooms and they can either join a room or
 * create a new one."* So the room list (`../rooms/RoomList.tsx`) is the first
 * and largest thing here, and a room is where a game is set up — each player
 * loads their own deck inside it.
 *
 * ## What is gone
 *
 * The "Play constructed" button to `#/play`. That screen had one person pick
 * BOTH players' decks, because `POST /api/play/matches` takes two decks in one
 * call; the operator rejected it. Rooms replace it.
 *
 * ## What stays, secondary
 *
 * Draft pods. Draft rooms are not built yet, and until they are the draft half
 * of the product must stay reachable: start a pod, or paste a pod or match
 * link into the join box. The box is left visible rather than folded into a
 * closed `<details>`, because a collapsed input is one Playwright cannot fill.
 *
 * ## The pod id is minted here and nowhere else
 *
 * A draft room is created on demand: the server's `join` handler calls
 * `rooms.open(draftId)` (`apps/server/src/room/socket.ts`). So "start a pod" is
 * "mint an id and join it", and the invite link is this same page at
 * `#/draft/<id>`.
 */

import { useState } from 'react';

import { RoomList } from '../rooms/RoomList.tsx';
import type { RoomsClient } from '../rooms/api.ts';
import { joinRouteFromInput, mintDraftId, navigate } from './route.ts';

export interface LobbyScreenProps {
  /** Tests pass a rooms client over a stubbed fetch. Production passes nothing. */
  rooms?: RoomsClient;
}

export function LobbyScreen({ rooms }: LobbyScreenProps) {
  const [joinInput, setJoinInput] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);

  const start = (): void => {
    navigate({ kind: 'draft', draftId: mintDraftId() });
  };

  const join = (): void => {
    const route = joinRouteFromInput(joinInput);
    if (route === null) {
      setJoinError('That does not look like a pod link, a match link, or a pod id.');
      return;
    }
    setJoinError(null);
    navigate(route);
  };

  return (
    <div className="shell" data-testid="lobby">
      <header className="shell__head">
        <h1 className="shell__title">Cardtable</h1>
      </header>

      <main className="front">
        <RoomList client={rooms} />

        <section className="pods" data-testid="draft-pods" aria-labelledby="draft-pods-title">
          <h2 id="draft-pods-title" className="pods__title">
            Draft pods
          </h2>
          <div className="lobby">
            <div className="lobby__card">
              <h3>Start a pod</h3>
              <button type="button" className="lobby__go" data-testid="start-pod" onClick={start}>
                Start a pod
              </button>
            </div>

            <div className="lobby__card">
              <h3>Join a pod or a match</h3>
              <form
                className="lobby__form"
                onSubmit={(e) => {
                  e.preventDefault();
                  join();
                }}
              >
                <label htmlFor="join-id">Link or pod id</label>
                <input
                  id="join-id"
                  data-testid="join-id"
                  value={joinInput}
                  placeholder="amber-lantern-k7q4"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => {
                    setJoinInput(e.target.value);
                    setJoinError(null);
                  }}
                />
                <button type="submit">Join</button>
              </form>
              {joinError !== null && (
                <p className="lobby__error" role="alert" data-testid="join-error">
                  {joinError}
                </p>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="shell__foot">
        {import.meta.env?.DEV === true && (
          <p>
            <a
              className="shell__link"
              href="#/debug"
              onClick={(e) => {
                e.preventDefault();
                navigate({ kind: 'debug' });
              }}
            >
              Developer harness
            </a>
          </p>
        )}
      </footer>
    </div>
  );
}
