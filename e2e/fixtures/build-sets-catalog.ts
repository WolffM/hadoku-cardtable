/**
 * Builds the e2e stack's own card catalog fixture — a small, committed
 * subset of the real catalog (`apps/server/src/pools/catalog.ts`'s own
 * `{cards, aliases, printings}` shape), covering exactly the sets
 * `draft-sets.spec.ts` deals: ISD, ALA, ARB.
 *
 * ## Why this exists
 *
 * A claw has no `~/.local/share/cardtable/catalog/cards.json` — that file is
 * built offline and deployed to hokon only (`packages/carddata`'s
 * `build-catalog` CLI), and nothing provisions it on the claw fleet. Without
 * it, `CardCatalog.byName`/`byPrinting` answer `null` for every card, so
 * `room/plan.ts`'s verdict refuses every realistic/set-cube source for
 * `missingText` — ALL of them, named — which is exactly what
 * `39746410366` showed on the first `-f video=true` dispatch (ENOENT,
 * `catalog-load-failed`). The play harness already has this answer for
 * cubes: `CARDTABLE_CUBES_DIR` points the spawned server at a committed
 * fixture directory rather than `data/cubes`. This is the same move for
 * the catalog — `e2e/play/harness.ts` points `CARDTABLE_CATALOG` at this
 * file's own output instead of the real one.
 *
 * ## What it keeps
 *
 * - Every `printings` entry whose own `setCode` is one of `--sets` (default
 *   `ISD,ALA,ARB`), and that printing's canonical card (`cards` + any
 *   `aliases` pointing at it). This alone covers a round's own basic land
 *   too: Alara Reborn's booster (`forge-gui/res/editions/Alara
 *   Reborn.txt`: "1 BasicLand ALA") deals it from ALA's own set, and ALA
 *   is itself a kept set, so that printing is already here.
 * - The five basic lands' own canonical entries (`byName` fallback safety
 *   net), kept regardless of whether a target-set printing already
 *   covered them.
 * - Nothing else: no `scryfallId`-derived image field exists on
 *   `DraftCardSchema` to begin with, and this script copies fields,
 *   never invents one.
 *
 * ## Determinism
 *
 * Every object's keys are written sorted, so a re-run against the same
 * source catalog is byte-identical — a fixture that can be diffed and
 * reviewed like any other committed file, not a blob that churns on every
 * generation.
 *
 * Usage: `node e2e/fixtures/build-sets-catalog.ts [--catalog=<path>]
 * [--sets=ISD,ALA,ARB] [--out=<path>]`. The source catalog is READ ONLY —
 * this never writes back to it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

interface PrintingRefFile {
  key?: unknown;
  scryfallId?: unknown;
}

interface CatalogFile {
  cards: Record<string, unknown>;
  aliases: Record<string, unknown>;
  printings?: Record<string, unknown>;
}

interface DraftCardLike {
  name?: unknown;
  setCode?: unknown;
}

const BASIC_LAND_NAMES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];

function argValue(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return hit === undefined ? fallback : hit.slice(prefix.length);
}

function sortedObject<T>(entries: Iterable<[string, T]>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) out[key] = value;
  return out;
}

function main(): void {
  const catalogPath = argValue('catalog', resolve(homedir(), '.local/share/cardtable/catalog/cards.json'));
  const sets = argValue('sets', 'ISD,ALA,ARB')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s !== '');
  const outPath = resolve(import.meta.dirname, argValue('out', 'sets-catalog.json'));

  const raw = JSON.parse(readFileSync(catalogPath, 'utf8')) as Partial<CatalogFile>;
  const sourceCards = raw.cards ?? {};
  const sourceAliases = raw.aliases ?? {};
  const sourcePrintings = raw.printings ?? {};

  const keptKeys = new Set<string>();
  const keptPrintings = new Map<string, unknown>();

  for (const [printingKey, value] of Object.entries(sourcePrintings)) {
    const ref = value as PrintingRefFile;
    if (typeof ref.key !== 'string') continue;
    // The printing key is itself "<SET>:<collectorNumber>" (catalog.ts's own `printingKey`); the
    // set is also on the resolved card's own `setCode`, so either reads the same fact — use the
    // key, since it is present on every entry and the card lookup below is what might be missing.
    const setCode = printingKey.split(':')[0];
    if (!sets.includes(setCode)) continue;
    keptKeys.add(ref.key);
    keptPrintings.set(printingKey, value);
  }

  // The basic lands' own canonical entries — a `byName` fallback safety net, independent of
  // whether a target-set printing already covered them (see the file header).
  for (const [key, value] of Object.entries(sourceCards)) {
    const card = value as DraftCardLike;
    if (typeof card.name === 'string' && BASIC_LAND_NAMES.includes(card.name)) keptKeys.add(key);
  }

  const keptCards = Object.entries(sourceCards).filter(([key]) => keptKeys.has(key));
  const keptAliases = Object.entries(sourceAliases).filter(([, value]) => typeof value === 'string' && keptKeys.has(value));

  const out: CatalogFile = {
    cards: sortedObject(keptCards),
    aliases: sortedObject(keptAliases),
    printings: sortedObject([...keptPrintings.entries()]),
  };

  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  const bytes = Buffer.byteLength(JSON.stringify(out));
  console.log(`${outPath}: ${keptCards.length} cards, ${keptAliases.length} aliases, ${keptPrintings.size} printings, ~${(bytes / 1024).toFixed(0)} KiB`);
}

main();
