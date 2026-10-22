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
import { cardColors, toDraftCard } from '../draft-card.ts';
import { buildCardIndex, resolveCard } from '../resolve.ts';
import type { GameplayCard } from '../scryfall/project.ts';

// Re-exported for `build-pool.test.ts`, which pins the Jace / Fire // Ice
// colour fix directly — `cardColors` itself now lives in `../draft-card.ts`
// (shared with `build-catalog.ts`; wave 73 §C follow-up 2), not here.
export { cardColors };

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

/**
 * A cube's name is its `.dck` FILE STEM, never the file's own `Name=` field.
 *
 * One rule, no special case: the metadata can lie (`The Pauper Cube
 * 2026-02.dck`'s `Name=` reads "The Pauper Deck 2026-02", a Forge upstream
 * typo — operator, 2026-10-22), and the filename is already the identifier
 * every other list in this repo (the Settled shortlist, the cube picker)
 * names it by. Resolving the file still uses `loadCube`'s own parse; only
 * the DISPLAY name is overridden, here, once.
 */
export function stemOf(fileName: string): string {
  return fileName.endsWith('.dck') ? fileName.slice(0, -'.dck'.length) : fileName;
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

  return { name: stemOf(cubeFile), pool, unresolved, total: n };
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
      // Loud, and never truncated: a dropped card is a silent regression the
      // next time someone drafts this cube unless the count AND every name is
      // right here, on stderr, every build. Never refused for this — the
      // operator's own finding (2026-10-22): "do NOT refuse the cube and do
      // NOT patch around it". A sync older than a card's set is the usual
      // cause, not a bug in this CLI.
      console.error(`UNRESOLVED (${unresolved.length}) in ${name}: ${unresolved.join(', ')}`);
    }
    console.log(`D13 control: ${pool.length} cards, no image field and no image URL.`);
  }
}

// Guarded so this file's exports (`slug`, `stemOf`, and the re-exported
// `cardColors`) can be imported by a unit test without running the whole
// CLI — `build-pool.test.ts` does exactly that. `import.meta.main` is Node's
// own answer to "is this the entry script", true only when
// `node … build-pool.ts` ran this file directly.
if (import.meta.main) await main();
