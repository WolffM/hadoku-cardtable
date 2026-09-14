/*
 * Resolve every card reference in every vendored cube and write the report.
 *
 *   pnpm --filter @hadoku/carddata resolve
 *   pnpm --filter @hadoku/carddata resolve -- --data=<dir> --out=<file>
 *
 * The report is the deliverable, not a log line. Wave 2 §A: "a cube that is
 * 97% resolvable is not draftable, and we need to know which ones those are
 * before lane B builds packs out of them." So this writes committed data —
 * per-cube resolution rates, every unresolved reference, and every set code
 * that failed.
 *
 * The regression gate is NOT this command's exit code. This needs the 180 MB
 * card cache, which is gitignored and absent in CI; the gate is
 * `resolve.test.ts`, which asserts the committed report's numbers and so runs
 * everywhere `pnpm check` does. Re-run this after a Forge or Scryfall bump and
 * the test tells you what moved.
 *
 * The report lives in `packages/carddata/reports/`, deliberately NOT under any
 * directory called `data/`: `.gitignore` refuses `data/` repo-wide, and a
 * report that silently fails to commit is worse than no report.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllCubes, listCubeFiles } from '../cubes.ts';
import { loadAllDraftRecipes, cubeForRecipe } from '../drafts.ts';
import { packSize } from '../draft.ts';
import {
  loadCardIndex,
  resolveCard,
  isKnownForgeSetCode,
  NAME_VARIANTS,
  type CardIndex,
  type NameMatch,
} from '../resolve.ts';
import type { DeckFile } from '../dck.ts';

interface Args {
  readonly dataDir: string;
  readonly outPath: string;
  readonly section: string;
}

function repoRoot(): string {
  // src/cli/ -> src/ -> packages/carddata/ -> packages/ -> repo root
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
}

function defaultDataDir(): string {
  return resolve(repoRoot(), 'packages', 'carddata', 'data');
}

function defaultOutPath(): string {
  return resolve(repoRoot(), 'packages', 'carddata', 'reports', 'cube-resolution.json');
}

function usage(): string {
  return [
    'Usage: resolve-cubes [options]',
    '',
    '  --data=<dir>    card cache directory (default: packages/carddata/data)',
    '  --out=<file>    report path (default: packages/carddata/reports/cube-resolution.json)',
    '  --section=<s>   cube section to resolve (default: main)',
    '  --help',
  ].join('\n');
}

export function parseArgs(argv: readonly string[]): Args {
  let dataDir = defaultDataDir();
  let outPath = defaultOutPath();
  let section = 'main';
  for (const arg of argv) {
    if (arg === '--') continue;
    else if (arg.startsWith('--data=')) dataDir = resolve(arg.slice('--data='.length));
    else if (arg.startsWith('--out=')) outPath = resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--section=')) section = arg.slice('--section='.length);
    else throw new Error(`Unknown argument '${arg}'\n\n${usage()}`);
  }
  return { dataDir, outPath, section };
}

interface TierCounts {
  'name+set+collector': number;
  'name+set': number;
  name: number;
}

type MatchCounts = Record<NameMatch, number>;

interface CubeReport {
  readonly file: string;
  readonly name: string | null;
  readonly lines: number;
  readonly cards: number;
  readonly resolved: number;
  readonly unresolved: number;
  readonly resolvedPct: number;
  readonly tiers: TierCounts;
  /** Which spelling of the name matched — see `NameMatch` in resolve.ts. */
  readonly matchedBy: MatchCounts;
  /** Resolved, but to a printing from a different set than the cube asked for. */
  readonly setFellBack: number;
}

interface UnresolvedRow {
  readonly name: string;
  readonly requestedSet: string | null;
  readonly scryfallSet: string | null;
  readonly collectorNumber: string | null;
  readonly reason: string;
  readonly occurrences: number;
  readonly cubes: readonly string[];
}

interface FailedSetRow {
  readonly forgeSet: string;
  readonly scryfallSet: string | null;
  readonly knownToForge: boolean;
  readonly inCardCache: boolean;
  readonly occurrences: number;
  readonly cubes: number;
}

function emptyTiers(): TierCounts {
  return { 'name+set+collector': 0, 'name+set': 0, name: 0 };
}

function emptyMatches(): MatchCounts {
  const out = {} as MatchCounts;
  for (const variant of NAME_VARIANTS) out[variant] = 0;
  return out;
}

function resolveOneCube(
  file: string,
  cube: DeckFile,
  section: string,
  index: CardIndex,
  sink: {
    unresolved: Map<string, { row: Omit<UnresolvedRow, 'occurrences' | 'cubes'>; n: number; cubes: Set<string> }>;
    failedSets: Map<string, { scryfallSet: string | null; n: number; cubes: Set<string> }>;
  },
): CubeReport {
  const entries = cube.sections.get(section) ?? [];
  const tiers = emptyTiers();
  const matchedBy = emptyMatches();
  let resolved = 0;
  let unresolved = 0;
  let cards = 0;
  let setFellBack = 0;

  for (const entry of entries) {
    cards += entry.count;
    const result = resolveCard(entry.card, index);
    if (result.ok) {
      resolved++;
      tiers[result.tier]++;
      matchedBy[result.matchedBy]++;
      if (result.setFellBack) {
        setFellBack++;
        const key = (result.requestedSet ?? '').toUpperCase();
        const bucket = sink.failedSets.get(key);
        if (bucket === undefined) {
          sink.failedSets.set(key, {
            scryfallSet: result.scryfallSet,
            n: 1,
            cubes: new Set([file]),
          });
        } else {
          bucket.n++;
          bucket.cubes.add(file);
        }
      }
    } else {
      unresolved++;
      const key = `${result.name}|${result.requestedSet ?? ''}|${result.collectorNumber ?? ''}|${result.reason}`;
      const bucket = sink.unresolved.get(key);
      if (bucket === undefined) {
        sink.unresolved.set(key, {
          row: {
            name: result.name,
            requestedSet: result.requestedSet,
            scryfallSet: result.scryfallSet,
            collectorNumber: result.collectorNumber,
            reason: result.reason,
          },
          n: 1,
          cubes: new Set([file]),
        });
      } else {
        bucket.n++;
        bucket.cubes.add(file);
      }
    }
  }

  const total = resolved + unresolved;
  return {
    file,
    name: cube.name,
    lines: entries.length,
    cards,
    resolved,
    unresolved,
    resolvedPct: total === 0 ? 0 : Number(((resolved / total) * 100).toFixed(4)),
    tiers,
    matchedBy,
    setFellBack,
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return 0;
  }

  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    return 2;
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(resolve(args.dataDir, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    console.error(
      `No card cache in ${args.dataDir}. Run the ingest first:\n` +
        `  pnpm --filter @hadoku/carddata sync -- --type=default_cards\n` +
        `\nThe resolver needs every PRINTING, so 'default_cards' — the default\n` +
        `'oracle_cards' file has one entry per Oracle ID and cannot answer a\n` +
        `name+set lookup at all.`,
    );
    return 2;
  }
  if (manifest['bulkType'] !== 'default_cards') {
    console.error(
      `Card cache is '${String(manifest['bulkType'])}', not 'default_cards'. A name+set\n` +
        `lookup needs every printing. Re-run: sync -- --type=default_cards`,
    );
    return 2;
  }
  if (manifest['limit'] !== null) {
    console.error(`Card cache was written with --limit=${String(manifest['limit'])}; it is partial.`);
    return 2;
  }

  console.log(`Loading card cache from ${args.dataDir} ...`);
  const index = await loadCardIndex(args.dataDir);
  console.log(
    `  ${index.printings} printings indexed, ${index.knownSets.size} sets ` +
      `(skipped ${JSON.stringify(index.skipped)})`,
  );

  const cubes = await loadAllCubes();
  const recipes = await loadAllDraftRecipes();
  console.log(`Resolving ${cubes.size} cubes against section '${args.section}' ...`);

  const sink = {
    unresolved: new Map<
      string,
      { row: Omit<UnresolvedRow, 'occurrences' | 'cubes'>; n: number; cubes: Set<string> }
    >(),
    failedSets: new Map<string, { scryfallSet: string | null; n: number; cubes: Set<string> }>(),
  };

  const perCube: CubeReport[] = [];
  for (const [file, cube] of cubes) {
    perCube.push(resolveOneCube(file, cube, args.section, index, sink));
  }

  const totals = {
    cubes: perCube.length,
    lines: perCube.reduce((a, c) => a + c.lines, 0),
    cards: perCube.reduce((a, c) => a + c.cards, 0),
    resolved: perCube.reduce((a, c) => a + c.resolved, 0),
    unresolved: perCube.reduce((a, c) => a + c.unresolved, 0),
    setFellBack: perCube.reduce((a, c) => a + c.setFellBack, 0),
    tiers: perCube.reduce<TierCounts>((acc, c) => {
      acc['name+set+collector'] += c.tiers['name+set+collector'];
      acc['name+set'] += c.tiers['name+set'];
      acc.name += c.tiers.name;
      return acc;
    }, emptyTiers()),
    matchedBy: perCube.reduce<MatchCounts>((acc, c) => {
      for (const variant of NAME_VARIANTS) acc[variant] += c.matchedBy[variant];
      return acc;
    }, emptyMatches()),
  };

  const unresolvedRows: UnresolvedRow[] = [...sink.unresolved.values()]
    .map((b) => ({ ...b.row, occurrences: b.n, cubes: [...b.cubes].sort() }))
    .sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name));

  const failedSetRows: FailedSetRow[] = [...sink.failedSets.entries()]
    .map(([forgeSet, b]) => ({
      forgeSet,
      scryfallSet: b.scryfallSet,
      knownToForge: isKnownForgeSetCode(forgeSet),
      inCardCache: b.scryfallSet !== null && index.knownSets.has(b.scryfallSet),
      occurrences: b.n,
      cubes: b.cubes.size,
    }))
    .sort((a, b) => b.occurrences - a.occurrences || a.forgeSet.localeCompare(b.forgeSet));

  // Recipe coverage: a recipe whose DeckFile names no cube would draft from
  // Forge's entire card database rather than the cube (CustomLimited.java:126).
  const recipeRows = [...recipes.entries()]
    .map(([file, recipe]) => {
      const match = cubeForRecipe(recipe, cubes);
      return {
        file,
        name: recipe.name,
        deckFile: recipe.deckFile,
        cubeFile: match === null ? null : match.fileName,
        singleton: recipe.singleton,
        numPacks: recipe.numPacks,
        numPlayers: recipe.numPlayers,
        packSize: packSize(recipe),
        booster: recipe.booster,
        landSetCode: recipe.landSetCode,
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file));

  const cubeFiles = await listCubeFiles();
  const report = {
    $comment:
      'GENERATED by packages/carddata/src/cli/resolve-cubes.ts. Committed on purpose: ' +
      'this is the evidence that the cube corpus is draftable, and a diff here is a regression.',
    generatedAt: new Date().toISOString(),
    cardCache: {
      bulkType: manifest['bulkType'],
      sourceUpdatedAt: manifest['sourceUpdatedAt'],
      cardCount: manifest['cardCount'],
      indexedPrintings: index.printings,
      distinctSets: index.knownSets.size,
      skipped: index.skipped,
    },
    section: args.section,
    totals,
    fullyResolvedCubes: perCube.filter((c) => c.unresolved === 0).length,
    worstCubes: [...perCube].sort((a, b) => a.resolvedPct - b.resolvedPct).slice(0, 10),
    perCube: [...perCube].sort((a, b) => a.file.localeCompare(b.file)),
    unresolved: unresolvedRows,
    failedSetCodes: failedSetRows,
    recipes: {
      count: recipeRows.length,
      withoutCube: recipeRows.filter((r) => r.cubeFile === null).map((r) => r.file),
      cubesWithoutRecipe: cubeFiles.filter(
        (f) => !recipeRows.some((r) => r.cubeFile === f),
      ),
      list: recipeRows,
    },
  };

  await mkdir(dirname(args.outPath), { recursive: true });
  await writeFile(args.outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(`  cubes            ${totals.cubes}`);
  console.log(`  card lines       ${totals.lines}  (${totals.cards} cards counting duplicates)`);
  console.log(`  resolved         ${totals.resolved}`);
  console.log(`    name+set+cn    ${totals.tiers['name+set+collector']}`);
  console.log(`    name+set       ${totals.tiers['name+set']}`);
  console.log(`    name only      ${totals.tiers.name}  (${totals.setFellBack} of these asked for a set)`);
  for (const variant of NAME_VARIANTS) {
    console.log(`  matched by ${variant.padEnd(18)} ${totals.matchedBy[variant]}`);
  }
  console.log(`  unresolved       ${totals.unresolved}  (${unresolvedRows.length} distinct)`);
  console.log(`  failed set codes ${failedSetRows.length}`);
  console.log(`  fully resolved   ${report.fullyResolvedCubes}/${totals.cubes} cubes`);
  console.log('');
  console.log(`Report written to ${args.outPath}`);

  return 0;
}

process.exitCode = await main();
