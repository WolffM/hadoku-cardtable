/**
 * `collationCounts` (`draft-sets.collation.ts`) against fixtures — no browser, no jar.
 *
 *   node --test draft-sets.test.ts
 *
 * Reproduces the exact shape of the two live reds this fix was written for
 * (run 39828615022: 2 non-DFC rare/mythics; run 39808764418: 4 non-DFC
 * uncommons) and proves the pure counter now sets the foil card aside the
 * same way it already sets the DFC aside.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collationCounts, type WireCard } from './draft-sets.collation.ts';

const ISD = 'ISD';

/** 9 common, 3 uncommon, 1 rare/mythic, 1 dfc, 1 basic land — Innistrad's own recipe, no foil. */
function baselinePack(): WireCard[] {
  const commons = Array.from({ length: 9 }, (_, i) => ({ name: `Common ${i}`, rarity: 'common', setCode: ISD }));
  const uncommons = Array.from({ length: 3 }, (_, i) => ({ name: `Uncommon ${i}`, rarity: 'uncommon', setCode: ISD }));
  const rareOrMythic = { name: 'A Rare', rarity: 'rare', setCode: ISD };
  const dfc = { name: 'Delver of Secrets // Insectile Aberration', rarity: 'uncommon', faces: [{ name: 'Insectile Aberration' }], setCode: ISD };
  const basic = { name: 'Forest', rarity: 'special', setCode: ISD };
  return [...commons, ...uncommons, rareOrMythic, dfc, basic];
}

test('a pack with no foil: exactly one rare/mythic, exactly three uncommons, exactly one DFC, no foil', () => {
  const counts = collationCounts(baselinePack());
  assert.equal(counts.rareOrMythicCount, 1);
  assert.equal(counts.uncommonCount, 3);
  assert.equal(counts.dfcCount, 1);
  assert.equal(counts.foilCount, 0);
});

/**
 * Run 39828615022's shape: `getBoosterPack` shrank the common slot to make
 * room, then appended an extra foil RARE/MYTHIC on top (Forge's own
 * `FoilAlwaysInCommonSlot` default — see `draft-sets.collation.ts`'s header).
 * Without setting the foil aside, "every non-DFC card whose rarity is
 * rare/mythic" reads 2, which is what reds the live spec.
 */
test('a pack with an extra foil rare/mythic: still exactly one non-foil rare/mythic, and exactly one foil', () => {
  const pack = baselinePack();
  pack.push({ name: 'Nevermore', rarity: 'rare', setCode: ISD, foil: true });
  const counts = collationCounts(pack);
  assert.equal(counts.rareOrMythicCount, 1, 'the foil rare/mythic must not count toward the slot total');
  assert.equal(counts.foilCount, 1);
  assert.equal(counts.uncommonCount, 3);
  assert.equal(counts.dfcCount, 1);
});

/** Run 39808764418's shape: the extra foil landed on uncommon instead of rare/mythic. */
test('a pack with an extra foil uncommon: still exactly three non-foil uncommons, and exactly one foil', () => {
  const pack = baselinePack();
  pack.push({ name: 'Moon Heron', rarity: 'uncommon', setCode: ISD, foil: true });
  const counts = collationCounts(pack);
  assert.equal(counts.uncommonCount, 3, 'the foil uncommon must not count toward the slot total');
  assert.equal(counts.foilCount, 1);
  assert.equal(counts.rareOrMythicCount, 1);
  assert.equal(counts.dfcCount, 1);
});

/** A foil that happens to land on the DFC itself is set aside by the DFC filter either way — `foilCount` still reports it, `dfcCount` stays 1 (one physical card, two reasons to exclude it). */
test('a foil DFC counts once in dfcCount and once in foilCount, never doubling either slot', () => {
  const pack = baselinePack().map((c) => (c.faces !== undefined ? { ...c, foil: true } : c));
  const counts = collationCounts(pack);
  assert.equal(counts.dfcCount, 1);
  assert.equal(counts.foilCount, 1);
  assert.equal(counts.rareOrMythicCount, 1);
  assert.equal(counts.uncommonCount, 3);
});
