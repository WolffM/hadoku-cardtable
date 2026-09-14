/*
 * Loading the draft recipes in `drafts/` at the repo root.
 *
 * Forge's own bundled recipes, copied verbatim from
 * `forge/forge-gui/res/draft/*.draft` (94 files, byte-identical), the same way
 * `cubes/` was imported. `res/draft/` holds 96 entries: these 94, a
 * `rankings/` directory, and `rankings_cubecobra.txt`. Neither of the latter
 * two is a recipe and neither is imported — this repo's draft bots are a
 * heuristic, not a rankings table.
 *
 * Filenames are Forge's, spaces and apostrophes included, so each recipe still
 * lines up with its counterpart upstream. They do NOT line up with `cubes/`:
 * a recipe names its cube through `DeckFile`, which is the cube's
 * `[metadata] Name=`, not a path. `cubeForRecipe` below is the join.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { parseDraftRecipe, type DraftRecipe } from './draft.ts';
import type { DeckFile } from './dck.ts';

/** Absolute path to the repo's `drafts/` directory. */
export function draftsDir(): string {
  // src/ -> packages/carddata/ -> packages/ -> repo root
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'drafts');
}

/** Filenames (not paths) of every draft recipe, sorted. */
export async function listDraftFiles(dir = draftsDir()): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith('.draft')).sort();
}

/** Parse one recipe by filename. */
export async function loadDraftRecipe(fileName: string, dir = draftsDir()): Promise<DraftRecipe> {
  return parseDraftRecipe(await readFile(join(dir, fileName), 'utf8'));
}

/** Parse every recipe, keyed by filename. */
export async function loadAllDraftRecipes(dir = draftsDir()): Promise<Map<string, DraftRecipe>> {
  const out = new Map<string, DraftRecipe>();
  for (const file of await listDraftFiles(dir)) {
    out.set(file, await loadDraftRecipe(file, dir));
  }
  return out;
}

/**
 * Find the cube a recipe draws from, given cubes keyed by filename (what
 * `loadAllCubes` returns).
 *
 * Forge resolves this as `cubes.get(DeckFile)` against a store keyed by deck
 * name (CustomLimited.java:124), so the match is on the cube's
 * `[metadata] Name=`, not its filename. Returns `null` when no cube claims
 * that name — which is a real condition worth surfacing, not an error: in
 * Forge a missing cube silently falls back to "every card in the database"
 * (CustomLimited.java:126), and inheriting that behaviour would turn a typo
 * into a draft of the entire card pool.
 */
export function cubeForRecipe(
  recipe: DraftRecipe,
  cubes: ReadonlyMap<string, DeckFile>,
): { readonly fileName: string; readonly cube: DeckFile } | null {
  if (recipe.deckFile === null) return null;
  for (const [fileName, cube] of cubes) {
    if (cube.name === recipe.deckFile) return { fileName, cube };
  }
  return null;
}
