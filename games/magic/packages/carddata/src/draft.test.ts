import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GENERIC_DRAFT_BOOSTER,
  packSize,
  parseBoosterSlots,
  parseDraftRecipe,
  totalCardsDealt,
} from './draft.ts';
import { cubeForRecipe, draftsDir, listDraftFiles, loadAllDraftRecipes } from './drafts.ts';
import { loadAllCubes } from './cubes.ts';

const dir = draftsDir();
const read = (file: string): string => readFileSync(join(dir, file), 'utf8');

describe('the 94 vendored Forge recipes', () => {
  it('imports exactly 94 .draft files', async () => {
    // res/draft/ holds 96 entries: these 94, a `rankings/` DIRECTORY, and
    // rankings_cubecobra.txt. Neither of the last two is a recipe.
    expect((await listDraftFiles()).length).toBe(94);
  });

  it('parses every one into a usable recipe', async () => {
    const recipes = await loadAllDraftRecipes();
    expect(recipes.size).toBe(94);
    for (const [file, recipe] of recipes) {
      expect(recipe.name, file).not.toBeNull();
      expect(recipe.deckFile, file).not.toBeNull();
      expect(recipe.booster.length, file).toBeGreaterThan(0);
      expect(recipe.numPacks, file).toBeGreaterThan(0);
      expect(recipe.numPlayers, file).toBeGreaterThan(0);
      expect(packSize(recipe), file).toBeGreaterThan(0);
    }
  });

  /*
   * The shape of the corpus, counted off the committed files.
   *
   * NOTE: `15 Any` is 91 recipes, not the 92 the Wave 2 plan and the board
   * both state. The four booster values in the corpus are `15 Any` x91,
   * `16 Any` x1, `9 Any` x1 and the one rarity recipe — 91+1+1+1 = 94, which
   * 92 cannot be made to add up to. Cross-checked against the committed files
   * with an independent shell count, not just this parser.
   *
   * These are re-derived here so a Forge bump that changes them fails a test
   * instead of quietly changing what lane B builds packs out of.
   */
  it('has the pack-recipe distribution O2 was decided on', async () => {
    const recipes = [...(await loadAllDraftRecipes()).values()];

    const fifteenAny = recipes.filter(
      (r) => r.booster.length === 1 && r.booster[0].count === 15 && r.booster[0].type === 'Any',
    );
    expect(fifteenAny.length).toBe(91);

    // The whole distribution, so the 91 above cannot drift unnoticed.
    const shapes = new Map<string, number>();
    for (const r of recipes) {
      const key = r.booster.map((s) => `${s.count} ${s.type}`).join(', ');
      shapes.set(key, (shapes.get(key) ?? 0) + 1);
    }
    expect([...shapes.entries()].sort()).toEqual([
      ['15 Any', 91],
      ['16 Any', 1],
      ['5 Rare, 1 Mythic, 5 Common, 5 Uncommon', 1],
      ['9 Any', 1],
    ]);

    expect(recipes.filter((r) => r.singleton).length).toBe(93);
    expect(recipes.filter((r) => r.numPacks === 3 && r.numPlayers === 8).length).toBe(93);

    // Exactly one recipe uses rarity slots, and it is not special-cased away.
    const rarity = recipes.filter((r) => r.booster.some((s) => s.type !== 'Any'));
    expect(rarity.length).toBe(1);
    expect(rarity[0].name).toBe('JuzamjediCube');

    expect(recipes.filter((r) => r.landSetCode !== null).length).toBe(4);
    // CustomRankings is the format's eighth key; no vendored recipe sets it.
    expect(recipes.filter((r) => r.customRankings !== null).length).toBe(0);
  });

  it('parses the one rarity-slot recipe rather than special-casing it', () => {
    const recipe = parseDraftRecipe(read('cube_juzamjedi.draft'));
    expect(recipe.booster).toEqual([
      { count: 5, type: 'Rare' },
      { count: 1, type: 'Mythic' },
      { count: 5, type: 'Common' },
      { count: 5, type: 'Uncommon' },
    ]);
    expect(packSize(recipe)).toBe(16);
    // The only recipe with no Singleton key at all — Forge's getBoolean
    // default is false, not true.
    expect(recipe.singleton).toBe(false);
    expect(recipe.landSetCode).toBe('M11');
    expect(totalCardsDealt(recipe)).toBe(16 * 3 * 8);
  });

  it('parses the other three outliers', () => {
    const skiera = parseDraftRecipe(read('cube_skiera.draft'));
    expect(skiera.booster).toEqual([{ count: 16, type: 'Any' }]);

    // The only 4-player, 5-pack recipe.
    const twobert = parseDraftRecipe(read('The Original Recipe Twobert.draft'));
    expect(twobert.booster).toEqual([{ count: 9, type: 'Any' }]);
    expect(twobert.numPacks).toBe(5);
    expect(twobert.numPlayers).toBe(4);
    expect(totalCardsDealt(twobert)).toBe(9 * 5 * 4);

    // Trailing whitespace on the Booster line and on a blank line. Forge's
    // FileSection trims both sides of every key:value, so this needs no
    // special handling — assert that rather than assume it.
    const frontier = parseDraftRecipe(read('Frontier.draft'));
    expect(frontier.booster).toEqual([{ count: 15, type: 'Any' }]);
    // Name and DeckFile differ: the recipe is "Frontier Draft", the cube is
    // "Frontier Cube". Anything that assumes they match is wrong.
    expect(frontier.name).toBe('Frontier Draft');
    expect(frontier.deckFile).toBe('Frontier Cube');
    expect(frontier.landSetCode).toBe('BFZ');
  });

  it('parses the two CRLF recipes identically to the LF ones', () => {
    for (const file of ['Pioneer Cube.draft', 'The Arena Cube.draft']) {
      const raw = read(file);
      expect(raw.includes('\r'), file).toBe(true);
      const recipe = parseDraftRecipe(raw);
      expect(recipe.booster, file).toEqual([{ count: 15, type: 'Any' }]);
      expect(recipe.singleton, file).toBe(true);
      // A stray \r would survive into the value and break every downstream
      // string comparison, so name the symptom explicitly.
      expect(recipe.name, file).not.toContain('\r');
      expect(recipe.deckFile, file).not.toContain('\r');
    }
  });
});

describe('recipe -> cube join', () => {
  /*
   * Forge resolves DeckFile against a deck store keyed by `DeckBase::getName`
   * (forge-core/.../deck/io/DeckStorage.java:50), and that name is the `.dck`'s
   * `[metadata] Name=` (DeckFileHeader.java:84). So the join is on metadata
   * name, NOT on filename — and two of Forge's own recipes get it wrong.
   */
  it('joins 92 of 94 recipes to a cube, and names the two that do not', async () => {
    const cubes = await loadAllCubes();
    const recipes = await loadAllDraftRecipes();

    const unmatched = [...recipes.entries()]
      .filter(([, recipe]) => cubeForRecipe(recipe, cubes) === null)
      .map(([file]) => file)
      .sort();

    expect(unmatched).toEqual([
      // DeckFile says "The Pauper Cube 2026-02"; the cube is named
      // "The Pauper Deck 2026-02". Cube/Deck.
      'The Pauper Cube 2026-02.draft',
      // DeckFile says "The Peasant Cube 2023 (June)"; the cube is named
      // "The Peasant Cube 2023", with no " (June)".
      'The Peasant Cube 2023 (June).draft',
    ]);
    expect(recipes.size - unmatched.length).toBe(92);
  });

  it('matches Frontier across its differing recipe and cube names', async () => {
    const cubes = await loadAllCubes();
    const recipe = parseDraftRecipe(read('Frontier.draft'));
    const match = cubeForRecipe(recipe, cubes);
    expect(match?.fileName).toBe('Frontier Cube.dck');
  });
});

describe('the Booster line, per Forge TextUtil.splitWithParenthesis', () => {
  it('splits count from type', () => {
    expect(parseBoosterSlots('15 Any')).toEqual([{ count: 15, type: 'Any' }]);
  });

  it('drops the empty segment a leading space would otherwise produce', () => {
    // This is the skipEmpty behaviour. Without it "1 Mythic" after a comma
    // parses its count as "" and every multi-slot recipe breaks.
    expect(parseBoosterSlots('5 Rare, 1 Mythic')).toEqual([
      { count: 5, type: 'Rare' },
      { count: 1, type: 'Mythic' },
    ]);
  });

  it('stops splitting after maxEntries so a multi-word type survives', () => {
    expect(parseBoosterSlots('1 BasicLand ALA')).toEqual([{ count: 1, type: 'BasicLand ALA' }]);
  });

  it('honours parentheses as a grouping that commas do not break', () => {
    expect(parseBoosterSlots('1 RareMythic(foil), 10 Common')).toEqual([
      { count: 1, type: 'RareMythic(foil)' },
      { count: 10, type: 'Common' },
    ]);
  });

  it('returns null rather than throwing on a malformed slot', () => {
    expect(parseBoosterSlots('Any')).toBeNull();
    expect(parseBoosterSlots('lots Any')).toBeNull();
    expect(parseBoosterSlots('')).toBeNull();
  });
});

describe('Forge FileSection semantics', () => {
  it('splits on the first colon only, so a colon in a value survives', () => {
    const recipe = parseDraftRecipe('Name:Cube: the Cubening\nBooster: 15 Any\n');
    expect(recipe.name).toBe('Cube: the Cubening');
  });

  it('matches keys case-insensitively', () => {
    const recipe = parseDraftRecipe('NAME:X\nnumpacks:4\nSingleton:TRUE\n');
    expect(recipe.name).toBe('X');
    expect(recipe.numPacks).toBe(4);
    expect(recipe.singleton).toBe(true);
  });

  it('reproduces getInt(0) and getBoolean(false) rather than improving on them', () => {
    // A recipe with no NumPacks really does draft zero packs in Forge. Making
    // this default to 3 here would make us disagree with the engine.
    const recipe = parseDraftRecipe('Name:X\n');
    expect(recipe.numPacks).toBe(0);
    expect(recipe.numPlayers).toBe(0);
    expect(recipe.singleton).toBe(false);
    expect(parseDraftRecipe('NumPacks:three\n').numPacks).toBe(0);
    expect(parseDraftRecipe('NumPacks:3.5\n').numPacks).toBe(0);
  });

  it('falls back to the generic booster when Booster is absent or empty', () => {
    expect(parseDraftRecipe('Name:X\n').booster).toEqual(GENERIC_DRAFT_BOOSTER);
    expect(parseDraftRecipe('Name:X\nBooster:\n').booster).toEqual(GENERIC_DRAFT_BOOSTER);
  });
});
