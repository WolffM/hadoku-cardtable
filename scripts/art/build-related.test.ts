/*
 * `scryfallParts`: what a card makes, as Scryfall lists it beside the card. The operator, 2026-10-27,
 * of Acererak the Archlich: "isn't showing the tomb of annihilation as a token?" — Scryfall lists a
 * venture card's dungeons, and a planeswalker's emblem, as `combo_piece`s, not `token`s.
 */

import { describe, expect, it } from 'vitest';

import { scryfallParts, type Row } from './build-related.ts';

const acererak: Row = {
  id: 'acererak',
  name: 'Acererak the Archlich',
  all_parts: [
    { id: 'mad-mage', component: 'combo_piece', name: 'Dungeon of the Mad Mage', type_line: 'Dungeon' },
    { id: 'acererak', component: 'combo_piece', name: 'Acererak the Archlich', type_line: 'Legendary Creature — Zombie Wizard' },
    { id: 'lost-mine', component: 'combo_piece', name: 'Lost Mine of Phandelver', type_line: 'Dungeon' },
    { id: 'tomb', component: 'combo_piece', name: 'Tomb of Annihilation', type_line: 'Dungeon' },
    { id: 'zombie', component: 'token', name: 'Zombie', type_line: 'Token Creature — Zombie' },
  ],
};

describe('scryfallParts', () => {
  it('lists a venture card’s dungeons beside its tokens', () => {
    expect(scryfallParts(acererak).map((p) => [p.name, p.id])).toEqual([
      ['Dungeon of the Mad Mage', 'mad-mage'],
      ['Lost Mine of Phandelver', 'lost-mine'],
      ['Tomb of Annihilation', 'tomb'],
      ['Zombie', 'zombie'],
    ]);
  });

  it('lists a planeswalker’s emblem', () => {
    const tamiyo: Row = {
      id: 'tamiyo',
      name: 'Tamiyo, Field Researcher',
      all_parts: [{ id: 'emblem', component: 'combo_piece', name: 'Tamiyo, Field Researcher Emblem', type_line: 'Emblem — Tamiyo' }],
    };
    expect(scryfallParts(tamiyo).map((p) => p.name)).toEqual(['Tamiyo, Field Researcher Emblem']);
  });

  it('leaves out a combo piece the card does not make: a checklist, a morph reminder, a card it names', () => {
    const row: Row = {
      id: 'x',
      name: 'Herdchaser Dragon',
      all_parts: [
        { id: 'morph', component: 'combo_piece', name: 'Morph', type_line: 'Card' },
        { id: 'list', component: 'combo_piece', name: 'Onslaught Checklist', type_line: 'Card' },
        { id: 'named', component: 'combo_piece', name: 'Kyscu Drake', type_line: 'Creature — Drake' },
      ],
    };
    expect(scryfallParts(row)).toEqual([]);
  });
});
