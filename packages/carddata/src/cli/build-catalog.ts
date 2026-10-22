/*
 * Build the compact card catalog: one `DraftCard` per known card name (plus a
 * default `scryfallId`), for any source that hands the server a bare name and
 * needs full gameplay text back — a Cube Cobra import (`cubecobra.ts` keeps
 * only `name` + `scryfall_id`, never oracle text) or a set-cube source
 * (wave 74, names only).
 *
 *   pnpm --filter @hadoku/carddata build-catalog
 *   pnpm --filter @hadoku/carddata build-catalog -- --data=/path/to/carddata/data --out=/path/to/cards.json
 *
 * Requires a synced cache: `pnpm --filter @hadoku/carddata sync` first, or
 * `--data=` pointed at one that already exists (read-only; this never writes
 * there).
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
 * `../draft-card.ts` and both CLIs import them — wave 73 §C follow-up 2
 * deleted the two copies this file and `build-pool.ts` used to carry. That
 * is also where the colour fix lives: before it, this file's own copy of the
 * projection read a card's colour straight off `colors`, which Scryfall
 * leaves `null` for `transform`/`modal_dfc` layouts — so a name like Jace,
 * Vryn's Prodigy came out of this catalog colourless (`[]`) while
 * `build-pool.ts`'s cubes already had the fix. `cardColors` falls back to
 * the front face's (or, for split/adventure/flip/meld, every face's union —
 * Fire // Ice is `['R','U']`) exactly as `build-pool.ts`'s cubes do.
 *
 * No image code path (D13): every field this writes is named explicitly, and
 * the control at the bottom of `main` refuses to write a catalog carrying an
 * image field or an image-shaped URL, exactly as `build-pool.ts`'s does.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { toDraftCard } from '../draft-card.ts';
import { buildCardIndex, normaliseName, type CardIndex } from '../resolve.ts';
import type { GameplayCard } from '../scryfall/project.ts';

function repoRoot(): string {
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
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

export interface CatalogFile {
  cards: Record<string, unknown>;
  aliases: Record<string, string>;
}

/**
 * Walk the index's own ranked buckets (the join) and split each key into
 * either a canonical entry (the key IS the card's own top-level name) or an
 * alias (the key reached the card through a weaker variant). See the file
 * header for why this is the whole algorithm.
 */
export function buildCatalog(index: CardIndex): CatalogFile {
  const cards: Record<string, unknown> = {};
  const aliases: Record<string, string> = {};

  for (const [key, bucket] of index.byName) {
    if (bucket.length === 0) continue;
    const paper = bucket.find((entry) => !isDigital(entry.card));
    const best = paper ?? bucket[0];
    if (best === undefined) continue;
    const canonicalKey = normaliseName(String((best.card as Record<string, unknown>).name ?? ''));
    if (key === canonicalKey) {
      cards[key] = toDraftCard(best.card, key);
    } else if (!(key in aliases)) {
      aliases[key] = canonicalKey;
    }
  }

  return { cards, aliases };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dataArg = args.find((a) => a.startsWith('--data='));
  const outArg = args.find((a) => a.startsWith('--out='));
  const dataDir = dataArg ? resolve(dataArg.slice('--data='.length)) : defaultDataDir();
  const outPath = outArg ? resolve(outArg.slice('--out='.length)) : resolve(process.env.CARDTABLE_CATALOG ?? defaultOutPath());

  const cachePath = resolve(dataDir, 'cards.jsonl');
  let raw: string;
  try {
    raw = await readFile(cachePath, 'utf8');
  } catch {
    console.error(`No card cache at ${cachePath}.\nRun: pnpm --filter @hadoku/carddata sync (or pass --data=)`);
    process.exit(1);
    return;
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
  console.log(`catalog: ${cardCount} cards, ${aliasCount} aliases, from ${index.printings} printings -> ${outPath}`);

  // The control that matters: no image data may reach a payload built from
  // this file. Same discipline as `build-pool.ts`'s control, and the same
  // reason it scans field NAMES and URL-shaped VALUES rather than free text
  // (a card named "Mirror Image" or "Phantasmal Image" must not trip it).
  const IMAGE_FIELD = /image|img|artcrop|thumbnail|picture/i;
  const IMAGE_URL = /https?:\/\/[^"]*(\.(jpe?g|png|webp|gif)|scryfall\.io)/i;
  for (const card of Object.values(catalog.cards)) {
    for (const [key, value] of Object.entries(card as Record<string, unknown>)) {
      if (IMAGE_FIELD.test(key)) {
        console.error(`D13 VIOLATION: field "${key}" on ${String((card as Record<string, unknown>).name)}. Refusing to write it.`);
        process.exit(1);
      }
      if (typeof value === 'string' && IMAGE_URL.test(value)) {
        console.error(`D13 VIOLATION: image URL in "${key}" on ${String((card as Record<string, unknown>).name)}. Refusing to write it.`);
        process.exit(1);
      }
    }
  }
  console.log(`D13 control: ${cardCount} cards, no image field and no image URL.`);
}

// Guarded so `buildCatalog` can be imported by a unit test without running
// the whole CLI — `build-catalog.test.ts` does exactly that. Same guard
// `build-pool.ts` uses; see its tail comment for why `import.meta.main` is
// the right check.
if (import.meta.main) await main();
