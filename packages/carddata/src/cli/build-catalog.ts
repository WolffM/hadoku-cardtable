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
 * ## Why the projection below is NOT imported from `build-pool.ts`
 *
 * `build-pool.ts`'s `toDraftCard`/`faceCards`/`manaTokens`/`rarityOf` do
 * exactly this projection already, but that file belongs to another wave-73
 * lane this wave (lane A) and this lane may not edit it. The functions below
 * are deliberately small and stateless copies — a later pass should extract
 * one shared projection both CLIs call; nothing here depends on the
 * duplication staying.
 *
 * No image code path (D13): every field this writes is named explicitly, and
 * the control at the bottom of `main` refuses to write a catalog carrying an
 * image field or an image-shaped URL, exactly as `build-pool.ts`'s does.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { otherFaces } from '../faces.ts';
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

/** The five real colours. Scryfall's `colors` is already exactly this set. */
const COLORS = new Set(['W', 'U', 'B', 'R', 'G']);

/** Mirrors `build-pool.ts`'s `manaTokens` — see its header for why tokens, not a rendered string. */
function manaTokens(cost: string | undefined): string[] {
  if (typeof cost !== 'string' || cost.length === 0) return [];
  return [...cost.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string);
}

function rarityOf(raw: unknown): string {
  const r = typeof raw === 'string' ? raw : 'common';
  return ['common', 'uncommon', 'rare', 'mythic'].includes(r) ? r : 'special';
}

function isDigital(card: GameplayCard): boolean {
  return (card as Record<string, unknown>)['digital'] === true;
}

/** Mirrors `build-pool.ts`'s `toDraftCard`. Every field is named explicitly — never a `{...card}` spread. */
function toDraftCard(card: GameplayCard, cardId: string): Record<string, unknown> {
  const raw = card as Record<string, unknown>;
  const faces = Array.isArray(raw.card_faces) ? (raw.card_faces as Array<Record<string, unknown>>) : null;
  const front = faces?.[0];

  const manaCost = manaTokens(
    (typeof raw.mana_cost === 'string' && raw.mana_cost.length > 0
      ? raw.mana_cost
      : typeof front?.mana_cost === 'string'
        ? front.mana_cost
        : '') as string,
  );

  const colors = Array.isArray(raw.colors)
    ? (raw.colors as unknown[]).filter((c): c is string => typeof c === 'string' && COLORS.has(c))
    : [];

  const out: Record<string, unknown> = {
    cardId,
    // Scryfall's id, so the BROWSER can derive an image URL for itself. Not a
    // URL, and not their `image_uris` blob — see `build-pool.ts`'s header.
    ...(typeof raw.id === 'string' ? { scryfallId: raw.id } : {}),
    name: String(raw.name ?? front?.name ?? 'Unknown'),
    manaCost,
    manaValue: typeof raw.cmc === 'number' ? raw.cmc : 0,
    colors,
    typeLine: String(raw.type_line ?? front?.type_line ?? ''),
    oracleText: String(raw.oracle_text ?? front?.oracle_text ?? ''),
    setCode: String(raw.set ?? '???').toUpperCase(),
    collectorNumber: String(raw.collector_number ?? '0'),
    rarity: rarityOf(raw.rarity),
  };
  if (typeof raw.power === 'string') out.power = raw.power;
  if (typeof raw.toughness === 'string') out.toughness = raw.toughness;
  if (typeof raw.loyalty === 'string') out.loyalty = raw.loyalty;
  const others = faceCards(card, out);
  if (others.length > 0) out.faces = others;
  return out;
}

/** Mirrors `build-pool.ts`'s `faceCards` — see its header for the Etali / meld-result caveat. */
function faceCards(card: GameplayCard, front: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = card as Record<string, unknown>;
  const printed = Array.isArray(raw.card_faces) ? (raw.card_faces as Array<Record<string, unknown>>) : [];
  return otherFaces(card).flatMap(({ name, artId }) => {
    const face = printed.find((f) => f.name === name);
    if (face === undefined) return [];
    const colors = Array.isArray(face.colors) ? (face.colors as unknown[]).filter((c): c is string => typeof c === 'string' && COLORS.has(c)) : [];
    const manaCost = manaTokens(typeof face.mana_cost === 'string' ? face.mana_cost : '');
    const out: Record<string, unknown> = {
      scryfallId: artId,
      name,
      manaCost,
      manaValue: typeof face.cmc === 'number' ? face.cmc : manaCost.reduce((n, t) => n + (/^\d+$/.test(t) ? Number(t) : t === 'X' ? 0 : 1), 0),
      colors,
      typeLine: String(face.type_line ?? ''),
      oracleText: String(face.oracle_text ?? ''),
      setCode: front.setCode,
      collectorNumber: front.collectorNumber,
      rarity: front.rarity,
    };
    if (typeof face.power === 'string') out.power = face.power;
    if (typeof face.toughness === 'string') out.toughness = face.toughness;
    if (typeof face.loyalty === 'string') out.loyalty = face.loyalty;
    return [out];
  });
}

interface CatalogFile {
  cards: Record<string, unknown>;
  aliases: Record<string, string>;
}

/**
 * Walk the index's own ranked buckets (the join) and split each key into
 * either a canonical entry (the key IS the card's own top-level name) or an
 * alias (the key reached the card through a weaker variant). See the file
 * header for why this is the whole algorithm.
 */
function buildCatalog(index: CardIndex): CatalogFile {
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

await main();
