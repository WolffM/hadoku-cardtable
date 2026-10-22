// @vitest-environment jsdom
/*
 * The mode row's two sizes: large while no mode is chosen, compact once one is,
 * and the change between them one animation of the cards themselves where the
 * browser animates elements and the person has not asked for less motion.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';

import { ModeRow } from './ModeRow.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (Element.prototype as { animate?: unknown }).animate;
});

const group = (): HTMLElement => screen.getByTestId('constructed-mode');
const row = (mode: 'classic' | 'gauntlet' | 'random' | null) => createElement(ModeRow, { mode, disabled: false, onChoose: () => {} });

/** `Element.animate` as the browser has it, recording each call; every animation finishes when `finish` is called. */
function stubAnimate() {
  let finish!: () => void;
  const finished = new Promise<void>((done) => (finish = done));
  const calls: { el: Element; keyframes: Keyframe[] }[] = [];
  const cancel = vi.fn();
  (Element.prototype as { animate?: unknown }).animate = function (this: Element, keyframes: Keyframe[]) {
    calls.push({ el: this, keyframes });
    return { finished, cancel };
  };
  return { calls, cancel, finish: () => finish(), finished };
}

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

  it('is the compact row once a mode is chosen, its art still in the page for the cards to grow back with', () => {
    render(row('gauntlet'));
    expect(group().classList.contains('radio-cards--large')).toBe(false);
    expect(group().querySelectorAll('img.radio-cards__art'), 'loaded already, hidden by the small size').toHaveLength(3);
    expect((screen.getByTestId('constructed-mode-gauntlet') as HTMLInputElement).checked).toBe(true);
  });

  it('changes size in one animation of the cards themselves, which the row takes back when it ends', async () => {
    const animate = stubAnimate();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const { rerender } = render(row(null));
    rerender(row('classic'));

    expect(group().classList.contains('radio-cards--large'), 'the page is already the compact row').toBe(false);
    expect(group().parentElement!.hasAttribute('data-morphing'), 'the cards are placed by the animation while it runs').toBe(true);
    const cards = [...group().querySelectorAll('.radio-cards__card')];
    for (const card of cards) {
      const own = animate.calls.find((c) => c.el === card);
      expect(own?.keyframes, 'each card moves from its old box to its new one').toHaveLength(2);
      expect(Object.keys(own!.keyframes[0]!)).toEqual(expect.arrayContaining(['left', 'top', 'width', 'height']));
    }
    expect(animate.calls.some((c) => c.el === group()), 'the row’s own size follows, and the room’s box with it').toBe(true);

    await act(async () => {
      animate.finish();
      await animate.finished;
    });
    expect(group().parentElement!.hasAttribute('data-morphing')).toBe(false);
    expect(animate.cancel, 'the animations’ held end is let go: the layout is where they ended').toHaveBeenCalled();
  });

  it('grows back the same way, in one animation and nothing waited for', () => {
    const animate = stubAnimate();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const { rerender } = render(row('random'));
    rerender(row(null));
    expect(group().classList.contains('radio-cards--large')).toBe(true);
    expect(animate.calls.length).toBeGreaterThan(0);
  });

  it('changes at once when the person asks for less motion', () => {
    const animate = stubAnimate();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const { rerender } = render(row(null));
    rerender(row('random'));
    expect(animate.calls).toHaveLength(0);
    expect(group().classList.contains('radio-cards--large')).toBe(false);
    expect(group().parentElement!.hasAttribute('data-morphing')).toBe(false);
  });

  it('disables Gauntlet alone while the room’s Tournament setting is on — Classic and All Random stay live', () => {
    render(createElement(ModeRow, { mode: 'classic', disabled: false, gauntletDisabled: true, onChoose: () => {} }));
    expect((screen.getByTestId('constructed-mode-gauntlet') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('constructed-mode-classic') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByTestId('constructed-mode-random') as HTMLInputElement).disabled).toBe(false);
  });

  it('leaves every card enabled when gauntletDisabled is left out', () => {
    render(row('classic'));
    expect((screen.getByTestId('constructed-mode-gauntlet') as HTMLInputElement).disabled).toBe(false);
  });
});
