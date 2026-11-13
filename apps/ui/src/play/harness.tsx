/*
 * Dev harness for the board: the committed fixture, rendered, nothing else.
 *
 * Open `/cardtable/src/play/harness.html` under `pnpm --filter @hadoku/ui dev`.
 * It exists so the board can be looked at — and measured at phone width —
 * without touching `App.tsx`, which this lane does not own. Wiring the board
 * into the app's routes is a separate, proposed patch.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ensureCosmeticsStyles } from '@wolffm/prefs-client/cosmetics';

import '@hadoku/magic-ui/styles.css';
import { Board } from '@hadoku/magic-ui/play/Board.tsx';
import { boardFromFixture, PLAY_FIXTURES } from '@hadoku/magic-ui/play/fixtures.ts';
import { composeGame } from '../composition.tsx';
composeGame();

// As the app's entry does (`main.tsx`): the faces' sheet is there before anything is drawn.
ensureCosmeticsStyles();
const root = document.getElementById('root');
if (!root) throw new Error('harness.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <Board view={boardFromFixture(PLAY_FIXTURES[0]!)} />
  </StrictMode>,
);
