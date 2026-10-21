// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { DraftCard } from '../draft/types.ts';
import { setRolePlayer } from '../sound/index.ts';
import type { SoundEvent } from '../sound/mix.ts';
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
  setRolePlayer(null);
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
  it('opens on the first card', () => {
    mount();
    expect(screen.getByTestId('pack').className).toContain('pack--fan');
    expect(open()).toBe(0);
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
    expect(open()).toBe(1);
    // Whatever size a browser makes its notch: one notch, one card.
    wheel(120);
    wheel(100);
    expect(open()).toBe(3);
    wheel(-120);
    wheel(-100);
    expect(open()).toBe(1);
    for (let i = 0; i < 20; i++) wheel(-100);
    expect(open()).toBe(0);
    for (let i = 0; i < 30; i++) wheel(100);
    expect(open()).toBe(14);
  });

  it('adds up a trackpad’s small steps into whole cards', () => {
    mount();
    wheel(25);
    wheel(25);
    expect(open()).toBe(0);
    wheel(25);
    expect(open()).toBe(1);
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
    fireEvent.click(tile(0));
    expect(onPick).toHaveBeenCalledWith('c0');
  });

  it('draws seven cards from the first, and the rest once the row is scrolled to them', () => {
    mount();
    const drawn = () => [...document.querySelectorAll('.pack__slot')].flatMap((el, i) => (el.hasAttribute('data-off') ? [] : [i]));
    expect(drawn()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (let i = 0; i < 10; i++) wheel(100);
    expect(drawn()).toEqual([7, 8, 9, 10, 11, 12, 13]);
    for (let i = 0; i < 10; i++) wheel(100);
    expect(drawn()).toEqual([8, 9, 10, 11, 12, 13, 14]);
  });

  it('opens nothing by passing the pointer over a card', () => {
    mount();
    fireEvent.pointerMove(screen.getByTestId('pack'), { clientX: 10, clientY: 300 });
    fireEvent.pointerEnter(tile(5).parentElement!);
    expect(open()).toBe(0);
  });

  it('picks the open card on Enter, and moves along the row on the arrows', () => {
    const { onPick } = mount();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(open()).toBe(2);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(open()).toBe(1);
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('c1');
  });

  it('leaves Enter alone while it is typed into a field, or while picking is off', () => {
    const onPick = vi.fn();
    const field = document.createElement('input');
    document.body.append(field);
    const { rerender } = render(createElement(PackView, { cards: PACK, layout: 'fan', onPick, disabled: false, emptyNote: '' }));
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
    rerender(createElement(PackView, { cards: PACK, layout: 'fan', onPick, disabled: true, emptyNote: '' }));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
    field.remove();
  });

  it('plays the scroll sound once per step of the open card, and not on opening, at an end, or for a new pack', () => {
    const roles: string[] = [];
    setRolePlayer({ play: (e: SoundEvent) => void roles.push(e.role) });
    const { rerender, onPick } = mount();
    expect(roles).toEqual([]);
    wheel(100);
    wheel(100);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    // Opening a card by clicking it is a step, not a pick: no pick sound.
    fireEvent.click(tile(3));
    expect(open()).toBe(3);
    expect(roles).toEqual(['ui.draft-scroll', 'ui.draft-scroll', 'ui.draft-scroll', 'ui.draft-scroll']);
    fireEvent.click(tile(3));
    expect(onPick).toHaveBeenCalledWith(PACK[3]!.cardId);
    expect(roles.at(-1)).toBe('ui.draft-pick');
    roles.pop();
    for (let i = 0; i < 10; i++) wheel(-100);
    expect(roles).toHaveLength(7);
    rerender(createElement(PackView, { cards: PACK.slice(1), layout: 'fan', onPick, disabled: false, emptyNote: '' }));
    expect(roles).toHaveLength(7);
  });

  it('opens a new pack on its first card', () => {
    const { rerender, onPick } = mount();
    wheel(100);
    wheel(100);
    wheel(100);
    expect(open()).toBe(3);
    rerender(createElement(PackView, { cards: PACK.slice(1), layout: 'fan', onPick, disabled: false, emptyNote: '' }));
    expect(open()).toBe(0);
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

  it('picks the card under the pointer on Enter, and nothing once the pointer has left', () => {
    const onPick = vi.fn();
    render(createElement(PackView, { cards: PACK, layout: 'grid', onPick, disabled: false, emptyNote: '' }));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.pointerEnter(tile(9).parentElement!);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('c9');
    fireEvent.pointerLeave(screen.getByTestId('pack'));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledTimes(1);
  });
  // 15 cards in two rows of 8 columns at the stubbed 1000 x 600.
  it('moves a cursor with the arrow keys, a card along or a row up and down, and Enter picks it', () => {
    const onPick = vi.fn();
    render(createElement(PackView, { cards: PACK, layout: 'grid', onPick, disabled: false, emptyNote: '' }));
    expect(open()).toBe(-1);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(open()).toBe(0);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(open()).toBe(2);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(open()).toBe(10);
    // Past the bottom row it stays put.
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(open()).toBe(10);
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(open()).toBe(1);
    // The pointer moves the same cursor, and the keys go on from there.
    fireEvent.pointerEnter(tile(6).parentElement!);
    expect(open()).toBe(6);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('c7');
  });

  // The operator, 2026-10-20: the wheel over a hovered grid card should turn to its tokens too.
  it("gives a card's tokens to the inspector's wheel after its back face", () => {
    const fable: DraftCard = {
      ...card(0),
      scryfallId: '24c0d87b-0049-4beb-b9cb-6f813b7aa7dc',
      faces: [{ ...card(1), scryfallId: '24c0d87b-0049-4beb-b9cb-6f813b7aa7dc#back', name: 'Reflection of Kiki-Jiki' }],
    };
    render(createElement(PackView, { cards: [fable], layout: 'grid', onPick: vi.fn(), disabled: false, emptyNote: '' }));
    const key = tile(0).getAttribute('data-faces');
    const faces = [...document.querySelectorAll(`[data-faces-of="${key}"] .card`)].map((el) => el.querySelector('.card__name')?.textContent);
    expect(faces).toEqual(['Reflection of Kiki-Jiki', 'Treasure', 'Goblin Shaman', 'Copy']);
  });
});
