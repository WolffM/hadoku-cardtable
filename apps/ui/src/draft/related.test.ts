/*
 * The committed `related.json`, read as the fan and the inspector read it. The operator, 2026-10-27:
 * "Acererak the archlich isn't showing the tomb of annihilation as a token? also the zombie token
 * it's showing looks weird it has no stats on it."
 */

import { describe, expect, it } from 'vitest';

import { relatedCards } from './related.ts';

/** Unglued's Zombie token: Scryfall marks it textless — a picture with no type line and no power or toughness. */
const UNGLUED_ZOMBIE = '8e7b5995-ee8b-40d1-b157-8df96c02cc5b';

describe('related cards', () => {
  it('a venture card shows the three dungeons it can venture into, each with its art', () => {
    const related = relatedCards({ name: 'Acererak the Archlich' });
    const dungeons = related.filter((r) => ['Dungeon of the Mad Mage', 'Lost Mine of Phandelver', 'Tomb of Annihilation'].includes(r.name));
    expect(dungeons.map((r) => r.name).sort()).toEqual(['Dungeon of the Mad Mage', 'Lost Mine of Phandelver', 'Tomb of Annihilation']);
    expect(dungeons.filter((r) => r.id === undefined)).toEqual([]);
  });

  it('a token is drawn from a printing that shows its stats', () => {
    const zombie = relatedCards({ name: 'Acererak the Archlich' }).find((r) => r.name === 'Zombie');
    expect(zombie?.face.power, 'its power').toBe('2');
    expect(zombie?.id, 'not the textless Unglued printing').not.toBe(UNGLUED_ZOMBIE);
    expect(zombie?.id).not.toBeUndefined();
  });
});
