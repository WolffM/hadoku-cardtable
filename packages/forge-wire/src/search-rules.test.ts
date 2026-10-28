import { describe, expect, it } from 'vitest';

import { breaksSearchRule, searchRuleProblems, slotCovers, tickPick } from './search-rules.ts';
import type { SearchRule } from './tier-b.ts';

type SlotRule = Extract<SearchRule, { kind: 'slots' }>;

/** Ticks `ids` one after another as the prompt does, failing on a card the prompt greys. */
function tickAll(rule: SlotRule, ids: readonly number[], from: readonly number[] = []): number[] {
  let picks = [...from];
  for (const id of ids) {
    const next = tickPick([rule], picks, id);
    if (next === null) throw new Error(`${id} is greyed beside ${picks.join(',')}`);
    picks = next;
  }
  return picks;
}

/** Each kind → the picks answering it, `?` marking an undecided one. */
const shown = (rule: SlotRule, picks: readonly number[]) =>
  Object.fromEntries(slotCovers(rule, picks).map((c) => [c.kind, c.by.length === 0 ? '' : `${c.by.join('|')}${c.either ? '?' : ''}`]));

// Sundering Titan (ChooseCard EachBasicType: one permanent may answer every basic type it has).
const FOUNTAIN = 1;
const VOLCANIC = 2;
const ISLAND = 3;
const OTHER_ISLAND = 4;
const PLAINS = 5;
const SWAMP = 6;
const FOREST = 7;
const MOUNTAIN = 8;
const TITAN: SlotRule = {
  kind: 'slots',
  kinds: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'],
  slots: [[FOUNTAIN, PLAINS], [FOUNTAIN, VOLCANIC, ISLAND, OTHER_ISLAND], [SWAMP], [VOLCANIC, MOUNTAIN], [FOREST]],
  fill: true,
  distinct: false,
};

// Guided Passage (ChangeZone EACH: each kind a different card found).
const ARBOR = 10;
const BEARS = 11;
const LAND = 12;
const BOLT = 13;
const PASSAGE: SlotRule = {
  kind: 'slots',
  kinds: ['Creature.YouOwn', 'Land.YouOwn', 'Card.nonCreature+nonLand+YouOwn'],
  slots: [[ARBOR, BEARS], [ARBOR, LAND], [BOLT]],
  fill: true,
  distinct: true,
};

describe('a land of each basic type, one land answering every type it has (Sundering Titan)', () => {
  it('Hallowed Fountain alone answers Plains and Island; Islands and Plains stay tickable', () => {
    const picks = tickAll(TITAN, [FOUNTAIN]);
    expect(shown(TITAN, picks)).toEqual({ Plains: '1', Island: '1', Swamp: '', Mountain: '', Forest: '' });
    expect(breaksSearchRule([TITAN], picks, ISLAND)).toBe(false);
    expect(breaksSearchRule([TITAN], picks, PLAINS)).toBe(false);
  });

  it('Fountain → Island → Plains: the Island takes Island and the Fountain Plains, then the Plains drops the Fountain', () => {
    const two = tickAll(TITAN, [FOUNTAIN, ISLAND]);
    expect(two).toEqual([FOUNTAIN, ISLAND]);
    expect(shown(TITAN, two)).toMatchObject({ Plains: '1', Island: '3' });
    const three = tickAll(TITAN, [PLAINS], two);
    expect(three).toEqual([ISLAND, PLAINS]);
    expect(shown(TITAN, three)).toMatchObject({ Plains: '5', Island: '3' });
  });

  it('Plains → Fountain → Island: the oldest pick whose removal lets the rest each hold a kind goes, here the Plains', () => {
    expect(tickAll(TITAN, [PLAINS, FOUNTAIN, ISLAND])).toEqual([FOUNTAIN, ISLAND]);
  });

  it('Plains, Mountain, Volcanic Island, Swamp, Forest, then the Fountain: the old Plains goes, not Volcanic Island', () => {
    const picks = tickAll(TITAN, [PLAINS, MOUNTAIN, VOLCANIC, SWAMP, FOREST, FOUNTAIN]);
    expect(picks).toEqual([MOUNTAIN, VOLCANIC, SWAMP, FOREST, FOUNTAIN]);
    expect(shown(TITAN, picks)).toEqual({ Plains: '1', Island: '2', Swamp: '6', Mountain: '8', Forest: '7' });
  });

  it('ticking back and forth never trades the two newest: each tick drops the oldest pick it can', () => {
    const fountain = tickAll(TITAN, [PLAINS, MOUNTAIN, VOLCANIC, SWAMP, FOREST, FOUNTAIN]);
    const island = tickAll(TITAN, [ISLAND], fountain);
    expect(island, 'the Island drops the Mountain, Volcanic Island now the Mountain').toEqual([VOLCANIC, SWAMP, FOREST, FOUNTAIN, ISLAND]);
    const mountain = tickAll(TITAN, [MOUNTAIN], island);
    expect(mountain, 'the Mountain drops Volcanic Island, the oldest it can').toEqual([SWAMP, FOREST, FOUNTAIN, ISLAND, MOUNTAIN]);
    expect(tickAll(TITAN, [VOLCANIC], mountain), 'Volcanic Island back drops the Island, the oldest it can, not the Mountain it just lost to').toEqual([SWAMP, FOREST, FOUNTAIN, MOUNTAIN, VOLCANIC]);
  });

  it('unticking the Island by hand gives the Fountain both kinds back; nothing is ticked back', () => {
    const picks = tickAll(TITAN, [FOUNTAIN, ISLAND]).filter((id) => id !== ISLAND);
    expect(picks).toEqual([FOUNTAIN]);
    expect(shown(TITAN, picks)).toMatchObject({ Plains: '1', Island: '1' });
  });

  it('a land of a kind already answered stays tickable: a second Island takes the first one’s place', () => {
    const picks = tickAll(TITAN, [FOUNTAIN, ISLAND]);
    expect(breaksSearchRule([TITAN], picks, OTHER_ISLAND)).toBe(false);
    expect(tickPick([TITAN], picks, OTHER_ISLAND)).toEqual([FOUNTAIN, OTHER_ISLAND]);
  });

  it('Island → Plains → Mountain → Volcanic Island: only the Island is dropped, the Mountain keeps Mountain', () => {
    const picks = tickAll(TITAN, [ISLAND, PLAINS, MOUNTAIN, VOLCANIC]);
    expect(picks).toEqual([PLAINS, MOUNTAIN, VOLCANIC]);
    expect(shown(TITAN, picks)).toEqual({ Plains: '5', Island: '2', Swamp: '', Mountain: '8', Forest: '' });
  });

  it('only a card of no kind at all is greyed', () => {
    const lands = tickAll(TITAN, [ISLAND, PLAINS, MOUNTAIN]);
    for (const id of [FOUNTAIN, VOLCANIC, OTHER_ISLAND, SWAMP, FOREST]) expect(breaksSearchRule([TITAN], lands, id), String(id)).toBe(false);
    expect(breaksSearchRule([TITAN], lands, 99)).toBe(true);
  });

  it('OK holds once every type some land has is answered, Volcanic Island counting as Island and Mountain', () => {
    expect(searchRuleProblems([TITAN], [FOUNTAIN, SWAMP, FOREST])).toEqual(['one of each']);
    expect(searchRuleProblems([TITAN], tickAll(TITAN, [FOUNTAIN, VOLCANIC, SWAMP, FOREST]))).toEqual([]);
  });
});

describe('a different card for each kind (Guided Passage)', () => {
  it('Dryad Arbor alone is the creature or the land, undecided', () => {
    const picks = tickAll(PASSAGE, [ARBOR]);
    expect(shown(PASSAGE, picks)).toEqual({ 'Creature.YouOwn': '10?', 'Land.YouOwn': '10?', 'Card.nonCreature+nonLand+YouOwn': '' });
  });

  it('ticking another land moves Dryad Arbor to the creature', () => {
    const picks = tickAll(PASSAGE, [ARBOR, LAND]);
    expect(picks).toEqual([ARBOR, LAND]);
    expect(shown(PASSAGE, picks)).toMatchObject({ 'Creature.YouOwn': '10', 'Land.YouOwn': '12' });
  });

  it('Dryad Arbor as both is refused while a Forest could be the land; three different cards are taken', () => {
    expect(searchRuleProblems([PASSAGE], [ARBOR, BOLT])).toEqual(['one of each']);
    expect(searchRuleProblems([PASSAGE], [ARBOR, LAND, BOLT])).toEqual([]);
    expect(searchRuleProblems([PASSAGE], [ARBOR, BEARS, BOLT])).toEqual([]);
  });

  it('with no other creature or land, Dryad Arbor is the one card those kinds can find', () => {
    const alone: SlotRule = { ...PASSAGE, slots: [[ARBOR], [ARBOR], [BOLT]] };
    expect(searchRuleProblems([alone], [ARBOR, BOLT])).toEqual([]);
  });

  it('a creature and a land beside Dryad Arbor leave it nothing of its own, so it is dropped', () => {
    expect(tickAll(PASSAGE, [ARBOR, LAND, BEARS])).toEqual([LAND, BEARS]);
  });
});
