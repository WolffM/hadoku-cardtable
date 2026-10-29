/*
 * The draft's loading skeleton, then the real draft screen in its place, for
 * `e2e/w79e-draft-visuals.spec.ts` to measure: the two must draw the same
 * boxes, so nothing jumps when the table arrives. Not part of the app's build
 * (its one input is `index.html`); served with the app's own Vite config.
 *
 * Starts on the skeleton; `window.load()` swaps in the draft. `?w=` the seats
 * that still owe a pick (all of them when absent), `?q=` each seat's waiting
 * packs, `?scale=` the UI scale.
 */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@wolffm/themes/style.css';
import '@wolffm/themes/icons.css';
import '../styles.css';
import { DraftScreen, DraftSkeleton } from '../components/DraftScreen.tsx';
import { loadFixtures } from '../draft/fixtures.ts';
import { initialState } from '../draft/table.ts';
import { applyUiScale } from '../settings/ui-scale.ts';

declare global {
  interface Window {
    load: () => void;
  }
}

const params = new URLSearchParams(location.search);
const fixture = loadFixtures().find((v) => v.viewer.kind === 'seat' && v.pickNumber === 3);
if (fixture === undefined) throw new Error('no seated fixture at pick 3');
const depths = (params.get('q') ?? '').split(',').map(Number);
const waiting = params.get('w');
const seats = fixture.seats.map((s, i) => ({ ...s, queueDepth: depths[i] ?? 0 }));
const view = { ...fixture, seats, waitingOn: waiting === null ? seats.map((s) => s.id) : waiting === '' ? [] : waiting.split(',').map(Number) };

applyUiScale(document.documentElement, Number(params.get('scale') ?? 1));

/** A stand-in for the room's bar `PodScreen` puts at the top of the side column: the same in both states. */
const side = <div data-fit-side="" style={{ height: 48 }} />;

function Page() {
  const [loaded, setLoaded] = useState(false);
  window.load = () => setLoaded(true);
  return loaded ? <DraftScreen state={initialState(view)} onChange={() => {}} side={side} /> : <DraftSkeleton side={side} />;
}

const root = document.getElementById('root');
if (root === null) throw new Error('no #root');
createRoot(root).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
