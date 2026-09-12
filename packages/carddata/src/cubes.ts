/*
 * Loading the cube lists in `cubes/` at the repo root.
 *
 * These are Forge's own bundled cubes, copied verbatim from
 * `forge/forge-gui/res/cube/*.dck` (95 files, byte-identical). They are data,
 * not code, and the filenames are kept exactly as Forge ships them — spaces,
 * apostrophes and all — so each one still lines up with its counterpart in
 * `forge/forge-gui/res/draft/*.draft`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { parseDck, type DeckFile } from './dck.ts';

/** Absolute path to the repo's `cubes/` directory. */
export function cubesDir(): string {
  // src/ -> packages/carddata/ -> packages/ -> repo root
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'cubes');
}

/** Filenames (not paths) of every cube list, sorted. */
export async function listCubeFiles(dir = cubesDir()): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith('.dck')).sort();
}

/** Parse one cube list by filename. */
export async function loadCube(fileName: string, dir = cubesDir()): Promise<DeckFile> {
  return parseDck(await readFile(join(dir, fileName), 'utf8'));
}

/** Parse every cube list, keyed by filename. */
export async function loadAllCubes(dir = cubesDir()): Promise<Map<string, DeckFile>> {
  const out = new Map<string, DeckFile>();
  for (const file of await listCubeFiles(dir)) {
    out.set(file, await loadCube(file, dir));
  }
  return out;
}
