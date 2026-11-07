// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Reveal, REVEAL_MS } from './Reveal.tsx';

describe('Reveal tells its owner when the box is shown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('only once the crossfade is done and the box says so, and again when the skeleton comes back', () => {
    const heard: { shown: boolean; phase: string | null }[] = [];
    const box = (): HTMLElement => document.querySelector('[data-reveal="x"]') as HTMLElement;
    const view = (shown: boolean) =>
      createElement(Reveal, { name: 'x', shown, skeleton: 'wait', onShown: (s: boolean) => heard.push({ shown: s, phase: box().getAttribute('data-phase') }) }, 'body');
    const { rerender } = render(view(false));
    rerender(view(true));
    act(() => vi.advanceTimersByTime(REVEAL_MS - 1));
    expect(heard.some((h) => h.shown)).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(heard.at(-1)).toEqual({ shown: true, phase: 'shown' });
    rerender(view(false));
    expect(heard.at(-1)).toEqual({ shown: false, phase: 'waiting' });
  });
});
