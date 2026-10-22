/**
 * `collationCounts` (`draft-sets.collation.ts`) against fixtures — no browser, no jar.
 *
 *   node --test draft-sets.test.ts
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collationCounts, type WireCard } from './draft-sets.collation.ts';

const ISD = 'ISD';

/** A drafted ISD pack: 10 common, 3 uncommon, 1 rare/mythic, 1 dfc — no basic land, no foil. */
function draftPack(): WireCard[] {
  const commons = Array.from({ length: 10 }, (_, i) => ({ name: `Common ${i}`, rarity: 'common', setCode: ISD }));
  const uncommons = Array.from({ length: 3 }, (_, i) => ({ name: `Uncommon ${i}`, rarity: 'uncommon', setCode: ISD }));
  const rareOrMythic = { name: 'A Rare', rarity: 'rare', setCode: ISD };
  const dfc = { name: 'Delver of Secrets // Insectile Aberration', rarity: 'uncommon', faces: [{ name: 'Insectile Aberration' }], setCode: ISD };
  return [rareOrMythic, ...uncommons, dfc, ...commons];
}

test('a draft pack: one rare/mythic, three uncommons, one DFC, no foil, no basic land', () => {
  assert.deepEqual(collationCounts(draftPack()), { dfcCount: 1, foilCount: 0, basicCount: 0, rareOrMythicCount: 1, uncommonCount: 3 });
});

/** Gatstaf Shepherd // Gatstaf Howler, seen live: an uncommon DFC beside three uncommons is a right pack. */
test('an uncommon DFC never counts toward the three uncommons', () => {
  assert.equal(collationCounts(draftPack()).uncommonCount, 3);
});

test('a foil or a basic land is counted, never set aside', () => {
  const pack = [...draftPack().slice(0, -2), { name: 'Forest', rarity: 'common', setCode: ISD }, { name: 'Moon Heron', rarity: 'uncommon', setCode: ISD, foil: true }];
  const counts = collationCounts(pack);
  assert.equal(counts.basicCount, 1);
  assert.equal(counts.foilCount, 1);
  assert.equal(counts.uncommonCount, 4);
});
