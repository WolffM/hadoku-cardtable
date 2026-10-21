// @vitest-environment jsdom
/*
 * A card's colour, drawn as a symbol (the operator, 2026-10-21): "i picked
 * 'Flame of Anor' and it's showing a white/blue symbol above it. that's a
 * red/blue card." — then: "just show a gold symbol for multi-color not what
 * you chose". A card or group of two or more colours shows ONE gold symbol,
 * never a pair; a mono card its colour; a colourless card the colourless one.
 * Hybrid pips inside a mana cost are cost symbols and are not touched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';

import poolData from '../draft/pool.json';
import type { DraftCard } from '../draft/types.ts';
import { DeckEditor } from '../deck/DeckEditor.tsx';
import { PoolView } from './PoolView.tsx';

afterEach(cleanup);

const POOL = (poolData as { cards: DraftCard[] }).cards;
const named = (name: string): DraftCard => POOL.find((c) => c.name === name)!;
const FLAME = named('Flame of Anor');

/** Every hybrid / guild pair class Mana has: none of them may stand for a card's colour. */
const PAIR_CLASSES = ['wu', 'wb', 'ub', 'ur', 'br', 'bg', 'rw', 'rg', 'gw', 'gu'].map((p) => `.ms-${p}`).join(',');

describe('a multicolour pick is drawn gold, never as a colour pair', () => {
  it('Flame of Anor (red/blue) sits under one gold symbol in the colour piles', () => {
    expect(FLAME.colors).toEqual(['R', 'U']);
    render(createElement(PoolView, { cards: [FLAME, named('Lutri, the Spellchaser')], recentlyAdded: null, groupBy: 'color' }));
    const pile = screen.getByTestId('pool-bucket-M');
    const head = pile.querySelector('.pool__bucket-title')!;
    expect(head.querySelector(PAIR_CLASSES)).toBeNull();
    expect(head.querySelectorAll('.ms-multicolor')).toHaveLength(1);
  });

  it("the picks' and the builder's colour sort buttons draw gold, not a pair", () => {
    render(createElement(PoolView, { cards: [FLAME], recentlyAdded: null, groupBy: 'color', onGroupBy: () => undefined }));
    const pickSort = screen.getByTestId('pool-sort-color');
    expect(pickSort.querySelector(PAIR_CLASSES)).toBeNull();
    expect(pickSort.querySelector('.ms-multicolor')).not.toBeNull();
    cleanup();
    render(createElement(DeckEditor, { mode: 'limited', draftId: 'd-cs', pool: [FLAME] }));
    const buildSort = screen.getByTestId('sort-color');
    expect(buildSort.querySelector(PAIR_CLASSES)).toBeNull();
    expect(buildSort.querySelector('.ms-multicolor')).not.toBeNull();
  });

  it("a mono pile keeps its colour's symbol, the colourless pile the colourless one", () => {
    const mono = POOL.find((c) => c.colors.length === 1 && c.colors[0] === 'R' && !/\bLand\b/.test(c.typeLine))!;
    const colourless = POOL.find((c) => c.colors.length === 0 && !/\bLand\b/.test(c.typeLine))!;
    render(createElement(PoolView, { cards: [mono, colourless], recentlyAdded: null, groupBy: 'color' }));
    expect(within(screen.getByTestId('pool-bucket-R')).getAllByRole('img')[0]!.className).toContain('ms-r');
    expect(within(screen.getByTestId('pool-bucket-C')).getAllByRole('img')[0]!.className).toContain('ms-c');
  });
});

describe("a card's colour stripe reads the colours in WUBRG order", () => {
  it('Flame of Anor, whose colours arrive as R then U, gets the blue/red stripe', () => {
    render(createElement(PoolView, { cards: [FLAME], recentlyAdded: null, groupBy: 'color' }));
    expect(screen.getByTestId('pool-bucket-M').querySelector('.card__stripe')!.getAttribute('data-identity')).toBe('ur');
  });

  // Every colour a card has gets its band: a stripe of three, four or five colours is not colourless.
  it('a card of three or more colours draws a band of each, in WUBRG order', () => {
    const base = POOL.find((c) => !/\bLand\b/.test(c.typeLine))!;
    const cards: DraftCard[] = [
      { ...base, cardId: 'c3', name: 'Three', colors: ['G', 'W', 'U'] },
      { ...base, cardId: 'c5', name: 'Five', colors: ['W', 'U', 'B', 'R', 'G'] },
    ];
    render(createElement(PoolView, { cards, recentlyAdded: null, groupBy: 'color' }));
    const stripes = [...screen.getByTestId('pool-bucket-M').querySelectorAll<HTMLElement>('.card__stripe')];
    const bands = (el: HTMLElement) => [...el.style.getPropertyValue('--stripe').matchAll(/--c-(\w+)/g)].map((m) => m[1]);
    expect(stripes.map(bands)).toEqual([
      ['white', 'blue', 'black', 'red', 'green'],
      ['white', 'blue', 'green'],
    ]);
  });
});

// A card's related cards ride as faces wherever its tile is drawn, so the inspector's wheel turns to them
// in the picks and the builder as it does in the pack — not only where one screen remembered to add them.
describe("a card's tokens are on its inspector wheel wherever it is drawn", () => {
  const OCELOT = named('Ocelot Pride');
  const facesOf = (tile: Element) =>
    [...document.querySelectorAll(`[data-faces-of="${tile.getAttribute('data-faces')}"] .card__name`)].map((el) => el.textContent);

  it('in the picks and in the builder', () => {
    render(createElement(PoolView, { cards: [OCELOT], recentlyAdded: null, groupBy: 'color' }));
    expect(facesOf(screen.getByTestId('pool').querySelector('[data-testid="card"]')!)).toEqual(['Cat']);
    cleanup();
    render(createElement(DeckEditor, { mode: 'limited', draftId: 'd-rf', pool: [OCELOT] }));
    expect(facesOf(screen.getByTestId('deck-editor').querySelector('[data-testid="card"]')!)).toEqual(['Cat']);
  });
});
