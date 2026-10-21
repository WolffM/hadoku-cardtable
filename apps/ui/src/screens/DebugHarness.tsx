/*
 * The developer harness, at `#/debug`.
 *
 * This is what used to be `App.tsx` — the whole of it, controls, labels and
 * copy — moved rather than rewritten, because it is the regression net three
 * waves of tests assert against and its labels are load-bearing
 * (`DraftScreen.test.ts` clicks "Fixtures — five committed payloads" by text).
 * It is NOT deleted and must not be: a source that cannot have a network bug is
 * how a rendering regression gets bisected, and `live` — the in-process engine,
 * solo against bots — is how a rendering change gets checked without a second
 * browser.
 *
 * What changed by moving it: it is no longer the front door. A person arriving
 * at `hadoku.me/cardtable/` meets the lobby, and the Source switcher, the seed
 * box and the fixture picker are one hash away for whoever wants them.
 *
 * The product path is `#/draft/<id>` — `PodScreen`, socket source, invite link.
 * The `socket` source here overlaps with it on purpose: this one connects to a
 * draft id you type, which is what you want while debugging.
 *
 * ── what follows is this module's original documentation ──
 *
 * The harness around `DraftScreen`.
 *
 * Three sources, one screen. **Live** runs the real engine in-process and is
 * what a draft actually looks like without a server; **Fixtures** replays the
 * five committed payloads and is the regression net — it is how a rendering bug
 * gets pinned to a known input, and it is what the hidden-information control
 * walks; **Server** connects a socket to a real draft and renders only what it
 * is sent.
 *
 * `DraftScreen` has no idea which is driving it. That was the point of building
 * the UI against fixtures first: swapping the source is a change in this file
 * and nowhere else, and the socket source is that promise being collected —
 * `DraftScreen`'s props did not move to add it.
 *
 * **The first two sources stay.** A source that cannot have a network bug is
 * how a rendering regression gets bisected, and the local engine is the only
 * one that works with no server at all.
 *
 * ## Where the async goes
 *
 * `live.ts` is synchronous: `applyPick` returns the next view. `socket.ts`
 * cannot be — the next view arrives later, or never. That difference is
 * absorbed HERE, in the harness: the socket source holds a `TableState | null`
 * and renders a connection panel until the first snapshot lands. Pushing it
 * down into `DraftScreen` would have made every other source pay for it.
 *
 * Fixtures are validated at boot rather than trusted, and so is every payload
 * the live engine produces (`live.ts`) and every envelope the server sends
 * (`socket.ts`).
 */

import { useEffect, useMemo, useReducer, useState } from 'react';

import { FIXTURES, loadFixtures } from '../draft/fixtures.ts';
import { applyPayload, initialState, type TableState } from '../draft/table.ts';
import {
  CUBE_NAME,
  CUBE_SIZE,
  applyPick,
  isComplete,
  myPool,
  startDraft,
  type LiveDraft,
} from '../draft/live.ts';
import {
  applyPick as socketPick,
  closeDraft as socketClose,
  cubeName as socketCubeName,
  cubeSize as socketCubeSize,
  isComplete as socketComplete,
  myPool as socketPool,
  mySeat as socketSeat,
  startDraft as socketStart,
  type SocketDraft,
} from '../draft/socket.ts';
import { DraftScreen } from '../components/DraftScreen.tsx';
import { navigate } from './route.ts';
import type { PackLayout } from '../components/PackView.tsx';

type Source = 'live' | 'fixtures' | 'socket';

const DEFAULT_SEED = 'friday-cube';
const DEFAULT_DRAFT_ID = 'friday-cube';

export function DebugHarness() {
  const [source, setSource] = useState<Source>('live');
  const [layout, setLayout] = useState<PackLayout>('fan');

  // --- live ---------------------------------------------------------------
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [seedInput, setSeedInput] = useState(DEFAULT_SEED);
  const [draft, setDraft] = useState<LiveDraft>(() => startDraft(DEFAULT_SEED));
  const [liveState, setLiveState] = useState<TableState>(() => initialState(draft.view));

  const restart = (nextSeed: string): void => {
    const fresh = startDraft(nextSeed);
    setSeed(nextSeed);
    setDraft(fresh);
    setLiveState(initialState(fresh.view));
  };

  /**
   * A pick: hand it to the engine, let the bots answer, show the result.
   *
   * The screen has already applied the pick optimistically and is showing
   * "waiting for the next payload" — the new view is that payload. Over a wire
   * this is the round trip; here it is a function call.
   */
  const onLivePick = (cardId: string): void => {
    const next = applyPick(draft, cardId);
    setDraft(next);
    setLiveState(initialState(next.view));
  };

  // --- fixtures -----------------------------------------------------------
  const views = useMemo(() => loadFixtures(), []);
  const [index, setIndex] = useState(0);
  const [fixtureState, setFixtureState] = useState<TableState>(() => initialState(views[0]));

  const select = (next: number): void => {
    setIndex(next);
    setFixtureState(initialState(views[next]));
  };

  const nextPayload =
    views.find(
      (v) => v.draftId === fixtureState.view.draftId && v.seq > fixtureState.view.seq,
    ) ?? null;

  // --- socket -------------------------------------------------------------
  const [draftIdInput, setDraftIdInput] = useState(DEFAULT_DRAFT_ID);
  const [socketDraft, setSocketDraft] = useState<SocketDraft | null>(null);
  const [socketState, setSocketState] = useState<TableState | null>(null);
  /**
   * The driver is a mutable handle — a socket's state changes under you. This
   * is what tells React something happened; the handle itself keeps its
   * identity so `applyPick(draft, …)` reads the same as it does for `live`.
   */
  const [, socketChanged] = useReducer((n: number) => n + 1, 0);

  const connect = (draftId: string): void => {
    // The previous connection is closed by the effect below, which is the only
    // place that hangs up — two paths for one socket is how a leak starts.
    let shown = '';
    setSocketState(null);
    setSocketDraft(
      socketStart({
        draftId,
        onChange: (d) => {
          socketChanged();
          if (d.view === null) {
            shown = '';
            setSocketState(null);
            return;
          }
          // Rebuild the table only when the PAYLOAD changed. A rejection or a
          // reconnect notifies too, and rebuilding on those would throw away
          // the pending pick the screen is showing.
          const stamp = `${d.view.epoch}:${d.view.seq}`;
          if (stamp === shown) return;
          shown = stamp;
          setSocketState(initialState(d.view));
        },
      }),
    );
  };

  useEffect(() => {
    if (socketDraft === null) return;
    return () => {
      socketClose(socketDraft);
    };
  }, [socketDraft]);

  const onSocketPick = (cardId: string): void => {
    if (socketDraft !== null) socketPick(socketDraft, cardId);
  };

  const live = source === 'live';
  const fixtures = source === 'fixtures';
  const onSocket = source === 'socket';
  const done = isComplete(draft);
  const picked = myPool(draft).length;

  const socketSeatId = socketDraft === null ? null : socketSeat(socketDraft);
  const socketDone = socketDraft !== null && socketComplete(socketDraft);
  const socketPicked = socketDraft === null ? 0 : socketPool(socketDraft).length;

  /** Which state the screen is rendering. Null only while a socket is waiting. */
  const screenState = live ? liveState : fixtures ? fixtureState : socketState;

  return (
    <div className="app">
      <nav className="fixtures" aria-label="Source">
        <a
          className="shell__link"
          href="#/"
          onClick={(e) => {
            e.preventDefault();
            navigate({ kind: 'lobby' });
          }}
        >
          &larr; Lobby
        </a>
        <span className="fixtures__label">Source</span>
        <ul className="fixtures__list">
          <li>
            <button
              type="button"
              className={live ? 'fixtures__on' : ''}
              aria-current={live}
              onClick={() => setSource('live')}
            >
              Live draft — the real engine
            </button>
          </li>
          <li>
            <button
              type="button"
              className={fixtures ? 'fixtures__on' : ''}
              aria-current={fixtures}
              onClick={() => setSource('fixtures')}
            >
              Fixtures — five committed payloads
            </button>
          </li>
          <li>
            <button
              type="button"
              className={onSocket ? 'fixtures__on' : ''}
              aria-current={onSocket}
              onClick={() => setSource('socket')}
            >
              Server — a real draft over a socket
            </button>
          </li>
        </ul>

        {live && (
          <>
            <span className="fixtures__label">Seed</span>
            <form
              className="fixtures__seed"
              onSubmit={(e) => {
                e.preventDefault();
                restart(seedInput.trim() === '' ? DEFAULT_SEED : seedInput.trim());
              }}
            >
              <label htmlFor="seed">
                Same seed, same draft — every shuffle and every bot pick.
              </label>
              <input
                id="seed"
                value={seedInput}
                onChange={(e) => setSeedInput(e.target.value)}
                spellCheck={false}
              />
              <button type="submit">Start draft</button>
            </form>
            <p className="fixtures__note">
              <strong>{CUBE_NAME}</strong>
              <br />
              {CUBE_SIZE} cards · 8 seats · you are seat 0 · 7 bots
              <br />
              seed <code>{seed}</code> · picked {picked}/45
            </p>
          </>
        )}

        {fixtures && (
          <ul className="fixtures__list">
            {FIXTURES.map((fixture, i) => (
              <li key={fixture.file}>
                <button
                  type="button"
                  className={i === index ? 'fixtures__on' : ''}
                  aria-current={i === index}
                  onClick={() => select(i)}
                  title={fixture.file}
                >
                  {fixture.label}
                </button>
              </li>
            ))}
          </ul>
        )}

        {onSocket && (
          <>
            <span className="fixtures__label">Draft</span>
            <form
              className="fixtures__seed"
              onSubmit={(e) => {
                e.preventDefault();
                connect(draftIdInput.trim() === '' ? DEFAULT_DRAFT_ID : draftIdInput.trim());
              }}
            >
              <label htmlFor="draftId">
                The id of the draft to join. Which seat you get is the server&rsquo;s
                answer, not this browser&rsquo;s request.
              </label>
              <input
                id="draftId"
                value={draftIdInput}
                onChange={(e) => setDraftIdInput(e.target.value)}
                spellCheck={false}
              />
              <button type="submit">{socketDraft === null ? 'Connect' : 'Reconnect'}</button>
            </form>
            <p className="fixtures__note">
              {socketDraft === null ? (
                'Not connected.'
              ) : (
                <>
                  <strong>{socketCubeName(socketDraft) ?? socketDraft.draftId}</strong>
                  <br />
                  {socketCubeSize(socketDraft) === null ? null : `${socketCubeSize(socketDraft)} cards · `}
                  {socketDraft.connected ? 'connected' : 'offline'}
                  {socketSeatId === null ? ' · no seat yet' : ` · you are seat ${socketSeatId}`}
                  <br />
                  picked {socketPicked}
                  {socketDraft.lastError === null ? null : (
                    <>
                      {' · '}
                      <strong>{socketDraft.lastError.code}</strong>
                    </>
                  )}
                </>
              )}
            </p>
          </>
        )}
      </nav>

      {live && done ? (
        <div className="app__done">
          <h1>Draft complete</h1>
          <p>
            45 cards, three packs, seed <code>{seed}</code>. Run the same seed again and you
            will get the same draft, card for card.
          </p>
          <ol className="app__pool">
            {myPool(draft).map((card) => (
              <li key={card.cardId}>{card.name}</li>
            ))}
          </ol>
          <button type="button" onClick={() => restart(seed)}>
            Draft it again
          </button>
        </div>
      ) : onSocket && socketDraft !== null && socketDone ? (
        <div className="app__done">
          <h1>Draft complete</h1>
          <p>Every pick is in. The pool below is what the server says you took.</p>
          <ol className="app__pool">
            {socketPool(socketDraft).map((card) => (
              <li key={card.cardId}>{card.name}</li>
            ))}
          </ol>
        </div>
      ) : screenState === null ? (
        <div className="app__done">
          <h1>{socketDraft === null ? 'No connection' : 'Waiting for the table'}</h1>
          <p>
            {socketDraft === null
              ? 'Pick a draft id and connect. Nothing is drafted in this tab on this source — the engine runs on the server and this browser renders what it is sent.'
              : 'Joined; waiting for the first payload. If the server restarts mid-draft the client discards what it has and refetches, rather than trying to patch state from a different incarnation.'}
          </p>
        </div>
      ) : (
        <DraftScreen
          state={screenState}
          onChange={live ? setLiveState : onSocket ? setSocketState : setFixtureState}
          onPick={live ? onLivePick : onSocket ? onSocketPick : undefined}
          nextPayload={fixtures ? nextPayload : null}
          onAdvance={
            fixtures && nextPayload
              ? () => setFixtureState((prev) => applyPayload(prev, nextPayload))
              : undefined
          }
          layout={layout}
          onLayoutChange={setLayout}
        />
      )}

      <footer className="app__foot">
        <p>
          {live
            ? 'The engine runs in this tab — no server, no socket, no room.'
            : fixtures
              ? 'Fixtures only — no server, no socket, no room.'
              : 'The engine runs on the server; this tab renders only what it is sent.'}{' '}
          Card text is drawn by us. Card art is loaded by your browser from our CDN,
          or from Scryfall for a card the manifest does not name yet — never from this
          app&rsquo;s own origin, which serves no image at all (D15).
        </p>
      </footer>
      {/* The top layer the draft screen's related row draws into, as `PodScreen`'s. */}
      <div className="pod__zoom" data-board-zoom="" />
    </div>
  );
}
