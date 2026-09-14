/*
 * Turn a real cube list into a draft pool the browser can hold.
 *
 *   pnpm --filter @hadoku/carddata build-pool
 *   pnpm --filter @hadoku/carddata build-pool -- --cube="MTGO Vintage Cube 2025-12.dck"
 *
 * The UI is a browser SPA: it cannot read `cards.jsonl`, run the resolver, or
 * touch the filesystem at all. So a pool is resolved HERE, at build time, and
 * written as JSON the app imports — which is also the shape it will arrive in
 * over a wire later, so nothing about the UI changes when a server appears.
 *
 * **Gameplay text only, never images (D13).** The projection this reads from
 * has no image code path, and the writer below names every field it emits, so a
 * field cannot arrive by accident. Card names and Oracle text are the same
 * class of data the cube lists in `cubes/` already carry; card *images* are the
 * thing this project never touches.
 *
 * Requires a synced cache: `pnpm --filter @hadoku/carddata sync` first.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCube } from '../cubes.ts';
import { buildCardIndex, resolveCard } from '../resolve.ts';
import type { GameplayCard } from '../scryfall/project.ts';

const DEFAULT_CUBE = 'MTGO Vintage Cube 2025-12.dck';

function repoRoot(): string {
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
}

function cachePath(): string {
  return resolve(repoRoot(), 'packages', 'carddata', 'data', 'cards.jsonl');
}

/** The five real colours. Scryfall's `colors` is already exactly this set. */
const COLORS = new Set(['W', 'U', 'B', 'R', 'G']);

/**
 * Split a Scryfall mana cost string into the pip tokens a renderer needs.
 *
 * `"{3}{W}{W}"` -> `['3','W','W']`, `"{X}{R}"` -> `['X','R']`,
 * `"{W/U}"` -> `['W/U']`. Deliberately tokens rather than a rendered string:
 * we draw our own pips (no WotC symbol font, ever) and the renderer needs the
 * pieces.
 */
function manaTokens(cost: string | undefined): string[] {
  if (typeof cost !== 'string' || cost.length === 0) return [];
  return [...cost.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string);
}

function rarityOf(raw: unknown): string {
  const r = typeof raw === 'string' ? raw : 'common';
  return ['common', 'uncommon', 'rare', 'mythic'].includes(r) ? r : 'special';
}

/**
 * Project one resolved card into the engine's `DraftCard`.
 *
 * Every field is named explicitly. A `{...card}` spread here would pull the
 * whole Scryfall record — which is how an image field would reach the browser
 * without anyone deciding to send one.
 */
function toDraftCard(card: GameplayCard, cardId: string): Record<string, unknown> {
  const raw = card as unknown as Record<string, unknown>;
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
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cubeArg = args.find((a) => a.startsWith('--cube='));
  const outArg = args.find((a) => a.startsWith('--out='));
  const cubeFile = cubeArg ? cubeArg.slice('--cube='.length) : DEFAULT_CUBE;
  const outPath = outArg
    ? resolve(outArg.slice('--out='.length))
    : resolve(repoRoot(), 'apps', 'ui', 'src', 'draft', 'pool.json');

  let raw: string;
  try {
    raw = await readFile(cachePath(), 'utf8');
  } catch {
    console.error(
      `No card cache at ${cachePath()}.\nRun: pnpm --filter @hadoku/carddata sync`,
    );
    process.exit(1);
    return;
  }

  const cards: GameplayCard[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    cards.push(JSON.parse(line) as GameplayCard);
  }
  const index = buildCardIndex(cards);

  const cube = await loadCube(cubeFile);
  const entries = cube.sections.get('main') ?? [];

  const pool: Array<Record<string, unknown>> = [];
  const unresolved: string[] = [];
  let n = 0;

  for (const entry of entries) {
    for (let copy = 0; copy < entry.count; copy++) {
      const resolution = resolveCard(entry.card, index);
      if (resolution.ok) {
        pool.push(toDraftCard(resolution.card, `c${n}`));
      } else {
        unresolved.push(`${entry.card.name}${entry.card.set ? `|${entry.card.set}` : ''}`);
      }
      n++;
    }
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    `${JSON.stringify({ cube: cube.name ?? cubeFile, size: pool.length, cards: pool }, null, 1)}\n`,
    'utf8',
  );

  console.log(`${cube.name ?? cubeFile}: resolved ${pool.length}/${n} -> ${outPath}`);
  if (unresolved.length > 0) {
    console.log(`unresolved (${unresolved.length}): ${unresolved.slice(0, 10).join(', ')}`);
  }

  // The control that matters: no image data may reach the browser bundle.
  //
  // It checks FIELD NAMES and URL-shaped VALUES, never free text. Scanning text
  // is what a first cut did, and it fired immediately — on `Mirror Image`,
  // `Phantasmal Image`, `Imagecrafter`, and `Nissa's Pilgrimage`, where "image"
  // is a substring of a real card name. A control that cries wolf on legitimate
  // gameplay data gets switched off, which is worse than not having one.
  const IMAGE_FIELD = /image|img|artcrop|thumbnail|picture/i;
  const IMAGE_URL = /https?:\/\/[^"]*(\.(jpe?g|png|webp|gif)|scryfall\.io)/i;
  for (const card of pool) {
    for (const [key, value] of Object.entries(card)) {
      if (IMAGE_FIELD.test(key)) {
        console.error(`D13 VIOLATION: field "${key}" on ${String(card.name)}. Refusing to ship it.`);
        process.exit(1);
      }
      if (typeof value === 'string' && IMAGE_URL.test(value)) {
        console.error(`D13 VIOLATION: image URL in "${key}" on ${String(card.name)}. Refusing to ship it.`);
        process.exit(1);
      }
    }
  }
  console.log(`D13 control: ${pool.length} cards, no image field and no image URL.`);
}

await main();
