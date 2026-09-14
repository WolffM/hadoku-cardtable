/**
 * The fixture harness around `DraftScreen`.
 *
 * Everything in this file is scaffolding that a socket replaces later: a picker
 * for which committed payload to render, and a button that hands the screen the
 * next payload in `seq` order. `DraftScreen` itself has no idea the payloads
 * came from disk, which is the property worth keeping — swapping the source is
 * a change here and nowhere else.
 *
 * The fixtures are validated at boot rather than trusted. A payload that does
 * not satisfy the envelope throws with the file name and the JSON path, because
 * a fixture is a contract with the draft engine and a broken one should fail
 * loudly on this side of the wire.
 */

import { useMemo, useState } from 'react';

import { FIXTURES, loadFixtures } from './draft/fixtures.ts';
import { applyPayload, initialState, type TableState } from './draft/table.ts';
import { DraftScreen } from './components/DraftScreen.tsx';
import type { PackLayout } from './components/PackView.tsx';

export function App() {
  const views = useMemo(() => loadFixtures(), []);
  const [index, setIndex] = useState(0);
  const [state, setState] = useState<TableState>(() => initialState(views[0]));
  const [layout, setLayout] = useState<PackLayout>('fan');

  const select = (next: number): void => {
    setIndex(next);
    setState(initialState(views[next]));
  };

  // The next payload of the SAME draft, by seq. Fixtures for another draft are
  // a different table and are reached through the picker, not by advancing.
  const nextPayload =
    views.find((v) => v.draftId === state.view.draftId && v.seq > state.view.seq) ?? null;

  return (
    <div className="app">
      <nav className="fixtures" aria-label="Fixtures">
        <span className="fixtures__label">Fixture</span>
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
      </nav>

      <DraftScreen
        state={state}
        onChange={setState}
        nextPayload={nextPayload}
        onAdvance={
          nextPayload ? () => setState((prev) => applyPayload(prev, nextPayload)) : undefined
        }
        layout={layout}
        onLayoutChange={setLayout}
      />

      <footer className="app__foot">
        <p>
          Fixtures only — no server, no socket, no room. Cards are rendered from text; this
          project never loads, caches or proxies a card image.
        </p>
      </footer>
    </div>
  );
}
