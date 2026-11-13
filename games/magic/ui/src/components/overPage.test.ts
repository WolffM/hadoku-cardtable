// @vitest-environment jsdom
/*
 * A layer placed in the window's coordinates is drawn over the page, never inside the fit screen that
 * opened it: `.shell--fit`'s `contain: layout` makes that screen the containing block of its
 * `position: fixed` boxes, and a deck peek drawn there made the room scroll sideways
 * (`e2e/lobby-fit.spec.ts`, which measures the layout this only checks the structure of).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { DeckPeek } from '../screens/DeckPeek.tsx';
import { Modal } from '@hadoku/game-ui/components/Modal.tsx';
import { Popover } from '@hadoku/game-ui/components/Popover.tsx';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** The app's chrome root with a fit screen in it, `drawn` rendered inside the screen. */
function inFitScreen(drawn: ReactElement): { chrome: HTMLElement; shell: HTMLElement } {
  const chrome = document.body.appendChild(document.createElement('div'));
  chrome.className = 'cardtable-chrome';
  const shell = chrome.appendChild(document.createElement('div'));
  shell.className = 'shell shell--fit';
  render(drawn, { container: shell });
  return { chrome, shell };
}

const peek = (inPlace: boolean): ReactElement =>
  createElement(DeckPeek, {
    id: 'deck-peek',
    label: 'Red',
    colors: ['R'],
    list: { main: [], sideboard: [] },
    anchor: new DOMRect(600, 300, 190, 190),
    bounds: new DOMRect(0, 81, 928, 719),
    inPlace,
  });

describe('a layer placed in the window, opened inside a fit screen', () => {
  const cases: [string, () => ReactElement, string][] = [
    ['a deck peek', () => peek(false), 'deck-peek'],
    ['a popover', () => createElement(Popover, { trigger: document.body, onClose: () => {}, title: 'Match rules', testId: 'pop' }), 'pop'],
    ['a modal', () => createElement(Modal, { title: 'Create', testId: 'modal', onClose: () => {}, children: null }), 'modal'],
  ];
  it.each(cases)('%s is drawn in the chrome root, outside the screen', (_, drawn, testId) => {
    const { chrome, shell } = inFitScreen(drawn());
    const layer = screen.getByTestId(testId);
    expect(shell.contains(layer)).toBe(false);
    expect(chrome.contains(layer)).toBe(true);
  });

  it('a peek inside a layer already over the page stays where it is drawn', () => {
    const { shell } = inFitScreen(peek(true));
    expect(shell.contains(screen.getByTestId('deck-peek'))).toBe(true);
  });
});
