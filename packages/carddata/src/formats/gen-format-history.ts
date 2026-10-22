/*
 * Generator for `standard-history.generated.ts`, `modern-history.generated.ts`
 * and `legacy-history.generated.ts`.
 *
 * Standard's rotation history is not a rule you can compute. The model changed
 * four times — block rotation with biennial core sets, block rotation with
 * annual core sets, the 2016 two-block experiment, and the 2023 three-year
 * extension — and each change carries exceptions that a rule misses. So this
 * package does not encode a rule. It transcribes a dated table, and the table
 * comes with a citation per row.
 *
 * The source is Forge's own archived format data:
 *
 *   forge-gui/res/formats/Archived/Standard/<effective-date>.txt   (154 files)
 *   forge-gui/res/formats/Sanctioned/Standard.txt                  (current)
 *
 * Each file is a `[format]` section with `Effective:`, `Sets:` (Forge set
 * codes), and optionally `Banned:`, `Restricted:` and `RestrictedLegendary:`.
 * That is Forge declaring what Standard was on a date, in the same way
 * `set-codes.generated.ts` is Forge declaring which Scryfall set its own codes
 * mean — and it is checkable by anyone with the vendored checkout, which is the
 * entire point (see `dck.ts` for the house style this follows).
 *
 * Modern and Legacy do not rotate, but their ban lists and set lists still
 * change dated file by dated file the same way, from `Archived/Modern/` (103
 * files) and `Archived/Legacy/` (288 files), so the same transcription applies.
 *
 * `forge/` is gitignored and absent in CI, so the table is transcribed into a
 * committed `.ts` file rather than read at runtime. Regenerate with:
 *
 *   node src/formats/gen-format-history.ts --subtype=Standard --formats=../../forge/forge-gui/res/formats
 *   node src/formats/gen-format-history.ts --subtype=Modern --formats=../../forge/forge-gui/res/formats
 *   node src/formats/gen-format-history.ts --subtype=Legacy --formats=../../forge/forge-gui/res/formats
 *
 * Forge is GPL-3.0-or-later and so is this repo.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toScryfallSetCode } from '../set-codes.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FORMATS_DIR = join(HERE, '..', '..', '..', '..', 'forge', 'forge-gui', 'res', 'formats');

interface ParsedFormat {
  readonly name: string;
  readonly effective: string | null;
  readonly forgeSets: readonly string[];
  readonly banned: readonly string[];
  readonly restricted: readonly string[];
  readonly restrictedLegendary: boolean;
}

/** Forge's `FileSection` format: `Key:Value`, one per line, `;`-joined lists. */
function parseFormatFile(text: string): ParsedFormat {
  const field = (key: string): string | null => {
    const m = new RegExp(`^${key}:(.*)$`, 'm').exec(text);
    return m === null ? null : m[1].trim();
  };
  const list = (key: string, sep: string): readonly string[] => {
    const raw = field(key);
    if (raw === null) return [];
    return raw
      .split(sep)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  };
  return {
    name: field('Name') ?? '',
    effective: field('Effective'),
    forgeSets: list('Sets', ','),
    banned: list('Banned', ';'),
    restricted: list('Restricted', ';'),
    restrictedLegendary: (field('RestrictedLegendary') ?? '').toLowerCase() === 'true',
  };
}

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) if (a.startsWith(prefix)) return a.slice(prefix.length);
  return null;
}

function quote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function stringArray(items: readonly string[], indent: string): string {
  if (items.length === 0) return '[]';
  const body = items.map((s) => `${indent}  ${quote(s)},`).join('\n');
  return `[\n${body}\n${indent}]`;
}

function main(): void {
  const subtype = arg('subtype');
  if (subtype !== 'Standard' && subtype !== 'Modern' && subtype !== 'Legacy') {
    throw new Error(`--subtype must be Standard, Modern or Legacy, got ${JSON.stringify(subtype)}`);
  }
  const lower = subtype.toLowerCase();
  const upper = subtype.toUpperCase();
  const formatsDir = arg('formats') ?? DEFAULT_FORMATS_DIR;
  const archivedDir = join(formatsDir, 'Archived', subtype);
  const out = join(HERE, `${lower}-history.generated.ts`);

  // TOP LEVEL ONLY, and this is not incidental. `Archived/Standard/` has a
  // `China/` subdirectory holding 8 more dated files — a regional variant of
  // the format, not Standard. `find -type f` returns 162 there; `-maxdepth 1`
  // returns 154. Mixing the eight in would corrupt the table by whole
  // snapshots, which is the "silently wrong by one set" failure this module is
  // built to refuse. `isFile()` is what keeps them out, so it is asserted here
  // as a count rather than left to the `.txt` suffix happening to exclude a
  // directory name.
  const entries = readdirSync(archivedDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.txt'))
    .map((e) => e.name)
    .sort();
  const subdirectories = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  const rows: { parsed: ParsedFormat; source: string; scryfallSets: string[] }[] = [];
  const untranslatable: string[] = [];
  // The filename is the effective date in Forge's data, and on all 154 of
  // Standard's rows the two agree; a disagreement there is a typo, and the
  // table refuses to pick a winner silently. Modern's archive has one file
  // (`2018-02-19.txt`, `Effective:2018-02-12`) where they do not. The
  // invariant the binary search actually needs is monotonic `effective` values
  // in file order, checked below, so for Modern and Legacy a disagreement that
  // does NOT break that order is recorded, not refused.
  const filenameMismatches: string[] = [];

  for (const file of files) {
    const parsed = parseFormatFile(readFileSync(join(archivedDir, file), 'utf8'));
    const effective = parsed.effective;
    if (effective === null) throw new Error(`${file}: no Effective: line`);
    if (effective !== file.replace(/\.txt$/, '')) {
      if (subtype === 'Standard') throw new Error(`${file}: Effective:${effective} disagrees with the filename`);
      filenameMismatches.push(`${file}: Effective:${effective}`);
    }
    const scryfallSets: string[] = [];
    for (const forgeCode of parsed.forgeSets) {
      const code = toScryfallSetCode(forgeCode);
      if (code === null) {
        untranslatable.push(`${file}: ${forgeCode}`);
        continue;
      }
      scryfallSets.push(code.toUpperCase());
    }
    rows.push({ parsed, source: `Archived/${subtype}/${file}`, scryfallSets });
  }

  if (untranslatable.length > 0) {
    // Refusing beats emitting a table with holes in it: a pool that is
    // silently short one set is the exact failure this module exists to avoid.
    throw new Error(`Forge set codes with no ScryfallCode:\n  ${untranslatable.join('\n  ')}`);
  }

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].parsed.effective as string;
    const cur = rows[i].parsed.effective as string;
    if (cur < prev) {
      throw new Error(
        `${rows[i].source}: Effective:${cur} is before the previous row's Effective:${prev} — ` +
          'the table would not be sorted, which the binary search in generic-format.ts requires',
      );
    }
  }

  // The Sanctioned file has no Effective: date — it is "<Subtype> now". Read
  // only to check the newest archived row still describes it.
  const sanctioned = parseFormatFile(readFileSync(join(formatsDir, 'Sanctioned', `${subtype}.txt`), 'utf8'));
  const newest = rows[rows.length - 1];
  const sanctionedMatchesNewest =
    sanctioned.forgeSets.join(',') === newest.parsed.forgeSets.join(',') &&
    sanctioned.banned.join(';') === newest.parsed.banned.join(';');

  const body = rows
    .map((r) => {
      const p = r.parsed;
      return [
        '  {',
        `    effective: ${quote(p.effective as string)},`,
        `    name: ${quote(p.name)},`,
        `    sets: ${stringArray(r.scryfallSets, '    ')},`,
        `    forgeSets: ${stringArray(p.forgeSets, '    ')},`,
        `    banned: ${stringArray(p.banned, '    ')},`,
        `    restricted: ${stringArray(p.restricted, '    ')},`,
        `    restrictedLegendary: ${String(p.restrictedLegendary)},`,
        `    source: ${quote(r.source)},`,
        '  },',
      ].join('\n');
    })
    .join('\n');

  // Standard's table predates the other two and keeps its own wording and
  // export names (`STANDARD_HISTORY`, `SANCTIONED_MATCHES_NEWEST`).
  const text =
    subtype === 'Standard'
      ? `/*
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate with:
 *   node src/formats/gen-format-history.ts --subtype=Standard --formats=<forge-gui/res/formats>
 *
 * Source: Forge's own archived Standard format data, one file per date on
 * which Standard changed. Forge is declaring what Standard WAS on each date;
 * this file is that declaration transcribed, with the source file named on
 * every row so a boundary can be re-checked rather than trusted.
 *
 *   ${rows.length} rows, ${rows[0].parsed.effective} .. ${newest.parsed.effective}
 *   Top-level files only. ${String(subdirectories.length)} subdirector${subdirectories.length === 1 ? 'y was' : 'ies were'} skipped${
   subdirectories.length === 0 ? '' : ` (${subdirectories.join(', ')})`
 }: they hold
 *   regional variants of the format and are not Standard.
 *   Sets are Scryfall codes, translated through Forge's own ScryfallCode table
 *   (\`set-codes.generated.ts\`). ${untranslatable.length} codes failed to translate.
 *   Sanctioned/Standard.txt (Forge's "Standard now") ${
     sanctionedMatchesNewest ? 'MATCHES' : 'DOES NOT MATCH'
   } the newest row,
 *   which is what makes that row the current format rather than a stale one.
 *
 * \`forge/\` is gitignored and absent in CI, so this table is committed rather
 * than read at runtime. That is the same reason \`set-codes.generated.ts\` is
 * committed.
 *
 * Forge is GPL-3.0-or-later and so is this repo.
 */

/** One dated snapshot of Standard, transcribed from one Forge format file. */
export interface StandardSnapshot {
  /** ISO date this snapshot took effect, inclusive. */
  readonly effective: string;
  /** Forge's own name for the snapshot, e.g. \`Standard (ELD)\`. */
  readonly name: string;
  /** Legal sets as Scryfall codes, upper-cased, in Forge's order. */
  readonly sets: readonly string[];
  /** The same sets as Forge writes them, so a row can be diffed against source. */
  readonly forgeSets: readonly string[];
  /** Banned card names, exactly as Forge writes them. */
  readonly banned: readonly string[];
  /** Restricted card names — the 1995-2003 Type 2 rule, empty since. */
  readonly restricted: readonly string[];
  /** Forge's \`RestrictedLegendary:true\`: one of each legendary per deck. */
  readonly restrictedLegendary: boolean;
  /** The Forge file this row was read out of, relative to \`res/formats/\`. */
  readonly source: string;
}

/** Every dated snapshot, oldest first. Adjacent rows bracket every date. */
export const STANDARD_HISTORY: readonly StandardSnapshot[] = [
${body}
];

/** Whether Forge's undated \`Sanctioned/Standard.txt\` equals the newest row. */
export const SANCTIONED_MATCHES_NEWEST = ${String(sanctionedMatchesNewest)};
`
      : `/*
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate with:
 *   node src/formats/gen-format-history.ts --subtype=${subtype} --formats=<forge-gui/res/formats>
 *
 * Source: Forge's own archived ${subtype} format data, one file per date on
 * which ${subtype} changed. Forge is declaring what ${subtype} WAS on each
 * date; this file is that declaration transcribed, with the source file named
 * on every row so a boundary can be re-checked rather than trusted. Same
 * transcribe-don't-derive approach as \`standard-history.generated.ts\`
 * (\`gen-format-history.ts\`'s header has the full argument).
 *
 *   ${rows.length} rows, ${rows[0].parsed.effective} .. ${newest.parsed.effective}
 *   Top-level files only. ${String(subdirectories.length)} subdirector${subdirectories.length === 1 ? 'y was' : 'ies were'} skipped${
   subdirectories.length === 0 ? '' : ` (${subdirectories.join(', ')})`
 }.
 *   Sets are Scryfall codes, translated through Forge's own ScryfallCode table
 *   (\`set-codes.generated.ts\`). ${untranslatable.length} codes failed to translate.
 *   ${filenameMismatches.length} row(s) where Effective: disagrees with the filename${
   filenameMismatches.length === 0 ? '' : ` (${filenameMismatches.join('; ')})`
 } — the Effective: value is what is used; checked for monotonic order instead of filename
 *   agreement, since that is the invariant \`formatAt\`'s binary search needs.
 *   Sanctioned/${subtype}.txt (Forge's "${subtype} now") ${
     sanctionedMatchesNewest ? 'MATCHES' : 'DOES NOT MATCH'
   } the newest row,
 *   which is what makes that row the current format rather than a stale one.
 *
 * \`forge/\` is gitignored and absent in CI, so this table is committed rather
 * than read at runtime.
 *
 * Forge is GPL-3.0-or-later and so is this repo.
 */

/** One dated snapshot of ${subtype}, transcribed from one Forge format file. */
export interface ${subtype}Snapshot {
  /** ISO date this snapshot took effect, inclusive. */
  readonly effective: string;
  /** Forge's own name for the snapshot, e.g. \`${subtype} (M13)\`. */
  readonly name: string;
  /** Legal sets as Scryfall codes, upper-cased, in Forge's order. */
  readonly sets: readonly string[];
  /** The same sets as Forge writes them, so a row can be diffed against source. */
  readonly forgeSets: readonly string[];
  /** Banned card names, exactly as Forge writes them. */
  readonly banned: readonly string[];
  /** Restricted card names. */
  readonly restricted: readonly string[];
  /** Forge's \`RestrictedLegendary:true\`: one of each legendary per deck. */
  readonly restrictedLegendary: boolean;
  /** The Forge file this row was read out of, relative to \`res/formats/\`. */
  readonly source: string;
}

/** Every dated snapshot, oldest first. Adjacent rows bracket every date. */
export const ${upper}_HISTORY: readonly ${subtype}Snapshot[] = [
${body}
];

/** Whether Forge's undated \`Sanctioned/${subtype}.txt\` equals the newest row. */
export const ${upper}_SANCTIONED_MATCHES_NEWEST = ${String(sanctionedMatchesNewest)};
`;

  writeFileSync(out, text);
  process.stdout.write(
    `wrote ${out}\n  ${rows.length} snapshots, ${rows[0].parsed.effective} .. ${newest.parsed.effective}\n` +
      `  sanctioned matches newest: ${String(sanctionedMatchesNewest)}\n`,
  );
}

main();
