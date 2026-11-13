// @vitest-environment jsdom
/*
 * One action, one element: a button whose action changes is a new element,
 * so a press against the old one fires nothing; a double click's second click
 * fires only where its first landed; keyboard focus follows the replacement.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ActionButton } from './ActionButton.tsx';

afterEach(cleanup);

const toggle = (on: boolean, onPress: () => void) =>
  createElement(ActionButton, { action: on ? 'unready' : 'ready', onPress, 'data-testid': 'toggle', children: on ? 'Stand down' : 'Ready' } as Parameters<typeof ActionButton>[0]);

describe('ActionButton', () => {
  it('draws a new element when its action changes, and a press on the old one fires nothing', () => {
    const ready = vi.fn();
    const unready = vi.fn();
    const { rerender } = render(toggle(false, ready));
    const old = screen.getByTestId('toggle');
    rerender(toggle(true, unready));
    expect(screen.getByTestId('toggle')).not.toBe(old);
    expect(old.isConnected).toBe(false);
    fireEvent.click(old, { detail: 1 });
    expect(unready).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });

  it('keeps the element while the action stays the same', () => {
    const onPress = vi.fn();
    const { rerender } = render(toggle(false, onPress));
    const node = screen.getByTestId('toggle');
    rerender(toggle(false, onPress));
    expect(screen.getByTestId('toggle')).toBe(node);
  });

  it('fires a double click twice on the element that took both clicks, and never on one its first click drew', () => {
    const ready = vi.fn();
    const unready = vi.fn();
    const { rerender } = render(toggle(false, ready));
    fireEvent.click(screen.getByTestId('toggle'), { detail: 1 });
    fireEvent.click(screen.getByTestId('toggle'), { detail: 2 });
    expect(ready).toHaveBeenCalledTimes(2);

    rerender(toggle(true, unready));
    fireEvent.click(screen.getByTestId('toggle'), { detail: 2 });
    fireEvent.click(screen.getByTestId('toggle'), { detail: 3 });
    expect(unready).not.toHaveBeenCalled();
    // A keyboard press (detail 0) and a fresh click are presses.
    fireEvent.click(screen.getByTestId('toggle'), { detail: 0 });
    fireEvent.click(screen.getByTestId('toggle'), { detail: 1 });
    expect(unready).toHaveBeenCalledTimes(2);
  });

  it('moves keyboard focus to the replacement', () => {
    const { rerender } = render(toggle(false, () => undefined));
    screen.getByTestId('toggle').focus();
    rerender(toggle(true, () => undefined));
    expect(document.activeElement).toBe(screen.getByTestId('toggle'));
  });

  it('leaves focus alone when the old element did not have it', () => {
    const { rerender } = render(toggle(false, () => undefined));
    rerender(toggle(true, () => undefined));
    expect(document.activeElement).toBe(document.body);
  });
});
