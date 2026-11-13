// @vitest-environment jsdom
/*
 * The deck grid's peek against React's own timing. `constructed.test.ts` drives
 * the whole room; this renders `DeckChooser` alone, so a test can stand in the
 * gap a room-level test only lands in by chance: after React has COMMITTED a new
 * list, before it has run that commit's passive effects.
 */
import { fireEvent as dispatch } from '@testing-library/dom';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeckChooser, type DeckOption } from './ConstructedScreen.tsx';
import { namedFace, PEEK_DELAY_MS, type PeekList } from './DeckPeek.tsx';

const list = (card: string): PeekList => ({
  main: [{ name: card, count: 4, cost: ['1', 'R'], manaValue: 2, face: namedFace(card, ['1', 'R'], 2, undefined) }],
  sideboard: [],
});
const option = (value: string, name: string, card: string): DeckOption => ({ value, label: name, name, colors: ['R'], list: list(card) });
const JUND = option('jund', 'Jund', 'Bloodbraid Elf');
const UG = option('ug', 'UG Polymorph', 'Polymorph');

const props = (options: readonly DeckOption[]) => ({ options, value: '', disabled: false, onChoose: () => undefined, swapKey: 'era' });

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

/** Resolves at the first DOM change under `el` after which `done` holds: a microtask after React's commit, ahead of its passive-effect task. */
const nextMutation = (el: HTMLElement, done: () => boolean): Promise<void> =>
  new Promise((resolve) => {
    const seen = new MutationObserver(() => {
      if (!done()) return;
      seen.disconnect();
      resolve();
    });
    seen.observe(el, { childList: true, subtree: true, attributes: true });
  });

const tileOf = (value: string): HTMLElement | null => host!.querySelector<HTMLElement>(`[data-deck-id="${value}"]`);
// Drawn over the page (`../components/OverPage.tsx`), not inside the grid's host.
const peekTitle = (): string | null | undefined => document.querySelector('[data-testid="deck-peek"] .peek__title')?.textContent;
const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** A grid inside the room's screen, the box a peek is placed within. */
function mount(): Root {
  host = document.body.appendChild(document.createElement('div'));
  host.dataset.testid = 'constructed';
  root = createRoot(host);
  return root;
}

/** The grid drawing `options`, once their first screen of art is ready (`deckSwap.ts`). */
async function drawGrid(options: readonly DeckOption[]): Promise<Root> {
  const grid = mount();
  act(() => grid.render(createElement(DeckChooser, props(options))));
  await waitFor(() => expect(tileOf(options[0]!.value)).not.toBeNull());
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return grid;
}

describe('the deck grid’s peek', () => {
  it('opens for a pointer that rests on a tile the moment its list is drawn, before the list’s effects have run', async () => {
    const grid = mount();
    // The grid before the pool answers: outlines, no tiles.
    act(() => grid.render(createElement(DeckChooser, { ...props([]), pending: true })));
    // The answer lands from a fetch, outside any `act`: React commits it, then runs its effects in a task of its own.
    const drawn = nextMutation(host!, () => tileOf(JUND.value) !== null);
    grid.render(createElement(DeckChooser, props([UG, JUND])));
    await drawn;
    // A pointer arriving in that gap: the tile is on screen, the list's effects are still queued. Sent
    // outside `act`, which would run them first; React's `onPointerEnter` comes of the `pointerover`.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    dispatch.pointerOver(tileOf(JUND.value)!, { pointerType: 'mouse' });
    await advance(PEEK_DELAY_MS);
    expect(peekTitle()).toBe('Jund');
  });

  it('opens the rested-on deck’s own list when the grid reorders under the pointer', async () => {
    const grid = await drawGrid([UG, JUND]);
    fireEvent.pointerEnter(tileOf(JUND.value)!, { pointerType: 'mouse' });
    // Win rates land mid-delay and put Jund first: the deck at the hovered index is now another one.
    act(() => grid.render(createElement(DeckChooser, props([JUND, UG]))));
    await advance(PEEK_DELAY_MS);
    expect(peekTitle()).toBe('Jund');
    expect(tileOf(JUND.value)!.getAttribute('aria-describedby')).toBe('deck-peek');
    expect(tileOf(UG.value)!.hasAttribute('aria-describedby')).toBe(false);
  });

  it('draws an open list only over the grid it was placed beside', async () => {
    const grid = await drawGrid([UG, JUND]);
    fireEvent.pointerEnter(tileOf(JUND.value)!, { pointerType: 'mouse' });
    await advance(PEEK_DELAY_MS);
    expect(peekTitle()).toBe('Jund');
    // A filter takes Jund off the grid, then puts it back somewhere else: the list's place beside it is gone.
    act(() => grid.render(createElement(DeckChooser, props([UG]))));
    expect(peekTitle()).toBeUndefined();
    act(() => grid.render(createElement(DeckChooser, props([JUND, UG]))));
    expect(peekTitle()).toBeUndefined();
    expect(tileOf(JUND.value)!.hasAttribute('aria-describedby')).toBe(false);
  });
});
