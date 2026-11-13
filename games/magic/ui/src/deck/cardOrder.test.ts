import { describe, expect, it } from 'vitest';

import type { DraftCard } from '../draft/types.ts';
import { groupCards, sortCards } from './cardOrder.ts';

const card = (name: string, manaValue: number, colors: DraftCard['colors'], typeLine = 'Creature'): DraftCard =>
  ({ cardId: name, name, manaValue, colors, typeLine }) as DraftCard;

const CARDS = [
  card('Bolt', 1, ['R'], 'Instant'),
  card('Wrath', 4, ['W'], 'Sorcery'),
  card('Ponder', 1, ['U'], 'Sorcery'),
  card('Tarmogoyf', 2, ['G']),
  card('Expansion', 2, ['U', 'R'], 'Instant'),
  card('Sol Ring', 1, [], 'Artifact'),
  card('Wasteland', 0, [], 'Land'),
  card('Emrakul', 15, []),
];
const id = (c: DraftCard): DraftCard => c;

describe('one grouping for the picks and the deck builder', () => {
  it('by colour: the five, multicolour, colourless, lands; each by mana value then name', () => {
    expect(groupCards(CARDS, 'color', id).map(([g, cs]) => [g, cs.map((c) => c.name)])).toEqual([
      ['W', ['Wrath']],
      ['U', ['Ponder']],
      ['R', ['Bolt']],
      ['G', ['Tarmogoyf']],
      ['M', ['Expansion']],
      ['C', ['Sol Ring', 'Emrakul']],
      ['L', ['Wasteland']],
    ]);
  });

  it('by mana value: 0…6+, lands last; each by colour then name', () => {
    expect(groupCards(CARDS, 'mv', id).map(([g, cs]) => [g, cs.map((c) => c.name)])).toEqual([
      ['1', ['Ponder', 'Bolt', 'Sol Ring']],
      ['2', ['Tarmogoyf', 'Expansion']],
      ['4', ['Wrath']],
      ['6', ['Emrakul']],
      ['L', ['Wasteland']],
    ]);
  });

  it('keeps empty groups when asked (the deck’s piles)', () => {
    expect(groupCards([], 'mv', id, true).map(([g]) => g)).toEqual(['0', '1', '2', '3', '4', '5', '6', 'L']);
  });

  it('sorts by type: creatures, other spells, lands', () => {
    expect(sortCards(CARDS, 'type', id).map((c) => c.name)[0]).toBe('Tarmogoyf');
    expect(sortCards(CARDS, 'type', id).at(-1)!.name).toBe('Wasteland');
  });
});
