/*
 * No Alchemy in Cardtable (the operator, 2026-11-01): an Alchemy set's card,
 * a rebalanced "A-" card and an Arena-only Alchemy design never reach the
 * card index, and so never the catalog `runBuildCatalog` writes. A paper card
 * reprinted in an Alchemy set keeps its paper printing and loses that one.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAlchemySet, withoutAlchemy } from './alchemy.ts';
import { runBuildCatalog } from './catalog-build.ts';
import { buildCardIndex, normaliseName } from './resolve.ts';
import type { GameplayCard } from './scryfall/project.ts';

function card(fields: Record<string, unknown>): GameplayCard {
  return {
    lang: 'en',
    layout: 'normal',
    released_at: '2021-12-09',
    mana_cost: '{1}{U}',
    cmc: 2,
    type_line: 'Creature — Human',
    oracle_text: '',
    digital: false,
    games: ['paper'],
    ...fields,
  } as GameplayCard;
}

/** An Alchemy: Innistrad card, printed only there. */
const GUTMORN = card({
  id: '11111111-1111-4111-8111-111111111111',
  oracle_id: 'o-gutmorn',
  name: 'Gutmorn, Pactbound Servant',
  set: 'ymid',
  set_name: 'Alchemy: Innistrad',
  set_type: 'alchemy',
  collector_number: '28',
  digital: true,
  games: ['arena'],
});

/** Midnight Hunt's own Falcon Abomination, and its Arena rebalance. */
const FALCON = card({
  id: '22222222-2222-4222-8222-222222222222',
  oracle_id: 'o-falcon',
  name: 'Falcon Abomination',
  set: 'mid',
  set_name: 'Innistrad: Midnight Hunt',
  set_type: 'expansion',
  collector_number: '52',
});
const A_FALCON = card({
  id: '33333333-3333-4333-8333-333333333333',
  oracle_id: 'o-a-falcon',
  name: 'A-Falcon Abomination',
  set: 'mid',
  set_name: 'Innistrad: Midnight Hunt',
  set_type: 'expansion',
  collector_number: 'A-52',
  digital: true,
  games: ['arena'],
  promo_types: ['rebalanced'],
});

/** Jumpstart: Historic Horizons' own Alchemy design (perpetually). */
const ETHEREAL_GRASP = card({
  id: '44444444-4444-4444-8444-444444444444',
  oracle_id: 'o-grasp',
  name: 'Ethereal Grasp',
  set: 'j21',
  set_name: 'Jumpstart: Historic Horizons',
  set_type: 'draft_innovation',
  collector_number: '8',
  digital: true,
  games: ['arena'],
});

/** A paper card with an Alchemy reprint: only the Alchemy printing goes. */
const BONE_SHARDS = card({ id: '55555555-5555-4555-8555-555555555555', oracle_id: 'o-bone', name: 'Bone Shards', set: 'mh2', set_name: 'Modern Horizons 2', set_type: 'draft_innovation', collector_number: '76' });
const BONE_SHARDS_J21 = card({ ...BONE_SHARDS, id: '66666666-6666-4666-8666-666666666666', set: 'j21', set_name: 'Jumpstart: Historic Horizons', set_type: 'draft_innovation', collector_number: '351', digital: true, games: ['arena'] });

/** A paper playtest card whose name merely starts with "A-". */
const A_TOWN = card({ id: '77777777-7777-4777-8777-777777777777', oracle_id: 'o-a-town', name: 'A-Town', set: 'unk', set_name: 'Unknown Event', set_type: 'funny', collector_number: '1' });

const ALL = [GUTMORN, FALCON, A_FALCON, ETHEREAL_GRASP, BONE_SHARDS, BONE_SHARDS_J21, A_TOWN];

describe('isAlchemySet', () => {
  it("knows an Alchemy set by Scryfall's type, by its name, and by its bare code", () => {
    expect(isAlchemySet({ type: 'alchemy' })).toBe(true);
    expect(isAlchemySet({ name: "Alchemy Horizons: Baldur's Gate" })).toBe(true);
    expect(isAlchemySet({ name: 'Alchemy Innistrad' })).toBe(true); // Forge's edition name
    expect(isAlchemySet({ code: 'ymid' })).toBe(true);
    expect(isAlchemySet({ code: 'Y22' })).toBe(true); // Forge's own code for YMID
    expect(isAlchemySet({ code: 'J21', name: 'Jumpstart: Historic Horizons', type: 'draft_innovation' })).toBe(true);
  });

  it('leaves paper sets alone, Forbidden Alchemy\'s Innistrad included', () => {
    expect(isAlchemySet({ code: 'MID', name: 'Innistrad: Midnight Hunt', type: 'expansion' })).toBe(false);
    expect(isAlchemySet({ code: 'ISD', name: 'Innistrad', type: 'expansion' })).toBe(false);
    expect(isAlchemySet({ code: 'JMP', name: 'Jumpstart', type: 'draft_innovation' })).toBe(false);
  });
});

describe('withoutAlchemy', () => {
  it('drops Alchemy printings and Alchemy-only cards, keeps paper ones and A-Town', () => {
    const split = withoutAlchemy(ALL);
    expect(split.kept.map((c) => `${String(c.name)}|${String(c.set)}`)).toEqual(['Falcon Abomination|mid', 'Bone Shards|mh2', 'A-Town|unk']);
    expect(split.alchemyNames).toEqual(['A-Falcon Abomination', 'Ethereal Grasp', 'Gutmorn, Pactbound Servant']);
    expect(split.dropped).toBe(4);
  });
});

describe('buildCardIndex excludes Alchemy', () => {
  it('indexes no Alchemy printing, and counts what it skipped', () => {
    const index = buildCardIndex(ALL);
    expect(index.byName.has(normaliseName('Gutmorn, Pactbound Servant'))).toBe(false);
    expect(index.byName.has(normaliseName('A-Falcon Abomination'))).toBe(false);
    expect(index.byName.has(normaliseName('Ethereal Grasp'))).toBe(false);
    expect(index.byName.get(normaliseName('Bone Shards'))?.map((e) => e.card.set)).toEqual(['mh2']);
    expect(index.knownSets.has('YMID')).toBe(false);
    expect(index.knownSets.has('J21')).toBe(false);
    expect(index.skipped.alchemy).toBe(4);
  });
});

describe('runBuildCatalog excludes Alchemy', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'alchemy-catalog-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('writes no Alchemy card or printing, and lists the Alchemy names it dropped', async () => {
    await writeFile(join(dataDir, 'cards.jsonl'), ALL.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
    const outPath = join(dataDir, 'cards.json');
    await runBuildCatalog({ dataDir, outPath });
    const text = await readFile(outPath, 'utf8');
    const written = JSON.parse(text) as { cards: Record<string, unknown>; printings: Record<string, unknown>; alchemy: string[] };
    expect(Object.keys(written.cards).sort()).toEqual(['a-town', 'bone shards', 'falcon abomination']);
    expect(Object.keys(written.printings).sort()).toEqual(['MH2:76', 'MID:52', 'UNK:1']);
    expect(written.alchemy).toEqual(['a-falcon abomination', 'ethereal grasp', 'gutmorn, pactbound servant']);
    expect(text).not.toMatch(/ymid|j21|A-52/i);
  });
});
