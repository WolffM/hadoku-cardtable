// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { DraftCard } from '../draft/types.ts';
import { PackView } from './PackView.tsx';

function card(i: number): DraftCard {
  return {
    cardId: `c${i}`,
    name: `Card ${i}`,
    manaCost: ['1'],
    manaValue: 1,
    colors: [],
    typeLine: 'Artifact',
    oracleText: '',
    setCode: 'TST',
    collectorNumber: String(i),
    rarity: 'common',
  };
}
const PACK = Array.from({ length: 15 }, (_, i) => card(i));

// The fan draws only once it has measured its box; jsdom has no layout, so the
// box is a stub: 1000 x 600, the size of the pack's three quarters on a laptop.
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly cb: () => void) {}
      observe(): void {
        this.cb();
      }
      disconnect(): void {}
    },
  );
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1000, height: 600, left: 0, top: 0, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const open = (): number => [...document.querySelectorAll('.pack__slot')].findIndex((s) => s.hasAttribute('data-focused'));
const tile = (i: number) => screen.getAllByTestId('card')[i]!;
const wheel = (deltaY: number) =>
  act(() => {
    screen.getByTestId('pack').dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
  });

function mount(onPick = vi.fn()) {
  const utils = render(createElement(PackView, { cards: PACK, layout: 'fan', onPick, disabled: false, emptyNote: '' }));
  return { onPick, ...utils };
}

describe('the fan', () => {
  it('opens on the middle card', () => {
    mount();
    expect(screen.getByTestId('pack').className).toContain('pack--fan');
    expect(open()).toBe(7);
  });

  // The operator, 2026-10-19: the fan's open card is already full size, so no enlarged copy beside it.
  it('gives the shared inspector nothing to open in the fan', () => {
    mount();
    const slots = [...screen.getByTestId('pack').querySelectorAll('.pack__slot')];
    expect(slots.filter((el) => /^w\d+$/.test(el.getAttribute('data-card-id') ?? ''))).toEqual([]);
  });

  it('steps one card per wheel notch, either way, and stops at the ends', () => {
    mount();
    wheel(100);
    expect(open()).toBe(8);
    // Whatever size a browser makes its notch: one notch, one card.
    wheel(120);
    wheel(100);
    expect(open()).toBe(10);
    wheel(-120);
    wheel(-100);
    expect(open()).toBe(8);
    wheel(-100);
    wheel(-100);
    expect(open()).toBe(6);
    for (let i = 0; i < 20; i++) wheel(-100);
    expect(open()).toBe(0);
    for (let i = 0; i < 30; i++) wheel(100);
    expect(open()).toBe(14);
  });

  it('adds up a trackpad’s small steps into whole cards', () => {
    mount();
    wheel(25);
    wheel(25);
    expect(open()).toBe(7);
    wheel(25);
    expect(open()).toBe(8);
  });

  it('stops the wheel from scrolling anything else', () => {
    mount();
    const e = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    act(() => {
      screen.getByTestId('pack').dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
  });

  it('opens a card that is not open on the first click, and picks it on the next', () => {
    const { onPick } = mount();
    fireEvent.click(tile(3));
    expect(onPick).not.toHaveBeenCalled();
    expect(open()).toBe(3);
    fireEvent.click(tile(3));
    expect(onPick).toHaveBeenCalledWith('c3');
  });

  it('picks the open card on one click', () => {
    const { onPick } = mount();
    fireEvent.click(tile(7));
    expect(onPick).toHaveBeenCalledWith('c7');
  });

  it('opens the middle of a new pack', () => {
    const { rerender, onPick } = mount();
    wheel(100);
    wheel(100);
    wheel(100);
    expect(open()).toBe(10);
    rerender(createElement(PackView, { cards: PACK.slice(1), layout: 'fan', onPick, disabled: false, emptyNote: '' }));
    expect(open()).toBe(6);
  });
});

describe('the grid', () => {
  it('picks on one click, with no card held open', () => {
    const onPick = vi.fn();
    render(createElement(PackView, { cards: PACK, layout: 'grid', onPick, disabled: false, emptyNote: '' }));
    expect(open()).toBe(-1);
    fireEvent.click(tile(3));
    expect(onPick).toHaveBeenCalledWith('c3');
  });
});
