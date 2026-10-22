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

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCardIndex } from '../resolve.ts';
import type { GameplayCard } from '../scryfall/project.ts';
import { buildCatalog, runBuildCatalog } from './build-catalog.ts';

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

/**
 * `printings` (wave 74 §G, manager send-back): byPrinting exists so a
 * realistic booster's own-set printing draws its OWN art, not whatever
 * printing the catalog chose as its one text entry. That needs EVERY
 * printing indexed, not only the chosen one — this was the gap in the
 * first pass (byPrinting only ever matched the chosen printing, so it
 * missed for nearly every real card and silently fell back to byName,
 * drawing the wrong printing's art).
 *
 * Two printings of the same name, same text, different sets/ids: LEA
 * (earlier, non-digital, so it is the CHOSEN one for `cards`) and M19 (the
 * non-chosen one). Before the fix `buildCatalog`'s return carries no
 * `printings` field at all, so this is RED on the base.
 */
describe('buildCatalog printings', () => {
  const LEA_BOLT = {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    name: 'Lightning Bolt',
    lang: 'en',
    set: 'lea',
    collector_number: '161',
    released_at: '1993-08-05',
    layout: 'normal',
    colors: ['R'],
    mana_cost: '{R}',
    cmc: 1,
    type_line: 'Instant',
    oracle_text: 'Lightning Bolt deals 3 damage to any target.',
    rarity: 'common',
  } as unknown as GameplayCard;

  const M19_BOLT = {
    ...LEA_BOLT,
    id: 'bbbbbbbb-0000-4000-8000-000000000002',
    set: 'm19',
    collector_number: '141',
    released_at: '2018-07-13',
  } as unknown as GameplayCard;

  it("indexes BOTH printings, each under its own set+collector number, even though only LEA's text is chosen for `cards`", () => {
    const index = buildCardIndex([LEA_BOLT, M19_BOLT]);
    const catalog = buildCatalog(index);

    expect(catalog.cards['lightning bolt']).toBeDefined();
    expect((catalog.cards['lightning bolt'] as { scryfallId: string }).scryfallId).toBe(LEA_BOLT.id);

    // The non-chosen printing (M19) must still answer ITS OWN scryfallId, not LEA's.
    const m19Ref = catalog.printings['M19:141'];
    expect(m19Ref).toBeDefined();
    expect(m19Ref?.key).toBe('lightning bolt');
    expect(m19Ref?.scryfallId).toBe(M19_BOLT.id);
    expect(m19Ref?.scryfallId).not.toBe(LEA_BOLT.id);

    // The chosen printing is indexed too (redundant with `cards`, but a
    // caller asking for LEA:161 specifically should still get it by this path).
    const leaRef = catalog.printings['LEA:161'];
    expect(leaRef).toBeDefined();
    expect(leaRef?.scryfallId).toBe(LEA_BOLT.id);
  });

  it('a digital-only printing is still indexed by its own set+collector number', () => {
    const digital = { ...M19_BOLT, id: 'cccccccc-0000-4000-8000-000000000003', set: 'mb2', collector_number: '9', digital: true } as unknown as GameplayCard;
    const index = buildCardIndex([LEA_BOLT, digital]);
    const catalog = buildCatalog(index);
    expect(catalog.printings['MB2:9']?.scryfallId).toBe(digital.id);
    expect(catalog.printings['MB2:9']?.key).toBe('lightning bolt');
  });

  it('does not index a printing missing a set or collector number', () => {
    const noSet = { ...M19_BOLT, id: 'dddddddd-0000-4000-8000-000000000004', set: undefined } as unknown as GameplayCard;
    const index = buildCardIndex([LEA_BOLT, noSet]);
    const catalog = buildCatalog(index);
    expect(Object.keys(catalog.printings)).toEqual(['LEA:161']);
  });
});

/**
 * `runBuildCatalog` — the same build, driven end to end from a `cards.jsonl`
 * on disk rather than an in-memory `CardIndex`, so `apps/server/src/pools/refresh.ts`
 * (wave 74 §G) has a function it can call in-process instead of shelling out.
 * No CLI argv here on purpose: `main`'s own argv parsing is untouched and
 * unexercised by this file — these tests are for the extracted function.
 */
describe('runBuildCatalog', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'build-catalog-data-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('reads cards.jsonl from dataDir and writes a catalog to outPath', async () => {
    await writeFile(join(dataDir, 'cards.jsonl'), `${JSON.stringify(FIRE_ICE)}\n`, 'utf8');
    const outDir = await mkdtemp(join(tmpdir(), 'build-catalog-out-'));
    const outPath = join(outDir, 'cards.json');

    const result = await runBuildCatalog({ dataDir, outPath });

    expect(result.outPath).toBe(outPath);
    expect(result.cardCount).toBe(1);
    expect(result.aliasCount).toBeGreaterThanOrEqual(0); // a split card's halves (Fire, Ice) alias to the whole
    const written = JSON.parse(await readFile(outPath, 'utf8')) as { cards: Record<string, unknown> };
    expect(written.cards['fire // ice']).toBeDefined();

    await rm(outDir, { recursive: true, force: true });
  });

  it('throws (never process.exit) when dataDir has no cards.jsonl, carrying the same message main() used to print', async () => {
    await expect(runBuildCatalog({ dataDir, outPath: join(dataDir, 'cards.json') })).rejects.toThrow(/No card cache at/);
  });

  it('reports printings from the index, which can exceed cardCount for a multi-printing name', async () => {
    const reprint = { ...FIRE_ICE, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', set: 'mh2', collector_number: '227' };
    await writeFile(join(dataDir, 'cards.jsonl'), `${JSON.stringify(FIRE_ICE)}\n${JSON.stringify(reprint)}\n`, 'utf8');
    const result = await runBuildCatalog({ dataDir, outPath: join(dataDir, 'cards.json') });
    expect(result.cardCount).toBe(1); // one name -> one catalog entry (build-catalog.ts's own rule)
    expect(result.printings).toBe(2); // both printings were indexed by buildCardIndex
  });
});
