/*
 * `buildCatalog` against two synthetic cards — a transform card (Jace,
 * Vryn's Prodigy) and a split card (Fire // Ice) — pinning the colour fix
 * `../draft-card.ts`'s `cardColors` carries (wave 73 §C follow-up 2).
 *
 * Before the fix, `build-catalog.ts` had its own copy of the projection that
 * read a card's colour straight off the top-level `colors` field. Scryfall
 * leaves that `null` for `transform`/`modal_dfc` layouts (the real colour
 * lives on each face instead — `build-pool.ts`'s own `cardColors` fix,
 * `build-pool.test.ts`), so the catalog built from `cards.jsonl` shipped
 * Jace, Vryn's Prodigy as colourless (`[]`) — the operator's report: "I built
 * it at ~/.local/share/cardtable/catalog/cards.json and Jace came out
 * colourless". This file proves the catalog now shares `build-pool.ts`'s fix
 * rather than carrying a second, stale copy.
 */

import { describe, expect, it } from 'vitest';
import { buildCardIndex } from '../resolve.ts';
import type { GameplayCard } from '../scryfall/project.ts';
import { buildCatalog } from './build-catalog.ts';

const JACE = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: "Jace, Vryn's Prodigy // Jace, Telepath Unbound",
  lang: 'en',
  set: 'ori',
  collector_number: '60',
  released_at: '2015-07-17',
  layout: 'transform',
  colors: null,
  mana_cost: null,
  cmc: 2,
  card_faces: [
    {
      name: "Jace, Vryn's Prodigy",
      mana_cost: '{1}{U}',
      colors: ['U'],
      type_line: 'Legendary Creature — Human Wizard',
      oracle_text: 'Whenever Jace, Vryn\'s Prodigy deals combat damage to a player, draw a card. Then if you have seven or more cards in hand, exile Jace, then return him to the battlefield transformed under his owner\'s control.',
      power: '0',
      toughness: '2',
    },
    {
      name: 'Jace, Telepath Unbound',
      mana_cost: '',
      colors: ['U'],
      type_line: 'Legendary Planeswalker — Jace',
      oracle_text: '+1: Up to one target creature gets -2/-0 until your next turn.\n-3: You may cast target instant or sorcery card from your graveyard this turn. If that spell would be put into a graveyard this turn, exile it instead.',
      loyalty: '5',
    },
  ],
} as unknown as GameplayCard;

const FIRE_ICE = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'Fire // Ice',
  lang: 'en',
  set: 'apc',
  collector_number: '119',
  released_at: '2001-06-04',
  layout: 'split',
  colors: null,
  mana_cost: null,
  cmc: 2,
  card_faces: [
    { name: 'Fire', mana_cost: '{1}{R}', colors: ['R'], type_line: 'Instant', oracle_text: 'Fire deals 2 damage divided as you choose among one or two targets.' },
    { name: 'Ice', mana_cost: '{1}{U}', colors: ['U'], type_line: 'Instant', oracle_text: 'Tap target permanent. Draw a card.' },
  ],
} as unknown as GameplayCard;

describe('buildCatalog', () => {
  it("gives Jace, Vryn's Prodigy // Jace, Telepath Unbound its front face's colour, ['U'], not colourless", () => {
    const index = buildCardIndex([JACE]);
    const catalog = buildCatalog(index);
    const jace = catalog.cards['jace, vryn\'s prodigy // jace, telepath unbound'] as { colors: unknown } | undefined;
    expect(jace).toBeDefined();
    expect(jace?.colors).toEqual(['U']);
  });

  it("gives Fire // Ice the union of its two faces' colours, ['R','U']", () => {
    const index = buildCardIndex([FIRE_ICE]);
    const catalog = buildCatalog(index);
    const fireIce = catalog.cards['fire // ice'] as { colors: unknown } | undefined;
    expect(fireIce).toBeDefined();
    expect(fireIce?.colors).toEqual(['R', 'U']);
  });

  it('still aliases the bare front face to the canonical card', () => {
    const index = buildCardIndex([JACE]);
    const catalog = buildCatalog(index);
    expect(catalog.aliases["jace, vryn's prodigy"]).toBe("jace, vryn's prodigy // jace, telepath unbound");
  });
});
