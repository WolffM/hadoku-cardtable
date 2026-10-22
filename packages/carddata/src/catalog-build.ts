/*
 * Build the compact card catalog: one `DraftCard` per known card name (plus a
 * default `scryfallId`), for any source that hands the server a bare name and
 * needs full gameplay text back — a Cube Cobra import (`cubecobra.ts` keeps
 * only `name` + `scryfall_id`, never oracle text) or a set-cube source
 * (wave 74, names only).
 *
 * This is the LIBRARY half. `cli/build-catalog.ts` is the thin CLI wrapper
 * (argv parsing, console output, the `pnpm build-catalog` entry point) —
 * everything here is a plain function with no top-level side effect, safe to
 * import from `index.ts` and therefore safe to end up inside the SERVER's
 * bundle (`apps/server/src/pools/refresh.ts` calls `runBuildCatalog`
 * in-process to rebuild without shelling out).
 *
 * ## Why this is its own file and not still under `cli/` (incident, 2026-10-22)
 *
 * `index.ts` re-exported `runBuildCatalog` straight from `cli/build-catalog.ts`,
 * which ends in `if (import.meta.main) await main();`. That guard is fine for
 * every DIRECT CLI invocation (`node cli/build-catalog.ts`), because
 * `import.meta.main` compares `import.meta.url` to the process's own entry
 * module. It breaks the moment the file is BUNDLED: `apps/server`'s build
 * inlines every imported module into one file (`dist/index.js`), so every
 * inlined module's `import.meta.url` becomes the SAME url — the bundle's own
 * entry — and `import.meta.main` reads `true` for all of them. The server's
 * boot (which imports `catalog.ts`/`refresh.ts`, which import this package's
 * index, which re-exported `cli/build-catalog.ts`) ran `build-catalog`'s
 * whole CLI `main()` on every restart, and `cli/sync-cards.ts`'s too (the
 * same re-export mistake) — a full Scryfall sync into the deploy tree AND a
 * catalog rebuild, every time the process started. On a cache-less host
 * (fresh e2e checkout) that crashed the boot outright with "No card cache",
 * which is how `forge.yml` caught it before a worse one did.
 *
 * The fix is structural, not a guard: NOTHING with a top-level
 * `import.meta.main` branch may be reachable from `index.ts`, ever again.
 * `index-no-cli-imports.test.ts` enforces that by reading the import graph,
 * not by trusting a comment.
 *
 * ## Reusing `resolve.ts`'s join, not writing a second one
 *
 * `resolve.ts`'s `buildCardIndex` already computes, for every card, every
 * spelling it answers to (`nameKeysFor`: the card's own name, its front face
 * for a two-faced card, and both folded) ranked best-first — that ranking IS
 * the join `resolveCard` walks for a cube's bare-name references. This file
 * does not re-derive any of that. It only decides, for each key the join
 * already produced, whether that key is a card's OWN top-level name
 * (canonical: the full card is stored under it) or reached the card through a
 * weaker variant (alias: the key points at the canonical one instead of
 * duplicating the card). `apps/server/src/pools/catalog.ts`'s `byName` then
 * tries exactly the two keys `resolve.ts`'s own `requestKeys` tries — nothing
 * about the fold or the ranking is reimplemented there either.
 *
 * Within a bucket, a paper printing is preferred over a digital-only one
 * (same preference `resolveCard`'s tier 3 applies), so a name resolved here
 * and the same name resolved through a cube's `.dck` reference land on the
 * same printing.
 *
 * ## The projection is shared with `build-pool.ts`
 *
 * `toDraftCard`/`faceCards`/`manaTokens`/`rarityOf`/`cardColors` live in
 * `./draft-card.ts` and both CLIs import them — wave 73 §C follow-up 2
 * deleted the two copies this file and `build-pool.ts` used to carry.
 *
 * No image code path (D13): every field this writes is named explicitly, and
 * `runBuildCatalog`'s own control refuses to return a catalog carrying an
 * image field or an image-shaped URL, exactly as `build-pool.ts`'s does.
 *
 * ## `printings` (wave 74 §G)
 *
 * `buildCatalog`'s SECOND output, alongside `cards`/`aliases`: for a
 * canonical key, every entry in that SAME bucket with a rank-0 match (its
 * own exact full name, not some other card's folded/front-face collision
 * landing in the same bucket string) is another printing of the chosen
 * card — a reprint, a digital-only edition, whatever `cards.jsonl` carries —
 * even when it was NOT the one `toDraftCard` was called on.
 * `apps/server/src/pools/catalog.ts`'s `byPrinting(set, collectorNumber)`
 * reads this to answer a specific printing's own `scryfallId` while still
 * serving the canonical card's text, which is the entire reason it exists
 * (wave 74 §E: a realistic booster's pack should draw the SET'S OWN art, not
 * whatever printing this catalog happened to pick as its one text entry).
 * `cards`/`aliases` are unchanged by this — same keys, same values.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { toDraftCard } from './draft-card.ts';
import { buildCardIndex, normaliseName, type CardIndex } from './resolve.ts';
import type { GameplayCard } from './scryfall/project.ts';

function repoRoot(): string {
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
}

function defaultDataDir(): string {
  return resolve(repoRoot(), 'packages', 'carddata', 'data');
}

function defaultOutPath(): string {
  return resolve(homedir(), '.local', 'share', 'cardtable', 'catalog', 'cards.json');
}

function isDigital(card: GameplayCard): boolean {
  return (card as Record<string, unknown>)['digital'] === true;
}

/** One printing's own art, by `<SET>:<collector_number>` — see this file's header. */
export interface PrintingRef {
  /** The canonical key this printing's card is stored under in `cards`. */
  key: string;
  /** This SPECIFIC printing's own id — not the chosen printing's. Absent only if Scryfall ever omits one. */
  scryfallId?: string;
}

export interface CatalogFile {
  cards: Record<string, unknown>;
  aliases: Record<string, string>;
  /** Every printing read, keyed `<SET>:<collector_number>` — not only the one chosen for `cards`. */
  printings: Record<string, PrintingRef>;
}

/**
 * Walk the index's own ranked buckets (the join) and split each key into
 * either a canonical entry (the key IS the card's own top-level name) or an
 * alias (the key reached the card through a weaker variant). See the file
 * header for why this is the whole algorithm, and for `printings`.
 */
export function buildCatalog(index: CardIndex): CatalogFile {
  const cards: Record<string, unknown> = {};
  const aliases: Record<string, string> = {};
  const printings: Record<string, PrintingRef> = {};

  for (const [key, bucket] of index.byName) {
    if (bucket.length === 0) continue;
    const paper = bucket.find((entry) => !isDigital(entry.card));
    const best = paper ?? bucket[0];
    if (best === undefined) continue;
    const canonicalKey = normaliseName(String((best.card as Record<string, unknown>).name ?? ''));
    if (key === canonicalKey) {
      cards[key] = toDraftCard(best.card, key);
      for (const entry of bucket) {
        if (entry.rank !== 0) continue; // this card's own exact name, not a same-string collision from a different card
        const raw = entry.card as Record<string, unknown>;
        const set = typeof raw.set === 'string' ? raw.set : null;
        const collector = typeof raw.collector_number === 'string' ? raw.collector_number : null;
        if (set === null || collector === null) continue;
        const printingKey = `${set.toUpperCase()}:${collector}`;
        if (printingKey in printings) continue; // first one wins; two cards sharing a set+collector number should not happen
        printings[printingKey] = typeof raw.id === 'string' ? { key, scryfallId: raw.id } : { key };
      }
    } else if (!(key in aliases)) {
      aliases[key] = canonicalKey;
    }
  }

  return { cards, aliases, printings };
}

export interface RunBuildCatalogOptions {
  readonly dataDir?: string;
  readonly outPath?: string;
}

export interface RunBuildCatalogResult {
  readonly outPath: string;
  readonly cardCount: number;
  readonly aliasCount: number;
  readonly printings: number;
}

/**
 * Read `<dataDir>/cards.jsonl`, build the catalog, write it to `outPath`, and
 * run the D13 image control — the whole CLI minus argv parsing and console
 * output. Throws (never `process.exit`s) on a missing cache or a D13
 * violation, so a caller running this in-process — `cli/build-catalog.ts`'s
 * `main`, or the server's refresh job — decides what to do about the
 * failure instead of the process dying under it.
 *
 * No top-level side effect, nothing reads `process.argv` — this is the whole
 * reason it is safe to be part of `index.ts`'s export surface and therefore
 * the server's bundle. See this file's header for the incident that made
 * that distinction load-bearing.
 */
export async function runBuildCatalog(options: RunBuildCatalogOptions = {}): Promise<RunBuildCatalogResult> {
  const dataDir = options.dataDir ?? defaultDataDir();
  const outPath = options.outPath ?? resolve(process.env.CARDTABLE_CATALOG ?? defaultOutPath());

  const cachePath = resolve(dataDir, 'cards.jsonl');
  let raw: string;
  try {
    raw = await readFile(cachePath, 'utf8');
  } catch {
    throw new Error(`No card cache at ${cachePath}.\nRun: pnpm --filter @hadoku/carddata sync (or pass --data=)`);
  }

  const cards: GameplayCard[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    cards.push(JSON.parse(line) as GameplayCard);
  }
  const index = buildCardIndex(cards);
  const catalog = buildCatalog(index);

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(catalog)}\n`, 'utf8');

  const cardCount = Object.keys(catalog.cards).length;
  const aliasCount = Object.keys(catalog.aliases).length;

  // The control that matters: no image data may reach a payload built from
  // this file. Same discipline as `build-pool.ts`'s control, and the same
  // reason it scans field NAMES and URL-shaped VALUES rather than free text
  // (a card named "Mirror Image" or "Phantasmal Image" must not trip it).
  const IMAGE_FIELD = /image|img|artcrop|thumbnail|picture/i;
  const IMAGE_URL = /https?:\/\/[^"]*(\.(jpe?g|png|webp|gif)|scryfall\.io)/i;
  for (const card of Object.values(catalog.cards)) {
    for (const [key, value] of Object.entries(card as Record<string, unknown>)) {
      if (IMAGE_FIELD.test(key)) {
        throw new Error(`D13 VIOLATION: field "${key}" on ${String((card as Record<string, unknown>).name)}. Refusing to write it.`);
      }
      if (typeof value === 'string' && IMAGE_URL.test(value)) {
        throw new Error(`D13 VIOLATION: image URL in "${key}" on ${String((card as Record<string, unknown>).name)}. Refusing to write it.`);
      }
    }
  }

  return { outPath, cardCount, aliasCount, printings: index.printings };
}
