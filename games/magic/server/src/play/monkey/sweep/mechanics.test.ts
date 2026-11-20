/*
 * The two reports the sweep was built on, as the check that names them.
 */
import { describe, expect, it } from 'vitest';

import type { CardSignature } from './expected.ts';
import { mechanicProblems } from './mechanics.ts';
import type { SetCard } from './set-cards.ts';

const card = (keywords: string[]): SetCard => ({ name: 'A Card', rarity: 'C', types: 'Creature', keywords, scripted: true });
const played = (...asks: string[]): CardSignature => ({ cast: 'resolved', asks, server: [] });

const GIFT = 'getChoices: Choose optional costs';
const OFFSPRING = 'bar: Pawpatch Recruit - Pay for Offspring? {2}';

describe('mechanicProblems', () => {
  it('passes a gift asked, taken in one run and refused in the other', () => {
    expect(mechanicProblems(card(['Gift']), played(GIFT), played(`${GIFT} (declined)`))).toEqual([]);
  });

  it('names a gift that is promised without asking', () => {
    expect(mechanicProblems(card(['Gift']), played(), played())).toEqual(['Gift: the cast never asked for it', 'Gift: the cast never asked for it when refusing']);
  });

  it('names a gift that cannot be refused', () => {
    expect(mechanicProblems(card(['Gift']), played(GIFT), played(GIFT))).toEqual(['Gift: it could not be refused, so it is not a "may"']);
  });

  it('names an offspring cost the seat was never asked', () => {
    expect(mechanicProblems(card(['Trample', 'Offspring']), played(), played())).toHaveLength(2);
    expect(mechanicProblems(card(['Trample', 'Offspring']), played(OFFSPRING), played(`${OFFSPRING} (declined)`))).toEqual([]);
  });

  it('asks nothing of a card without the keyword, and nothing of a variant that was not run', () => {
    expect(mechanicProblems(card(['Flying']), played(), played())).toEqual([]);
    expect(mechanicProblems(card(['Gift']), played(GIFT), undefined)).toEqual([]);
  });
});
