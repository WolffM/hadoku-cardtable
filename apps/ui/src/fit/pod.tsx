/*
 * The real draft screen with a chosen pile in front of every seat, for
 * `e2e/pod-fit.spec.ts` to measure. Not part of the app's build (its one input
 * is `index.html`); the spec serves it with the app's own Vite config, so the
 * sheets scale with the UI exactly as they do in the app.
 *
 * `?n=` seats (the fixture's first n, the viewer's kept), `?q=` each seat's
 * waiting packs, `?scale=` the UI scale.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@wolffm/themes/style.css';
import '@wolffm/themes/icons.css';
import '../styles.css';
import { DraftScreen } from '../components/DraftScreen.tsx';
import { loadFixtures } from '../draft/fixtures.ts';
import { initialState } from '../draft/table.ts';
import { applyUiScale } from '../settings/ui-scale.ts';

const params = new URLSearchParams(location.search);
const fixture = loadFixtures().find((v) => v.viewer.kind === 'seat' && v.pickNumber === 3);
if (fixture === undefined || fixture.viewer.kind !== 'seat') throw new Error('no seated fixture at pick 3');
const viewerId = fixture.viewer.seatId;
const wanted = Math.max(2, Math.min(fixture.seats.length, Number(params.get('n') ?? fixture.seats.length)));
const kept = [...fixture.seats.filter((s) => s.id === viewerId), ...fixture.seats.filter((s) => s.id !== viewerId)].slice(0, wanted);
const depths = (params.get('q') ?? '').split(',').map(Number);
const seats = fixture.seats.filter((s) => kept.includes(s)).map((s, i) => ({ ...s, id: i, queueDepth: depths[i] ?? 0 }));
const view = { ...fixture, seats, capacity: seats.length, viewer: { ...fixture.viewer, seatId: seats.findIndex((s) => s.displayName === fixture.seats[viewerId]?.displayName) }, waitingOn: seats.map((s) => s.id) };

applyUiScale(document.documentElement, Number(params.get('scale') ?? 1));

const root = document.getElementById('root');
if (root === null) throw new Error('no #root');
createRoot(root).render(
  <StrictMode>
    <DraftScreen state={initialState(view)} onChange={() => {}} />
  </StrictMode>,
);
