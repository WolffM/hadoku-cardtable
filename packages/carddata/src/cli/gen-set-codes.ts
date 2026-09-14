/*
 * Regenerate `src/set-codes.generated.ts` from Forge's edition files.
 *
 *   node src/cli/gen-set-codes.ts --editions=<path to forge-gui/res/editions>
 *
 * This is NOT run at build time and is not on any hot path. `forge/` is
 * gitignored (D2) and may be absent entirely, so the table it produces is
 * committed and this script exists only to re-derive it when Forge is updated.
 * Run it, then `git diff` the generated file — a Forge bump that renames a set
 * code should be visible as a diff, not discovered by a resolution failure.
 *
 * Why the table is needed at all: a cube list writes `1 Stoneforge Mystic|PRM`
 * in *Forge's* set-code vocabulary, which is not always Scryfall's. Forge
 * records the translation itself, one `ScryfallCode=` per edition file, and
 * using it beats any heuristic we could invent.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

interface Edition {
  readonly file: string;
  readonly code: string | null;
  readonly code2: string | null;
  readonly alias: string | null;
  readonly scryfall: string | null;
  readonly name: string | null;
}

/** Read the `[metadata]` block of one edition file. Card rows are not parsed. */
function parseEditionMetadata(text: string): Map<string, string> {
  const meta = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // The metadata block is first; `[cards]` (or any later section) ends it.
    if (line.startsWith('[') && line.endsWith(']') && line.toLowerCase() !== '[metadata]') break;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    meta.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return meta;
}

async function readEditions(dir: string): Promise<Edition[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.txt')).sort();
  const out: Edition[] = [];
  for (const file of files) {
    const meta = parseEditionMetadata(await readFile(join(dir, file), 'utf8'));
    out.push({
      file,
      code: meta.get('Code') ?? null,
      code2: meta.get('Code2') ?? null,
      alias: meta.get('Alias') ?? null,
      scryfall: meta.get('ScryfallCode') ?? null,
      name: meta.get('Name') ?? null,
    });
  }
  return out;
}

/**
 * Build the lookup table.
 *
 * Every name an edition answers to — `Code`, `Code2`, `Alias` — maps to its
 * `ScryfallCode`. Precedence is Code, then Code2, then Alias, and a later
 * source never overwrites an earlier one. That ordering settles the single
 * collision in Forge's current data: `ARC` is the `Code` of Archenemy and also
 * the `Alias` of a different edition whose Scryfall code is `OARC`. Forge
 * itself looks up by `Code` first (`CardEdition.Collection.get`), so Archenemy
 * wins, and we match.
 *
 * Six editions carry no `ScryfallCode` (Amonkhet, Drake Stone, Ikoria,
 * Planeshift, and two Teenage Mutant Ninja Turtles sets). They fall back to
 * their own `Code`, which for AKH/IKO/PLS is already the Scryfall code; the
 * fallback is recorded in the generated file so it is visible rather than
 * assumed.
 */
function buildTable(editions: readonly Edition[]): {
  table: Map<string, string>;
  collisions: string[];
  missingScryfall: string[];
} {
  const table = new Map<string, string>();
  const collisions: string[] = [];
  const missingScryfall: string[] = [];

  const scryfallFor = (e: Edition): string | null => {
    if (e.scryfall !== null && e.scryfall.length > 0) return e.scryfall;
    if (e.code !== null && e.code.length > 0) return e.code;
    return null;
  };

  for (const e of editions) {
    if (e.scryfall === null || e.scryfall.length === 0) missingScryfall.push(`${e.code} (${e.file})`);
  }

  for (const source of ['code', 'code2', 'alias'] as const) {
    for (const e of editions) {
      const key = e[source];
      const value = scryfallFor(e);
      if (key === null || key.length === 0 || value === null) continue;
      const K = key.toUpperCase();
      const existing = table.get(K);
      if (existing === undefined) {
        table.set(K, value.toUpperCase());
      } else if (existing !== value.toUpperCase()) {
        collisions.push(`${K}: kept ${existing}, ignored ${value.toUpperCase()} from ${source} of ${e.file}`);
      }
    }
  }

  return { table, collisions, missingScryfall };
}

function render(
  table: ReadonlyMap<string, string>,
  editionCount: number,
  collisions: readonly string[],
  missingScryfall: readonly string[],
): string {
  const keys = [...table.keys()].sort();
  const rows = keys.map((k) => `  ['${k}', '${table.get(k) ?? ''}'],`).join('\n');
  const identity = keys.filter((k) => k === table.get(k)).length;

  return `/*
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate with:
 *   node src/cli/gen-set-codes.ts --editions=<forge-gui/res/editions>
 *
 * Source: Forge's own edition files, one \`ScryfallCode=\` per edition. That is
 * Forge's declaration of which Scryfall set its own set code means, so it is
 * the authority here and not a heuristic of ours.
 *
 * Derived from ${editionCount} edition files:
 *   ${table.size} lookup keys (Code, Code2 and Alias all resolve)
 *   ${identity} are identity mappings; ${table.size - identity} genuinely differ
 *   ${missingScryfall.length} editions declare no ScryfallCode and fall back to their own Code:
 *     ${missingScryfall.join('\n *     ')}
 *   ${collisions.length} key collision(s), resolved Code > Code2 > Alias:
 *     ${collisions.length === 0 ? '(none)' : collisions.join('\n *     ')}
 *
 * Forge is GPL-3.0-or-later and so is this repo.
 */

/** Forge set code (upper-cased) to Scryfall set code (upper-cased). */
export const FORGE_TO_SCRYFALL_SET: ReadonlyMap<string, string> = new Map([
${rows}
]);
`;
}

function defaultOut(): string {
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'set-codes.generated.ts');
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let editionsDir: string | null = null;
  let outPath = defaultOut();

  for (const arg of argv) {
    if (arg === '--') continue;
    else if (arg.startsWith('--editions=')) editionsDir = resolve(arg.slice('--editions='.length));
    else if (arg.startsWith('--out=')) outPath = resolve(arg.slice('--out='.length));
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: gen-set-codes --editions=<dir> [--out=<file>]');
      return 0;
    } else {
      console.error(`Unknown argument '${arg}'`);
      return 2;
    }
  }

  if (editionsDir === null) {
    console.error(
      'Missing --editions=<dir>. Point it at forge-gui/res/editions.\n' +
        'forge/ is gitignored and may be absent; the generated table is committed, so\n' +
        'this only needs running when Forge is updated.',
    );
    return 2;
  }

  const editions = await readEditions(editionsDir);
  if (editions.length === 0) {
    console.error(`No edition files found in ${editionsDir}`);
    return 1;
  }

  const { table, collisions, missingScryfall } = buildTable(editions);
  await writeFile(outPath, render(table, editions.length, collisions, missingScryfall), 'utf8');
  console.log(
    `Wrote ${table.size} set-code mappings from ${editions.length} editions to ${outPath}` +
      ` (${collisions.length} collision(s), ${missingScryfall.length} without a ScryfallCode)`,
  );
  return 0;
}

process.exitCode = await main();
