/*
 * Regenerate `games/magic/packages/draft/src/cube-rankings.generated.ts` from Forge's cube pick order.
 *
 *   node scripts/draft/gen-cube-rankings.ts [--rankings=<path to rankings_cubecobra.txt>]
 *
 * The default path is the pinned submodule's `forge/forge-gui/res/draft/rankings_cubecobra.txt`,
 * the file Forge's own `CardRanker` reads for cube drafts. The bots never read `forge/` at runtime
 * (production and the claws must not depend on it), so the order is committed and this script only
 * re-derives it when Forge is bumped. Run it, then `git diff` the generated file.
 *
 * Input rows are `#<rank>|<name>|<rarity>|<set>` after a `Rank|Name|Rarity|Set` header. Only the
 * names are kept, in rank order: the rarity and set columns are `C` and `CUSTOM` on every row.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const DEFAULT_RANKINGS = resolve(REPO, 'forge', 'forge-gui', 'res', 'draft', 'rankings_cubecobra.txt');
const OUT = resolve(REPO, 'packages', 'draft', 'src', 'cube-rankings.generated.ts');

/** Names in rank order. Throws on a row it cannot read or a gap in the ranks, rather than shipping a shifted order. */
function parseRankings(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('Rank|')) continue;
    const match = /^#(\d+)\|([^|]+)\|/.exec(line);
    if (!match) throw new Error(`unreadable ranking row: ${line}`);
    const rank = Number(match[1]);
    if (rank !== names.length + 1) throw new Error(`rank ${rank} out of order (expected ${names.length + 1})`);
    names.push(match[2]!.trim());
  }
  if (names.length === 0) throw new Error('no ranking rows');
  return names;
}

function render(names: readonly string[]): string {
  return `/*
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate with:
 *   node scripts/draft/gen-cube-rankings.ts
 *
 * Source: Forge's forge-gui/res/draft/rankings_cubecobra.txt (GPL-3.0), the CubeCobra pick order
 * Forge's own CardRanker uses for cube drafts. ${names.length} card names, best first: index 0 is
 * rank 1.
 */

export const CUBE_RANKING: readonly string[] = ${JSON.stringify(names, null, 1)};
`;
}

async function main(): Promise<void> {
  const arg = process.argv.find((a) => a.startsWith('--rankings='));
  const path = arg ? resolve(arg.slice('--rankings='.length)) : DEFAULT_RANKINGS;
  const names = parseRankings(await readFile(path, 'utf8'));
  await writeFile(OUT, render(names));
  console.log(`wrote ${names.length} names to ${OUT}`);
}

if (import.meta.main) await main();
