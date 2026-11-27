/*
 * How a controlled checkbox or radio makes its choice: on the input's own click, never its change.
 *
 * React reads a click on a checkbox or radio as a change only if the input's `checked` differs from
 * the value it last rendered. Anything that renders while the click is still being dispatched (a
 * store updated from a capture listener ahead of React's root renders at once, at the click's
 * discrete priority) puts the controlled input back to its old `checked` first, and React then fires
 * no `onChange`: the click is lost. CI caught it eight times on a room's radios (2026-11-22..24, the
 * click trail: ticked at window capture, unticked by document capture, no write); a headless
 * Chromium page reproduces it with one listener and one store.
 *
 * The click itself always reaches React, and the keyboard's own choices are clicks too (Space on
 * either, an arrow between radios), so choosing there loses nothing. `checked` stays the caller's
 * alone (`readOnly` tells React the input is controlled without a change handler), and a second
 * click of a double click (`detail > 1`) is not a second choice.
 */

import type { MouseEvent } from 'react';

export interface ChoiceInputProps {
  readOnly: true;
  onClick: (event: MouseEvent<HTMLInputElement>) => void;
}

/** Spread on a controlled `<input type="checkbox|radio">`: `choose` runs once per click that chose it. */
export function choiceInput(choose: () => void): ChoiceInputProps {
  return {
    readOnly: true,
    onClick: (event) => {
      if (event.detail > 1) return;
      choose();
    },
  };
}
