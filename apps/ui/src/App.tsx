/**
 * The harness around `DraftScreen`.
 *
 * Two sources, one screen. **Live** runs the real engine in-process and is what
 * a draft actually looks like; **Fixtures** replays the five committed payloads
 * and is the regression net — it is how a rendering bug gets pinned to a known
 * input, and it is what the hidden-information control walks.
 *
 * `DraftScreen` has no idea which is driving it. That was the point of building
 * the UI against fixtures first: swapping the source is a change in this file
 * and nowhere else, and it will be the same change again when the engine moves
 * behind a socket.
 *
 * Fixtures are validated at boot rather than trusted, and so is every payload
 * the live engine produces — see `live.ts`.
 */

import { useMemo, useState } from 'react';

import { FIXTURES, loadFixtures } from './draft/fixtures.ts';
import { applyPayload, initialState, type TableState } from './draft/table.ts';
import {
  CUBE_NAME,
  CUBE_SIZE,
  applyPick,
  isComplete,
  myPool,
  startDraft,
  type LiveDraft,
} from './draft/live.ts';
import { DraftScreen } from './components/DraftScreen.tsx';
import type { PackLayout } from './components/PackView.tsx';

type Source = 'live' | 'fixtures';

const DEFAULT_SEED = 'friday-cube';

export function App() {
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

  const live = source === 'live';
  const done = isComplete(draft);
  const picked = myPool(draft).length;

  return (
    <div className="app">
      <nav className="fixtures" aria-label="Source">
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
              className={!live ? 'fixtures__on' : ''}
              aria-current={!live}
              onClick={() => setSource('fixtures')}
            >
              Fixtures — five committed payloads
            </button>
          </li>
        </ul>

        {live ? (
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
        ) : (
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
      ) : (
        <DraftScreen
          state={live ? liveState : fixtureState}
          onChange={live ? setLiveState : setFixtureState}
          onPick={live ? onLivePick : undefined}
          nextPayload={live ? null : nextPayload}
          onAdvance={
            !live && nextPayload
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
            ? 'The engine runs in this tab — no server, no socket, no room. Cards are rendered from text; this project never loads, caches or proxies a card image.'
            : 'Fixtures only — no server, no socket, no room. Cards are rendered from text; this project never loads, caches or proxies a card image.'}
        </p>
      </footer>
    </div>
  );
}
