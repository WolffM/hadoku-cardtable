/*
 * A card's Scryfall oracle id, from the raw Scryfall record to the catalog's `DraftCard`: the
 * projection keeps it, `toDraftCard` carries it as `oracleId`. Oracle ids key a card across every
 * printing, which is how an outside service (CubeCobra's draftbot) names it.
 *
 * Where Scryfall puts it, checked against the host's bulk cache and Scryfall's API (2026-11-06):
 * every layout but `reversible_card` carries it at the top level and none of them on a face;
 * `reversible_card` carries it only on each face (both faces the same id).
 */

import { describe, expect, it } from 'vitest';
import { buildCatalog } from './catalog-build.ts';
import { toDraftCard } from './draft-card.ts';
import { buildCardIndex } from './resolve.ts';
import { projectCard, type RawCard } from './scryfall/project.ts';

const FIRE_ICE_ORACLE = '3fa7b6b3-1e3d-4ad5-b2f6-0b1f7c3d5a01';
const DELVER_ORACLE = '5c6e4a2b-7d8f-4e1a-9b3c-2d4e6f8a0b02';
const JINNIE_ORACLE = '61fbaaf2-4286-4e9a-b9cb-aa31262b596a';

/** A split card: oracle id at the top, none on either half. */
const FIRE_ICE: RawCard = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  oracle_id: FIRE_ICE_ORACLE,
  name: 'Fire // Ice',
  lang: 'en',
  layout: 'split',
  set: 'apc',
  collector_number: '128',
  rarity: 'uncommon',
  mana_cost: '{1}{R} // {1}{U}',
  cmc: 4,
  colors: ['R', 'U'],
  type_line: 'Instant // Instant',
  card_faces: [
    { object: 'card_face', name: 'Fire', mana_cost: '{1}{R}', colors: ['R'], type_line: 'Instant', oracle_text: 'Fire deals 2 damage divided as you choose among one or two targets.' },
    { object: 'card_face', name: 'Ice', mana_cost: '{1}{U}', colors: ['U'], type_line: 'Instant', oracle_text: 'Tap target permanent.\nDraw a card.' },
  ],
};

/** A transform DFC: oracle id at the top, none on either face. */
const DELVER: RawCard = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  oracle_id: DELVER_ORACLE,
  name: 'Delver of Secrets // Insectile Aberration',
  lang: 'en',
  layout: 'transform',
  set: 'isd',
  collector_number: '51',
  rarity: 'common',
  cmc: 1,
  card_faces: [
    { object: 'card_face', name: 'Delver of Secrets', mana_cost: '{U}', colors: ['U'], type_line: 'Creature — Human Wizard', oracle_text: 'At the beginning of your upkeep, look at the top card of your library.', power: '1', toughness: '1' },
    { object: 'card_face', name: 'Insectile Aberration', mana_cost: '', colors: ['U'], type_line: 'Creature — Human Insect', oracle_text: 'Flying', power: '3', toughness: '2' },
  ],
};

/** A reversible card: no top-level oracle id, each face carries it (Scryfall's own shape for Jinnie Fay, SLD). */
const JINNIE: RawCard = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  name: "Jinnie Fay, Jetmir's Second // Jinnie Fay, Jetmir's Second",
  lang: 'en',
  layout: 'reversible_card',
  set: 'sld',
  collector_number: '1458',
  rarity: 'rare',
  card_faces: [
    { object: 'card_face', oracle_id: JINNIE_ORACLE, name: "Jinnie Fay, Jetmir's Second", mana_cost: '{R/G}{G/W}{G/W}', cmc: 3, colors: ['G', 'R', 'W'], type_line: 'Legendary Creature — Elf Druid', oracle_text: 'If you would create one or more tokens, you may instead create that many 2/2 green Cat creature tokens with haste or that many 3/1 green Dog creature tokens with vigilance.', power: '3', toughness: '3' },
    { object: 'card_face', oracle_id: JINNIE_ORACLE, name: "Jinnie Fay, Jetmir's Second", mana_cost: '{R/G}{G/W}{G/W}', cmc: 3, colors: ['G', 'R', 'W'], type_line: 'Legendary Creature — Elf Druid', oracle_text: 'If you would create one or more tokens, you may instead create that many 2/2 green Cat creature tokens with haste or that many 3/1 green Dog creature tokens with vigilance.', power: '3', toughness: '3' },
  ],
};

describe('oracleId, Scryfall record to DraftCard', () => {
  it('the projection keeps a face\'s oracle_id, the only place a reversible card has one', () => {
    const faces = projectCard(JINNIE)['card_faces'] as Array<Record<string, unknown>>;
    expect(faces.map((f) => f['oracle_id'])).toEqual([JINNIE_ORACLE, JINNIE_ORACLE]);
  });

  it('the catalog carries every card\'s oracle id: split and DFC from the top level, reversible from its first face', () => {
    const catalog = buildCatalog(buildCardIndex([FIRE_ICE, DELVER, JINNIE].map(projectCard)));
    const byName = new Map(Object.values(catalog.cards).map((c) => [(c as { name: string }).name, c as Record<string, unknown>]));
    expect(byName.get('Fire // Ice')?.oracleId).toBe(FIRE_ICE_ORACLE);
    expect(byName.get('Delver of Secrets // Insectile Aberration')?.oracleId).toBe(DELVER_ORACLE);
    expect(byName.get("Jinnie Fay, Jetmir's Second // Jinnie Fay, Jetmir's Second")?.oracleId).toBe(JINNIE_ORACLE);
  });

  it('a card\'s other faces carry no oracle id of their own: it names the card, not a face', () => {
    const card = toDraftCard(projectCard(DELVER), 'c0');
    const faces = card.faces as Array<Record<string, unknown>>;
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) expect('oracleId' in face).toBe(false);
  });

  it('a card with no oracle id anywhere, or one that is not a uuid, carries none rather than one the wire would refuse', () => {
    expect('oracleId' in toDraftCard(projectCard({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Mountain' }), 'c1')).toBe(false);
    expect('oracleId' in toDraftCard(projectCard({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', oracle_id: 'o-mountain', name: 'Mountain' }), 'c2')).toBe(false);
  });
});
