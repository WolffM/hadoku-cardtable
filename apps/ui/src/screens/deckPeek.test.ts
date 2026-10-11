import { describe, expect, it } from 'vitest';

import { peekOrder, type PeekLine } from './DeckPeek.tsx';

const line = (name: string, cost: string[], manaValue: number): PeekLine => ({ name, count: 1, cost, manaValue });

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
