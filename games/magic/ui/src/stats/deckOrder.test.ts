import { describe, expect, it } from 'vitest';

import { byWinRate } from './deckOrder.ts';

const rec = (wins: number, losses: number) => ({ games: wins + losses, wins, losses, draws: 0 });
const ids = (xs: readonly { value: string }[]) => xs.map((x) => x.value);

describe('the deck picker, by win rate', () => {
  const options = ['a', 'b', 'c', 'd', 'e'].map((value) => ({ value }));

  it('puts played decks first, best win rate first', () => {
    const records = new Map([
      ['b', rec(1, 3)],
      ['d', rec(3, 1)],
      ['e', rec(2, 2)],
    ]);
    expect(ids(byWinRate(options, records))).toEqual(['d', 'e', 'b', 'a', 'c']);
  });

  it('breaks a tie on games played, then on the library order', () => {
    const records = new Map([
      ['c', rec(1, 0)],
      ['e', rec(3, 0)],
      ['a', rec(1, 0)],
    ]);
    expect(ids(byWinRate(options, records))).toEqual(['e', 'a', 'c', 'b', 'd']);
  });

  it('keeps the library order when nothing has been played, and does not touch its input', () => {
    const records = new Map([['b', { games: 0, wins: 0, losses: 0, draws: 0 }]]);
    expect(ids(byWinRate(options, records))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ids(options)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps a winless deck that has been played above the unplayed ones', () => {
    const records = new Map([['c', rec(0, 2)]]);
    expect(ids(byWinRate(options, records))).toEqual(['c', 'a', 'b', 'd', 'e']);
  });
});
