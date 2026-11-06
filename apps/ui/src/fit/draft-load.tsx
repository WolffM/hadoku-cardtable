/*
 * The draft's loading skeleton, then the real draft screen in its place, for
 * `e2e/w79e-draft-visuals.spec.ts` to measure: the two must draw the same
 * boxes, so nothing jumps when the table arrives. Not part of the app's build
 * (its one input is `index.html`); served with the app's own Vite config.
 *
 * Starts on the skeleton; `window.load()` swaps in the draft. `?w=` the seats
 * that still owe a pick (all of them when absent), `?q=` each seat's waiting
 * packs, `?scale=` the UI scale, `?side=` the room's bar's height in px (48
 * when absent; it does not scale with the column's fit, as the real bar's name
 * and Close do not), `?real=1` draws real card art and gives every seat a
 * watchparty face (for screenshots).
 */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ensureCosmeticsStyles } from '@wolffm/prefs-client/cosmetics';
import '@wolffm/themes/style.css';
import '@wolffm/themes/icons.css';
import '../styles.css';
import { DraftScreen, DraftSkeleton } from '../components/DraftScreen.tsx';
import { loadFixtures } from '../draft/fixtures.ts';
import { initialState } from '../draft/table.ts';
import { applyUiScale } from '../settings/ui-scale.ts';
import { artIdIndexFromTable, scryfallIdFor, type ArtIdTableFile } from '@hadoku/carddata/art';
import artIdsData from '../draft/art-ids.json' with { type: 'json' };

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
const FACES = ['sage', 'herald', 'cleric', 'knight', 'mage', 'brawler', 'wanderer', 'rogue'];
const real = params.get('real') === '1';
const seats = fixture.seats.map((s, i) => ({ ...s, queueDepth: depths[i] ?? 0, ...(real ? { avatarId: FACES[i % FACES.length] } : {}) }));
const artIds = artIdIndexFromTable(artIdsData as ArtIdTableFile);
const withArt = <C extends { name: string; setCode?: string }>(c: C): C => {
  const scryfallId = scryfallIdFor(artIds, c.name, c.setCode ?? '');
  return scryfallId === undefined ? c : { ...c, scryfallId };
};
const viewer = real && fixture.viewer.kind === 'seat' ? { ...fixture.viewer, pack: fixture.viewer.pack.map(withArt), pool: fixture.viewer.pool.map(withArt) } : fixture.viewer;
const view = { ...fixture, viewer, seats, waitingOn: waiting === null ? seats.map((s) => s.id) : waiting === '' ? [] : waiting.split(',').map(Number) };

applyUiScale(document.documentElement, Number(params.get('scale') ?? 1));

/** A stand-in for the room's bar `PodScreen` puts at the top of the side column: the same in both states. */
const side = <div data-fit-side="" style={{ height: Number(params.get('side') ?? 48) }} />;

function Page() {
  const [loaded, setLoaded] = useState(false);
  window.load = () => setLoaded(true);
  return loaded ? <DraftScreen state={initialState(view)} onChange={() => {}} side={side} /> : <DraftSkeleton side={side} />;
}

// As the app's entry does (`main.tsx`): the faces' sheet is there before anything is drawn.
ensureCosmeticsStyles();
const root = document.getElementById('root');
if (root === null) throw new Error('no #root');
createRoot(root).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
