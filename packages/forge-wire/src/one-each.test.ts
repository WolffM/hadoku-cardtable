/**
 * `one-each.ts`: which types a set of picks fills when a card of several types may count as any one
 * of them, decided only once the other picks force it.
 */
import { describe, expect, it } from 'vitest';

import { oneEachFit, type OneEachType } from './one-each.ts';

/** ac an artifact creature, a an artifact, c a creature, ae an artifact enchantment, e an enchantment. */
const TYPES: readonly OneEachType[] = [
  { type: 'Artifact', keys: ['ac', 'a', 'ae'] },
  { type: 'Creature', keys: ['ac', 'c'] },
  { type: 'Enchantment', keys: ['ae', 'e'] },
];

/** True when `fill` puts every one of `keys` in a type it is listed under, no type twice. */
const isMatching = (fill: ReadonlyMap<string, string>, keys: readonly string[]): boolean =>
  fill.size === keys.length &&
  [...fill].every(([type, key]) => TYPES.find((t) => t.type === type)!.keys.includes(key)) &&
  new Set(fill.values()).size === keys.length &&
  keys.every((k) => [...fill.values()].includes(k));

describe('a pick of one card per type is a matching, decided as late as it can be', () => {
  it('an artifact creature alone fills no type yet: it could be the Artifact or the Creature', () => {
    const fit = oneEachFit(TYPES, ['ac'])!;
    expect([...fit.filled]).toEqual([]);
    expect(fit.could.get('ac')).toEqual(['Artifact', 'Creature']);
    expect(oneEachFit(TYPES, ['ac', 'a'])).not.toBeNull();
    expect(oneEachFit(TYPES, ['ac', 'c'])).not.toBeNull();
  });

  it('then a creature makes the artifact creature the Artifact', () => {
    const fit = oneEachFit(TYPES, ['ac', 'c'])!;
    expect([...fit.filled].sort()).toEqual(['Artifact', 'Creature']);
    expect(fit.could.get('ac')).toEqual(['Artifact']);
    expect(fit.could.get('c')).toEqual(['Creature']);
    expect(fit.fill.get('Artifact')).toBe('ac');
    expect(oneEachFit(TYPES, ['ac', 'c', 'a']), 'no type is left for a plain artifact').toBeNull();
  });

  it('three ways: an artifact creature and an artifact enchantment leave all three types open until an enchantment comes', () => {
    const two = oneEachFit(TYPES, ['ac', 'ae'])!;
    expect([...two.filled]).toEqual([]);
    expect(two.could.get('ac')).toEqual(['Artifact', 'Creature']);
    expect(two.could.get('ae')).toEqual(['Artifact', 'Enchantment']);
    const three = oneEachFit(TYPES, ['ac', 'ae', 'e'])!;
    expect([...three.filled].sort()).toEqual(['Artifact', 'Creature', 'Enchantment']);
    expect(three.fill.get('Artifact')).toBe('ae');
    expect(three.fill.get('Creature')).toBe('ac');
    expect(isMatching(three.fill, ['ac', 'ae', 'e'])).toBe(true);
  });

  it('a type every filling needs is filled even when the card in it is not decided', () => {
    // a takes Artifact, so ac must be the Creature and ae the Enchantment.
    const fit = oneEachFit(TYPES, ['a', 'ac', 'ae'])!;
    expect([...fit.filled].sort()).toEqual(['Artifact', 'Creature', 'Enchantment']);
    expect(fit.could.get('ac')).toEqual(['Creature']);
    expect(fit.could.get('ae')).toEqual(['Enchantment']);
  });

  it('every accepted set has a concrete filling, earliest types to the earliest picks where it can', () => {
    const picks = ['ac', 'a', 'c', 'ae', 'e'];
    for (let mask = 1; mask < 1 << picks.length; mask++) {
      const keys = picks.filter((_, i) => mask & (1 << i));
      const fit = oneEachFit(TYPES, keys);
      if (fit !== null) expect(isMatching(fit.fill, keys), keys.join()).toBe(true);
    }
    expect(oneEachFit(TYPES, ['ac'])!.fill.get('Artifact')).toBe('ac');
    expect(oneEachFit(TYPES, [])!.fill.size).toBe(0);
  });
});
