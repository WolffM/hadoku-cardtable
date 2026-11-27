// @vitest-environment jsdom
/*
 * A choice is made by the click itself, even when something re-renders the group between the
 * browser ticking the input and React reading the click.
 *
 * Found by CI (eight flakes, 2026-11-22..24, a room's Tournament mode and the draft's cube): the
 * click reached the enabled input and the browser ticked it, but a store update made during the
 * click's dispatch (a document-capture listener ahead of React's root) is rendered at once, React's
 * discrete priority, and the controlled input was reset to its old `checked` before React's own
 * listener ran. React then saw no change and fired no `onChange`: the click was lost. Real Chromium
 * shows it with one capture listener and an external store; jsdom has no checkpoint between
 * listeners, so here the listener resets `checked` itself, the state that re-render leaves.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { RadioCards } from './RadioCards.tsx';

afterEach(cleanup);

/** What a sync re-render during the click's dispatch does to a controlled input: its `checked` put back. */
function resetDuringDispatch(): () => void {
  const reset = (event: Event): void => {
    const input = event.target;
    if (input instanceof HTMLInputElement) input.checked = !input.checked;
  };
  document.addEventListener('click', reset, { capture: true });
  return () => document.removeEventListener('click', reset, { capture: true });
}

function group(value: 'a' | 'b', picked: string[]) {
  return render(
    createElement(RadioCards<'a' | 'b'>, {
      name: 'g',
      label: 'g',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      value,
      onChange: (v) => picked.push(v),
      testId: 'g',
    }),
  );
}

describe('RadioCards', () => {
  it('chooses on the click even when the input is re-rendered unticked before React reads it', () => {
    const picked: string[] = [];
    group('a', picked);
    const stop = resetDuringDispatch();
    screen.getByTestId('g-b').click();
    stop();
    expect(picked).toEqual(['b']);
  });

  it('chooses on a plain click, and a click on the chosen card chooses nothing again', () => {
    const picked: string[] = [];
    group('a', picked);
    screen.getByTestId('g-b').click();
    screen.getByTestId('g-a').click();
    expect(picked).toEqual(['b']);
  });
});
