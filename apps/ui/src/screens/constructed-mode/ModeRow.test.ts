// @vitest-environment jsdom
/*
 * The mode row's two sizes: large while no mode is chosen, compact once one is,
 * and the change between them made inside a view transition where the browser
 * has one and the person has not asked for less motion.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';

import { ART_WAIT_MS, ModeRow } from './ModeRow.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (document as { startViewTransition?: unknown }).startViewTransition;
});

const group = (): HTMLElement => screen.getByTestId('constructed-mode');
const row = (mode: 'classic' | 'gauntlet' | 'random' | null) => createElement(ModeRow, { mode, disabled: false, onChoose: () => {} });

describe('ModeRow', () => {
  it('is large while no mode is chosen: each mode its name over its art, from the CDN', () => {
    render(row(null));
    expect(group().classList.contains('radio-cards--large')).toBe(true);
    const art = [...group().querySelectorAll<HTMLImageElement>('img.radio-cards__art')];
    expect(art).toHaveLength(3);
    for (const img of art) {
      expect(img.getAttribute('src')).toMatch(/^https:\/\/cdn\.hadoku\.me\/[0-9a-f]{64}\.webp$/);
      expect(img.getAttribute('alt'), 'decoration: the name says which mode').toBe('');
    }
    expect(group().textContent).toBe('ClassicGauntletAll Random');
  });

  it('is the compact row once a mode is chosen, with no art', () => {
    render(row('gauntlet'));
    expect(group().classList.contains('radio-cards--large')).toBe(false);
    expect(group().querySelector('img')).toBeNull();
    expect((screen.getByTestId('constructed-mode-gauntlet') as HTMLInputElement).checked).toBe(true);
  });

  it('shrinks inside a view transition, each card named for it', () => {
    const transition = vi.fn((update: () => void) => {
      update();
      return { finished: Promise.resolve() };
    });
    (document as { startViewTransition?: unknown }).startViewTransition = transition;
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const { rerender } = render(row(null));
    const card = screen.getByTestId('constructed-mode-classic').closest('label')!;
    expect(card.style.viewTransitionName).toBe('constructed-mode-classic');
    rerender(row('classic'));
    expect(transition).toHaveBeenCalledTimes(1);
    expect(group().classList.contains('radio-cards--large')).toBe(false);
  });

  it('marks which way the cards go on the page for the length of the transition, and clears it after', async () => {
    let finish!: () => void;
    const finished = new Promise<void>((done) => (finish = done));
    (document as { startViewTransition?: unknown }).startViewTransition = (update: () => void) => {
      update();
      return { finished };
    };
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const { rerender } = render(row(null));
    rerender(row('classic'));
    expect(document.documentElement.dataset.modeMorph).toBe('shrink');
    await act(async () => {
      finish();
      await finished;
    });
    expect(document.documentElement.dataset.modeMorph).toBeUndefined();
  });

  it('grows back only once the art is ready, or after ART_WAIT_MS at the most', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const transition = vi.fn((update: () => void) => {
      update();
      return { finished: Promise.resolve() };
    });
    (document as { startViewTransition?: unknown }).startViewTransition = transition;
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    try {
      const { rerender } = render(row('gauntlet'));
      rerender(row(null));
      // The art in the test DOM has nothing to decode, so the grow runs on the next turn, well inside the cap.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ART_WAIT_MS);
      });
      expect(transition).toHaveBeenCalledTimes(1);
      expect(group().classList.contains('radio-cards--large')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('changes at once when the person asks for less motion', () => {
    const transition = vi.fn();
    (document as { startViewTransition?: unknown }).startViewTransition = transition;
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const { rerender } = render(row(null));
    rerender(row('random'));
    expect(transition).not.toHaveBeenCalled();
    expect(group().classList.contains('radio-cards--large')).toBe(false);
  });
});
