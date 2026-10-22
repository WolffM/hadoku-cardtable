/*
 * Turn a real cube list into a draft pool the browser can hold — or several,
 * for the server's own shortlist (`docs/planning/wave73-2026-10-21.md` §A
 * step 4).
 *
 *   pnpm --filter @hadoku/carddata build-pool
 *   pnpm --filter @hadoku/carddata build-pool -- --cube="MTGO Vintage Cube 2025-12.dck"
 *
 *   # the 8-cube shortlist, written as apps/server/pools/cubes/<stem>.json:
 *   pnpm --filter @hadoku/carddata build-pool -- \
 *     --cube="MTGO Vintage Cube 2025-12.dck" --cube="MTGO Legacy Cube 2021-08.dck" … \
 *     --out-dir=../../apps/server/pools/cubes \
 *     --data=/path/to/packages/carddata/data
 *
 * `--cube=` may repeat; each one is resolved and written separately to
 * `--out-dir=` (one file per cube, named by `slug()` below) rather than all
 * to the single `--out=` path, which only ever held one cube. `--data=`
 * overrides where `cards.jsonl` is read from — a worktree checked out without
 * the gitignored Scryfall bulk cache points it at a checkout that has one
 * (read-only; this CLI never writes there).
 *
 * The UI is a browser SPA: it cannot read `cards.jsonl`, run the resolver, or
 * touch the filesystem at all. So a pool is resolved HERE, at build time, and
 * written as JSON the app imports — which is also the shape it will arrive in
 * over a wire later, so nothing about the UI changes when a server appears.
 * The server's shortlist files are the SAME shape (`{cube,size,cards}`), read
 * by the same `loadPool` the UI's bundled file always used
 * (`apps/server/src/room/pool.ts`).
 *
 * **A pool is gameplay text only — and that is now a separation, not a ban.**
 * The projection this reads from has no image field, and the writer below names
 * every field it emits, so one cannot arrive by accident. The control at the
 * bottom of this file enforces it at runtime on every build.
 *
 * What changed is why. D13 said this project never touches card images at all;
 * D15 (2026-09-15, `docs/DECISIONS.md`) repealed that clause, and we now host
 * card art on `cdn.hadoku.me` — see `../cli/upload-art.ts` and `../art/`.
 * A pool still carries none of it, deliberately:
 *
 *   pool.json          gameplay text + scryfallId, regenerated wholesale HERE
 *   art-manifest.json  scryfallId -> { source, key }, hand-curated, never
 *                      written by this CLI
 *
 * That split exists precisely because this file rewrites its output from
 * scratch. Art assignments are curated one card at a time and may be repointed
 * at a non-WotC source later; if they lived in the pool, the next `build-pool`
 * would silently discard them. So if you are here to add art to a pool: don't.
 * Add a row to the manifest, or run `upload-art`, which writes one for you.
 *
 * The `scryfallId` this emits is the join key between the two files, and it is
 * an id — never a URL. That distinction is what the control below checks.
 *
 * Requires a synced cache: `pnpm --filter @hadoku/carddata sync` first.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCube } from '../cubes.ts';
import { otherFaces } from '../faces.ts';
import { buildCardIndex, resolveCard } from '../resolve.ts';
import type { GameplayCard } from '../scryfall/project.ts';

const DEFAULT_CUBE = 'MTGO Vintage Cube 2025-12.dck';

function repoRoot(): string {
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
}

function cachePath(dataDir?: string): string {
  return resolve(dataDir ?? resolve(repoRoot(), 'packages', 'carddata', 'data'), 'cards.jsonl');
}

/**
 * A cube's display name, turned into a filename stem and a `CubeSummary.id`
 * (`packages/shared/src/pool.ts`'s wire contract: "shortlist: file stem").
 * Lower-cased, every run of non-alphanumerics collapsed to one hyphen, no
 * leading/trailing hyphen — `"Ryan Overturf's Grixis Cube (MTGO)"` becomes
 * `"ryan-overturfs-grixis-cube-mtgo"`.
 */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The five real colours. Scryfall's `colors` is already exactly this set. */
const COLORS = new Set(['W', 'U', 'B', 'R', 'G']);

function filterColors(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string' && COLORS.has(c)) : [];
}

/**
 * Split/adventure/flip/meld already carry a card-level colour; every other
 * record that has one also means it (checked against `colors=== null` is
 * never half-populated the other way in the data).
 */
const UNION_FACES_LAYOUTS = new Set(['split', 'adventure', 'flip', 'meld']);

/**
 * One card's real colour — the class fix for a gap live in the shipped pool
 * (the operator: Jace, Vryn's Prodigy showed colourless).
 *
 * Scryfall's CARD-level `colors` is `null` for `transform`/`modal_dfc` (and
 * `art_series`/`double_faced_token`/`reversible_card`, none of them real
 * draftable cards) — confirmed against `cards.jsonl`: every `colors === null`
 * record is one of those five layouts, and no other. The colour lives on
 * each face instead.
 *
 * - `split`/`adventure`/`flip`/`meld`: both halves are one card, so the
 *   colour is the UNION of every face's own. (In practice Scryfall already
 *   gives these a card-level `colors`, so this branch is a correctness net
 *   for data that varies — not the common path — rather than load-bearing
 *   today.)
 * - Everything else with faces (`transform`, `modal_dfc`, …): the FRONT
 *   face's colour is the card's own, same rule `manaCost`/`typeLine`/
 *   `oracleText` below already use when the card-level field is absent.
 */
export function cardColors(raw: { colors?: unknown; layout?: unknown; card_faces?: unknown }): string[] {
  if (Array.isArray(raw.colors)) return filterColors(raw.colors);
  const faces = Array.isArray(raw.card_faces) ? (raw.card_faces as Array<{ colors?: unknown }>) : [];
  if (faces.length === 0) return [];
  const layout = typeof raw.layout === 'string' ? raw.layout : '';
  if (UNION_FACES_LAYOUTS.has(layout)) {
    return [...new Set(filterColors(faces.flatMap((f) => (Array.isArray(f.colors) ? f.colors : []))))];
  }
  return filterColors(faces[0]?.colors);
}

/**
 * Split a Scryfall mana cost string into the pip tokens a renderer needs.
 *
 * `"{3}{W}{W}"` -> `['3','W','W']`, `"{X}{R}"` -> `['X','R']`,
 * `"{W/U}"` -> `['W/U']`. Deliberately tokens rather than a rendered string:
 * the renderer needs the pieces. `apps/ui/src/components/ManaPip.tsx` turns one
 * token into one symbol, and a hybrid into Mana's two-half split — which is a
 * class per PART, so a pre-rendered `{W/U}` would have to be taken apart again.
 *
 * This used to read "we draw our own pips (no WotC symbol font, ever)". D20
 * (operator, 2026-09-27) repealed the drawing half: the symbols are Keyrune's
 * and Mana's now, third-party fonts and never WotC's own files
 * (`docs/LICENSING.md` §3.2). The token list is unaffected, and the reason for
 * it never depended on who drew the glyph.
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

  const colors = cardColors(raw);

  const out: Record<string, unknown> = {
    cardId,
    // Scryfall's id, so the BROWSER can derive an image URL. Not a URL, and not
    // their `image_uris` blob — see the D13 note in the header, and
    // apps/ui/src/draft/cardImage.ts for the only place it becomes a URL.
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

/**
 * The card's other faces, printed as the card is (`DraftCard.faces`): each face's own text from its
 * `card_faces` entry, and the art `otherFaces` says it draws — Etali, Primal Sickness its own back
 * image. A face Scryfall prints no entry for (a meld result, a card of its own) is left out: a face
 * with no text and a borrowed set line is not one this pool can print.
 */
function faceCards(card: GameplayCard, front: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = card as unknown as Record<string, unknown>;
  const printed = Array.isArray(raw.card_faces) ? (raw.card_faces as Array<Record<string, unknown>>) : [];
  return otherFaces(card).flatMap(({ name, artId }) => {
    const face = printed.find((f) => f.name === name);
    if (face === undefined) return [];
    const colors = filterColors(face.colors);
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

/**
 * The control that matters: no image data may reach the browser bundle, nor
 * the server's own shortlist files, which are committed the same as the UI's
 * bundled pool was.
 *
 * It checks FIELD NAMES and URL-shaped VALUES, never free text. Scanning text
 * is what a first cut did, and it fired immediately — on `Mirror Image`,
 * `Phantasmal Image`, `Imagecrafter`, and `Nissa's Pilgrimage`, where "image"
 * is a substring of a real card name. A control that cries wolf on legitimate
 * gameplay data gets switched off, which is worse than not having one.
 * The pool is data we COMMIT, so it must carry no image URL and no image
 * field — only the id. An art URL is composed at render time from the id plus
 * the manifest (`../art/`), which is what makes repointing a card a one-line
 * data edit instead of a pool rebuild (D15, docs/DECISIONS.md). A URL baked in
 * here would freeze every card to whatever source was current on the day the
 * pool was built — which, now that the art source is expected to move, is a
 * sharper reason for this control than the one it was written with.
 */
function assertNoImageData(pool: Array<Record<string, unknown>>): void {
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
}

/** Resolve one cube file against the card index, returning its pool plus the names that did not resolve. */
async function buildOne(
  cubeFile: string,
  index: ReturnType<typeof buildCardIndex>,
): Promise<{ name: string; pool: Array<Record<string, unknown>>; unresolved: string[]; total: number }> {
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

  return { name: cube.name ?? cubeFile, pool, unresolved, total: n };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cubeArgs = args.filter((a) => a.startsWith('--cube=')).map((a) => a.slice('--cube='.length));
  const outArg = args.find((a) => a.startsWith('--out='));
  const outDirArg = args.find((a) => a.startsWith('--out-dir='));
  const dataArg = args.find((a) => a.startsWith('--data='));
  const cubeFiles = cubeArgs.length > 0 ? cubeArgs : [DEFAULT_CUBE];
  const dataDir = dataArg ? resolve(dataArg.slice('--data='.length)) : undefined;

  if (outDirArg !== undefined && outArg !== undefined) {
    console.error('--out and --out-dir are mutually exclusive: --out names one file, --out-dir names several.');
    process.exit(1);
    return;
  }

  let raw: string;
  try {
    raw = await readFile(cachePath(dataDir), 'utf8');
  } catch {
    console.error(
      `No card cache at ${cachePath(dataDir)}.\nRun: pnpm --filter @hadoku/carddata sync (or pass --data=<dir with cards.jsonl>).`,
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

  for (const cubeFile of cubeFiles) {
    const { name, pool, unresolved, total } = await buildOne(cubeFile, index);
    assertNoImageData(pool);

    const outPath =
      outDirArg !== undefined
        ? resolve(outDirArg.slice('--out-dir='.length), `${slug(name)}.json`)
        : outArg !== undefined
          ? resolve(outArg.slice('--out='.length))
          : resolve(repoRoot(), 'apps', 'ui', 'src', 'draft', 'pool.json');

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify({ cube: name, size: pool.length, cards: pool }, null, 1)}\n`, 'utf8');

    console.log(`${name}: resolved ${pool.length}/${total} -> ${outPath}`);
    if (unresolved.length > 0) {
      console.log(`unresolved (${unresolved.length}): ${unresolved.slice(0, 10).join(', ')}`);
    }
    console.log(`D13 control: ${pool.length} cards, no image field and no image URL.`);
  }
}

// Guarded so `cardColors` (and the rest of this file's helpers) can be
// imported by a unit test without running the whole CLI — `build-pool.test.ts`
// does exactly that. `import.meta.main` is Node's own answer to "is this the
// entry script", true only when `node … build-pool.ts` ran this file directly.
if (import.meta.main) await main();
