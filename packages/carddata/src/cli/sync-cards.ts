/*
 * The documented ingest command.
 *
 *   pnpm --filter @hadoku/carddata sync
 *   pnpm --filter @hadoku/carddata sync -- --type=default_cards --force
 *   pnpm --filter @hadoku/carddata sync -- --limit=500        # bounded smoke run
 *
 * Run on a schedule, not per request. Scryfall regenerate bulk files every
 * 12-24h and say gameplay data (names, Oracle text, mana costs) changes much
 * less often than that — "once per week or right after set releases would most
 * likely be sufficient."
 *
 * No types are built: Node 24 strips TypeScript natively, so this file is the
 * executable.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sync, BULK_TYPES } from '../scryfall/bulk.ts';
import { RateLimitedError } from '../scryfall/client.ts';

/** Default cache location: `packages/carddata/data/`, which `.gitignore` refuses. */
function defaultOutDir(): string {
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'data');
}

interface Args {
  readonly bulkType: string;
  readonly outDir: string;
  readonly force: boolean;
  readonly limit: number | null;
}

function usage(): string {
  return [
    'Usage: sync-cards [options]',
    '',
    `  --type=<name>   bulk file to ingest (default: default_cards)`,
    `                  known: ${BULK_TYPES.join(', ')}`,
    '  --out=<dir>     cache directory (default: packages/carddata/data)',
    '  --force         re-download even if the cache is already current',
    '  --limit=<n>     stop after n cards (smoke tests only — writes a partial cache)',
    '  --help',
  ].join('\n');
}

export function parseArgs(argv: readonly string[]): Args {
  let bulkType = 'default_cards';
  let outDir = defaultOutDir();
  let force = false;
  let limit: number | null = null;

  for (const arg of argv) {
    if (arg === '--') {
      // `pnpm run sync -- --limit=10` forwards the `--` itself to the script
      // rather than eating it, so accept and ignore it. Both invocation styles
      // in docs/CARD_DATA.md then work.
      continue;
    } else if (arg === '--force') {
      force = true;
    } else if (arg.startsWith('--type=')) {
      bulkType = arg.slice('--type='.length);
    } else if (arg.startsWith('--out=')) {
      outDir = resolve(arg.slice('--out='.length));
    } else if (arg.startsWith('--limit=')) {
      const n = Number.parseInt(arg.slice('--limit='.length), 10);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--limit must be a positive integer`);
      limit = n;
    } else {
      throw new Error(`Unknown argument '${arg}'\n\n${usage()}`);
    }
  }
  return { bulkType, outDir, force, limit };
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

  if (args.limit !== null) {
    console.warn(`! --limit=${args.limit} set: this writes a PARTIAL cache, not a usable one.`);
  }

  try {
    const result = await sync({
      bulkType: args.bulkType,
      outDir: args.outDir,
      force: args.force,
      limit: args.limit,
      onProgress: (message) => console.log(message),
    });
    const { manifest } = result;
    console.log(
      `${result.upToDate ? 'Cache current' : 'Cache written'}: ${manifest.cardCount} cards ` +
        `(${manifest.bulkType}, source ${manifest.sourceUpdatedAt}) in ${result.outDir}`,
    );
    if (manifest.skippedLines > 0) {
      console.warn(`! ${manifest.skippedLines} unparseable line(s) skipped.`);
    }
    return 0;
  } catch (error) {
    if (error instanceof RateLimitedError) {
      console.error(`${error.message}. Not retrying — reduce how often this runs.`);
      return 3;
    }
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 1;
  }
}

process.exitCode = await main();
