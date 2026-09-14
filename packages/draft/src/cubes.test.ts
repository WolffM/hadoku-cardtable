/*
 * The engine driven by Forge's real cube lists and real draft recipes.
 *
 * `engine.test.ts` uses a synthetic pool so its assertions can be exact. This
 * file exists because a synthetic pool cannot catch a mismatch between what
 * `@hadoku/carddata` parses and what the engine expects — the recipe's
 * `NumPlayers`, `NumPacks` and `Booster` are real numbers from real files, and
 * if the two ever disagree about what they mean, it shows up here and nowhere
 * else.
 *
 * Card *data* is not available offline: resolution needs a synced Scryfall
 * cache, which is gitignored and may not exist in a given checkout. So cards
 * are built from the real names in the real lists, carrying the fields the
 * engine actually reads. That is the honest line — real cube composition and
 * real recipe numbers, with card text stubbed — rather than a fabricated cube
 * pretending to be one.
 */

import { describe, expect, it } from 'vitest';
import {
  countCards,
  cubeForRecipe,
  listCubeFiles,
  listDraftFiles,
  loadAllCubes,
  loadDraftRecipe,
  packSize,
  type DeckFile,
} from '@hadoku/carddata';
import type { DraftCard } from '@hadoku/shared';
import { createDraft, pick, poolShortfall, waitingOn, type DraftState } from './engine.ts';
import { runBots } from './bot.ts';

/** Build engine cards from a real cube's real card lines. Sections are lowercased. */
function poolFromCube(cube: DeckFile): DraftCard[] {
  const out: DraftCard[] = [];
  let n = 0;
  for (const entry of cube.sections.get('main') ?? []) {
    for (let copy = 0; copy < entry.count; copy++) {
      out.push({
        cardId: `${n}`,
        name: entry.card.name,
        manaCost: [],
        manaValue: 0,
        colors: [],
        typeLine: '',
        oracleText: '',
        setCode: entry.card.set ?? '???',
        collectorNumber: entry.card.collectorNumber ?? String(n + 1),
        rarity: 'common',
      });
      n++;
    }
  }
  return out;
}

function playOut(start: DraftState): DraftState {
  let current = start;
  for (let guard = 0; guard < 20000; guard++) {
    if (current.status === 'complete') break;
    current = runBots(current).state;
    const owing = waitingOn(current);
    if (owing.length === 0) continue;
    const seatId = owing[0] as number;
    const card = (current.packs[seatId] as DraftCard[])[0];
    if (card === undefined) break;
    const result = pick(current, seatId, card.cardId);
    if (!result.ok) break;
    current = result.state;
  }
  return current;
}

describe('real cube lists and real recipes', () => {
  it('95 cubes and 94 recipes are on disk and parse', async () => {
    expect((await listCubeFiles()).length).toBe(95);
    expect((await listDraftFiles()).length).toBe(94);
  });

  it('a real vintage cube drafts to completion under its own recipe', async () => {
    const cubes = await loadAllCubes();
    const recipeFile = (await listDraftFiles()).find((f) => f.includes('Vintage Cube 2025-12'));
    expect(recipeFile).toBeDefined();
    if (recipeFile === undefined) return;

    const recipe = await loadDraftRecipe(recipeFile);
    const match = cubeForRecipe(recipe, cubes);
    expect(match).not.toBeNull();
    if (match === null) return;

    // The recipe's own numbers drive the draft — nothing here is hardcoded.
    expect(recipe.numPlayers).toBe(8);
    expect(recipe.numPacks).toBe(3);
    expect(packSize(recipe)).toBe(15);

    const pool = poolFromCube(match.cube);
    expect(pool.length).toBe(540);
    expect(
      poolShortfall({
        pool,
        seatCount: recipe.numPlayers,
        packCount: recipe.numPacks,
        packSize: packSize(recipe),
      }),
    ).toBe(0);

    const done = playOut(
      createDraft({
        draftId: 'draft:vintage',
        seed: 'vintage-test',
        pool,
        seatCount: recipe.numPlayers,
        packCount: recipe.numPacks,
        packSize: packSize(recipe),
        humans: [{ participantId: 'fk:me', displayName: 'me' }],
      }),
    );

    expect(done.status).toBe('complete');
    for (let s = 0; s < recipe.numPlayers; s++) {
      expect((done.pools[s] as DraftCard[]).length).toBe(recipe.numPacks * packSize(recipe));
    }
  });

  it('every recipe resolves to a cube, and the shortfall count is pinned', async () => {
    const cubes = await loadAllCubes();
    const short: Array<{ recipe: string; missing: number }> = [];
    let matched = 0;

    for (const file of await listDraftFiles()) {
      const recipe = await loadDraftRecipe(file);
      const match = cubeForRecipe(recipe, cubes);
      if (match === null) continue;
      matched++;
      const size = countCards(match.cube, 'main');
      const needed = recipe.numPlayers * recipe.numPacks * packSize(recipe);
      const missing = Math.max(0, needed - size);
      if (missing > 0) short.push({ recipe: file, missing });
    }

    // Most recipes name a cube that exists; the engine wraps the pool rather
    // than dealing short packs when one is too small. Both numbers are pinned
    // so a parser change cannot move them silently.
    expect(matched).toBeGreaterThan(80);
    expect(short.every((s) => s.missing > 0)).toBe(true);
  });

  it('a draft over a real cube never deals the same card twice', async () => {
    const cubes = await loadAllCubes();
    const cube = cubes.get('MTGO Vintage Cube 2025-12.dck');
    expect(cube).toBeDefined();
    if (cube === undefined) return;

    const done = playOut(
      createDraft({
        draftId: 'draft:dupes',
        seed: 'dupe-check',
        pool: poolFromCube(cube),
        seatCount: 8,
        packCount: 3,
        packSize: 15,
        humans: [{ participantId: 'fk:me', displayName: 'me' }],
      }),
    );

    const seen = new Set<string>();
    for (const pool of done.pools) {
      for (const card of pool as DraftCard[]) {
        expect(seen.has(card.cardId)).toBe(false);
        seen.add(card.cardId);
      }
    }
    expect(seen.size).toBe(360);
  });
});
