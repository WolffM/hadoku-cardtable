// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { artIdIndexFromTable, backFaceNames, scryfallIdFor, type ArtIdTableFile } from '@hadoku/carddata/art';
import artIdsData from '../draft/art-ids.json' with { type: 'json' };
import { cardImageUrl } from '../draft/cardImage.ts';
import { DeckPeek, namedFace, peekOrder, type PeekLine } from './DeckPeek.tsx';

const line = (name: string, cost: string[], manaValue: number, scryfallId?: string): PeekLine => ({
  name,
  count: 1,
  cost,
  manaValue,
  face: namedFace(name, cost, manaValue, scryfallId),
});

afterEach(cleanup);

describe('a peeked list, in reading order', () => {
  it('draws spells by mana value then name, then the cards with no cost by name', () => {
    const { spells, free } = peekOrder([
      line('Mountain', [], 0),
      line('Lightning Bolt', ['R'], 1),
      line('Ancestral Vision', [], 0),
      line('Goblin Guide', ['R'], 1),
      line('Fireball', ['X', 'R'], 1),
      line('Inferno Titan', ['4', 'R', 'R'], 6),
    ]);
    expect(spells.map((l) => l.name)).toEqual(['Fireball', 'Goblin Guide', 'Lightning Bolt', 'Inferno Titan']);
    expect(free.map((l) => l.name)).toEqual(['Ancestral Vision', 'Mountain']);
  });
});

// The operator, 2026-10-16: "when hovering cards in the decklist let's show the expanded card".
describe('hovering a line of a peeked list', () => {
  const ISLAND = scryfallIdFor(artIdIndexFromTable(artIdsData as ArtIdTableFile), 'Island', '');

  function peek() {
    const box = new DOMRect(0, 0, 100, 100);
    render(
      createElement(DeckPeek, {
        id: 'deck-peek',
        label: 'Blue',
        colors: ['U'],
        list: {
          main: [line('Island', [], 0, ISLAND), line('Counterspell', ['U', 'U'], 2)],
          sideboard: [line('Negate', ['1', 'U'], 2)],
        },
        anchor: box,
        bounds: new DOMRect(0, 0, 1280, 800),
      }),
    );
    const lineOf = (name: string) =>
      [...screen.getByTestId('deck-peek').querySelectorAll('.peek__line')].find((li) => li.textContent?.includes(name))!;
    const panel = () => document.querySelector('.peek__zoom [data-inspect]');
    return { lineOf, panel };
  }

  it('enlarges the card in the one inspector, with the art the board would show', () => {
    expect(ISLAND).toBeDefined();
    const { lineOf, panel } = peek();
    expect(panel()).toBeNull();
    fireEvent.pointerOver(lineOf('Island'), { pointerType: 'mouse' });
    const art = panel()?.querySelector('img');
    expect(art?.getAttribute('src')).toBe(cardImageUrl(ISLAND));
    expect(panel()!.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows a card with no art as its text tile, the sideboard included, and closes when the pointer leaves the line', () => {
    const { lineOf, panel } = peek();
    fireEvent.pointerOver(lineOf('Negate'), { pointerType: 'mouse' });
    expect(panel()!.querySelector('img')).toBeNull();
    expect(panel()!.querySelector('.card__name')!.textContent).toBe('Negate');
    fireEvent.pointerOut(lineOf('Negate'), { pointerType: 'mouse', relatedTarget: screen.getByTestId('deck-peek') });
    expect(panel()).toBeNull();
  });

  // The operator, 2026-10-19, on Etali: "why can i not scroll to see it?" A library line is a name, and
  // the art table alone names its back face.
  it('turns a two-faced line to its back face on the wheel, the back’s own art', () => {
    const table = artIdIndexFromTable(artIdsData as ArtIdTableFile);
    const id = scryfallIdFor(table, 'Etali, Primal Conqueror', '');
    const box = new DOMRect(0, 0, 100, 100);
    const etali: PeekLine = { name: 'Etali, Primal Conqueror', count: 1, cost: ['5', 'R', 'R'], manaValue: 7, face: namedFace('Etali, Primal Conqueror', ['5', 'R', 'R'], 7, id, backFaceNames(table, id)) };
    render(createElement(DeckPeek, { id: 'deck-peek', label: 'Red', colors: ['R'], list: { main: [etali], sideboard: [] }, anchor: box, bounds: new DOMRect(0, 0, 1280, 800) }));
    const li = screen.getByTestId('deck-peek').querySelector('.peek__line')!;
    fireEvent.pointerOver(li, { pointerType: 'mouse' });
    const panel = () => document.querySelector('.peek__zoom [data-inspect]');
    expect(panel()?.querySelector('.card__name')?.textContent).toBe('Etali, Primal Conqueror');
    fireEvent.wheel(li, { deltaY: 100 });
    expect(panel()?.querySelector('.card__name')?.textContent).toBe('Etali, Primal Sickness');
    expect(panel()?.querySelector('img')?.getAttribute('src')).toBe(cardImageUrl(`${id}#back`));
  });

  it('stays a tooltip: no dialog, nothing to tab to, the hidden faces out of the reading order', () => {
    peek();
    const el = screen.getByTestId('deck-peek');
    expect(el.getAttribute('role')).toBe('tooltip');
    expect(el.hasAttribute('aria-modal')).toBe(false);
    expect(el.querySelectorAll('[tabindex], button, a, input')).toHaveLength(0);
    expect(el.querySelector('[data-testid="card"]')!.closest('[hidden]')).not.toBeNull();
  });
});
