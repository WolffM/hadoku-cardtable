/*
 * The documented catalog-build command — a thin CLI wrapper over
 * `../catalog-build.ts`'s `runBuildCatalog`, which has all the real work
 * (and no top-level side effect, which is the point: see its header for the
 * bundling incident that made this split necessary).
 *
 *   pnpm --filter @hadoku/carddata build-catalog
 *   pnpm --filter @hadoku/carddata build-catalog -- --data=/path/to/carddata/data --out=/path/to/cards.json
 *
 * Requires a synced cache: `pnpm --filter @hadoku/carddata sync` first, or
 * `--data=` pointed at one that already exists (read-only; this never writes
 * there).
 *
 * `main` is the whole CLI surface: same argv parsing, same two
 * `console.log` lines, same `process.exit(1)` on a bad cache or a D13
 * violation this file always had. `runBuildCatalog` throws on those two
 * failures instead of calling `process.exit` itself; this is the ONLY place
 * that catches that throw and turns it into an exit code — `index.ts` never
 * imports this file (`index-no-cli-imports.test.ts` enforces it), so nothing
 * other than a direct `node cli/build-catalog.ts` invocation ever reaches
 * this `main`.
 */

import { resolve } from 'node:path';
import { runBuildCatalog, type RunBuildCatalogResult } from '../catalog-build.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dataArg = args.find((a) => a.startsWith('--data='));
  const outArg = args.find((a) => a.startsWith('--out='));
  const dataDir = dataArg ? resolve(dataArg.slice('--data='.length)) : undefined;
  const outPath = outArg ? resolve(outArg.slice('--out='.length)) : undefined;

  let result: RunBuildCatalogResult;
  try {
    result = await runBuildCatalog({ dataDir, outPath });
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
    return;
  }

  console.log(`catalog: ${result.cardCount} cards, ${result.aliasCount} aliases, from ${result.printings} printings -> ${result.outPath}`);
  console.log(`D13 control: ${result.cardCount} cards, no image field and no image URL.`);
}

// Guarded so this file can be imported (e.g. by a test) without running the
// whole CLI. Same convention `build-pool.ts` uses. Harmless even inside a
// bundle, now that nothing reachable from `index.ts` imports this file —
// but the guard alone is NOT what fixed the incident; the import direction
// is (see `catalog-build.ts`'s header).
if (import.meta.main) await main();
