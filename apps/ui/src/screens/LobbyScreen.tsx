/*
 * The front door.
 *
 * What a person met at `hadoku.me/cardtable/` until this wave was the harness
 * built to exercise the engine — a Source switcher, a seed box and a fixture
 * picker. Useful, and still reachable at `#/debug`, but it answers a question
 * nobody arriving at the site is asking. This screen answers theirs: start a
 * pod, send the link, draft.
 *
 * ## Three controls, because there are three things to do
 *
 * Start a pod, start a constructed match (`#/play`), or join either one you
 * were sent — the join box takes a pod link and a match link alike, so there
 * is one lobby for both. Everything else a lobby could offer —
 * pick a cube, choose a pod size — would be a control that lies: the server
 * loads ONE cube pool at boot (`rooms.cube`) and hardcodes the pod at eight
 * seats (`apps/server/src/room/draftRooms.ts` `DEFAULT_PARAMS`), and there is
 * no API to tell it otherwise. This repo has shipped a green control that did
 * nothing four separate times. The numbers quoted below are described as the
 * server's, because that is what they are.
 *
 * ## The pod id is minted here and nowhere else
 *
 * A draft room is created on demand: the server's `join` handler calls
 * `rooms.open(draftId)` (`apps/server/src/room/socket.ts`). So "start a pod" is
 * "mint an id and join it", and the invite link is this same page at
 * `#/draft/<id>`. There is no REST lobby endpoint to call and none is needed.
 */

import { useState } from 'react';

import { joinRouteFromInput, mintDraftId, navigate } from './route.ts';

export function LobbyScreen() {
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
        <p className="shell__sub">Draft a cube with your friends, in a browser.</p>
      </header>

      <main className="lobby">
        <section className="lobby__card">
          <h2>Start a pod</h2>
          <p className="lobby__note">
            You get a link. Send it to whoever is drafting; opening it puts them at the
            table. Seats nobody takes are drafted by bots, so a pod works with one person
            or eight.
          </p>
          <button type="button" className="lobby__go" data-testid="start-pod" onClick={start}>
            Start a pod
          </button>
        </section>

        <section className="lobby__card">
          <h2>Play constructed</h2>
          <p className="lobby__note">
            Pick a Standard format from years past and a deck that was played in it,
            then play a friend or Forge&rsquo;s AI. A deck that is not legal in the
            format is refused, and you are told which card.
          </p>
          <button
            type="button"
            className="lobby__go"
            data-testid="play-constructed"
            onClick={() => navigate({ kind: 'play' })}
          >
            Choose a deck
          </button>
        </section>

        <section className="lobby__card">
          <h2>Join a pod or a match</h2>
          <p className="lobby__note">
            Paste the link you were sent, or just the pod id out of it.
          </p>
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
        </section>
      </main>

      <footer className="shell__foot">
        <p>
          A pod is eight seats and three packs of fifteen cards, from one cube — the
          server&rsquo;s settings, not a choice made in this browser. Card text is drawn
          by us; card art is loaded by your browser from our CDN, and this app&rsquo;s own
          origin never serves an image.
        </p>
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
