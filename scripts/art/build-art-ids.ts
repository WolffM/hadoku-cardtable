/*
 * Build `apps/ui/src/draft/art-ids.json` — the committed `Name|SET → Scryfall id`
 * table the play board looks a card's art up in.
 *
 * ## Regenerate with
 *
 *   pnpm --filter @hadoku/carddata sync            # refresh the Scryfall cache
 *   node --max-old-space-size=6144 scripts/art/build-art-ids.ts
 *
 * That is the whole command. `--cache=<dir>` overrides the cache location
 * (default `packages/carddata/data`, which `.gitignore` refuses) and
 * `--out=<file>` the output. Re-running against the same cache produces the
 * same bytes: every lookup goes through `resolveCard`, whose ordering is total,
 * and the keys are sorted before they are written. Verified by running it twice
 * and comparing SHA-256.
 *
 * A worktree has no cache of its own, and a 78 MB re-download to regenerate a
 * committed file is waste, so point it at one that already exists:
 *
 *   node --max-old-space-size=6144 scripts/art/build-art-ids.ts \
 *     --cache=<any checkout>/packages/carddata/data
 *
 * The committed `art-ids.json` was built that way from `default_cards` as of
 * the `sourceUpdatedAt` its own `note` records.
 *
 * ## Why this file exists
 *
 * Forge's wire carries no Scryfall id. A card crosses as `Name` + `SetCode`
 * (Forge's own set vocabulary — `ImageKey` spells it `c:Mountain|MRD|1`), and
 * `apps/ui/src/play/adapter.ts` has to turn that into an id before
 * `@hadoku/carddata/art` can resolve a URL. Until now the only name → id table
 * in the browser was the cube's own `pool.json`, so **every card a match can
 * contain that is not in the drafted cube had no id and therefore no art** —
 * basic lands above all, which is exactly the blank set the operator hit
 * (wave 19 §D, #9).
 *
 * ## Why committed data rather than a lookup
 *
 * Scryfall's rate-limit guidance is explicit: cache, and use the bulk files for
 * bulk resolution. `packages/carddata/src/scryfall/bulk.ts` already honours
 * that, and this script is a consumer of that cache, not a new caller of their
 * API. Nothing here runs in a browser and nothing here runs at request time.
 *
 * ## What is in the table, and what is deliberately not
 *
 * The output goes into the browser bundle, so scope is a size decision:
 *
 *   - **every basic land, under every Forge set code that names it.** A basic
 *     is the one card where the printing really matters — a match is half
 *     lands, and one generic Forest for all of them reads as broken. 14 basic
 *     names (5 basics, Wastes, 6 snow-covered, 2 joke lands) across every Forge
 *     edition whose Scryfall set has them.
 *   - **every card named by the committed constructed lists** under `decks/`,
 *     under the set that list named. Those are the decks `ConstructedScreen`
 *     offers, so they are cards a match can actually contain.
 *   - **the cube pool's Forge aliases.** `pool.json` already carries all 534
 *     cube ids keyed by their SCRYFALL set code; Forge names 92 of its editions
 *     with a different code, so a cube card printed in one of those misses the
 *     exact key. Those alias rows — and only those — are added here.
 *   - **a bare-name row per card**, which is the documented fallback: another
 *     printing's art is still that card's art.
 *
 * NOT in the table: Forge's 505 bundled quest precons (12,722 distinct
 * `Name|SET` references, ~8,900 distinct names — roughly half a megabyte, for
 * decks the UI never offers), and every other printing of every other card.
 * A whole-corpus table is a performance bug, not thoroughness.
 *
 * ## The one rule this file must not break
 *
 * It emits **ids**. No URL, no host, no `image_uris` blob — a card's art is a
 * lookup, not a URL (D15), and `packages/carddata/src/art/index.ts` is the only
 * thing that decides where the bytes come from. The cache this reads was
 * already projected onto a gameplay allowlist (`scryfall/project.ts`), so there
 * is no image field here to leak even by accident.
 */

import { createReadStream, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDck, type CardRequest } from '../../packages/carddata/src/dck.ts';
import { buildCardIndex, resolveCard, type CardIndex } from '../../packages/carddata/src/resolve.ts';
import { FORGE_TO_SCRYFALL_SET } from '../../packages/carddata/src/set-codes.ts';
import type { GameplayCard } from '../../packages/carddata/src/scryfall/project.ts';
import { ART_ID_TABLE_VERSION } from '../../packages/carddata/src/art/ids.ts';

const REPO_ROOT = resolvePath(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const DEFAULT_CACHE = join(REPO_ROOT, 'packages', 'carddata', 'data');
const DEFAULT_OUT = join(REPO_ROOT, 'apps', 'ui', 'src', 'draft', 'art-ids.json');
const DECKS_DIR = join(REPO_ROOT, 'decks');
const POOL_FILE = join(REPO_ROOT, 'apps', 'ui', 'src', 'draft', 'pool.json');

/** A reference with no set and no collector number — `resolveCard`'s tier 3. */
function request(name: string, set: string | null): CardRequest {
  return { name, set, artIndex: 1, collectorNumber: null, foil: false, backFace: false, flags: null };
}

function str(card: GameplayCard, field: string): string | null {
  const value = card[field];
  return typeof value === 'string' ? value : null;
}

/** Stream the projected cache. Kept as an array so basics can be found in it too. */
async function loadCards(cacheDir: string): Promise<GameplayCard[]> {
  const cards: GameplayCard[] = [];
  const lines = createInterface({
    input: createReadStream(join(cacheDir, 'cards.jsonl'), { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.length === 0) continue;
    cards.push(JSON.parse(line) as GameplayCard);
  }
  return cards;
}

/**
 * Every name Forge can put on the board as a basic land.
 *
 * Read off the corpus rather than hardcoded: `Wastes`, the six snow-covered
 * lands and the two joke basics are all `Basic Land` type lines, and a list
 * written by hand is a list that goes stale the next time Wizards prints one.
 */
function basicLandNames(cards: readonly GameplayCard[]): string[] {
  const names = new Set<string>();
  for (const card of cards) {
    if (str(card, 'lang') !== 'en') continue;
    const type = str(card, 'type_line');
    if (type === null || !/^basic\s+(snow\s+)?land\b/i.test(type)) continue;
    const name = str(card, 'name');
    if (name !== null && name.length > 0) names.add(name);
  }
  return [...names].sort();
}

/** Every `.dck` under `decks/`, recursively. */
function deckFiles(): string[] {
  return readdirSync(DECKS_DIR, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.dck'))
    .map((entry) => join(DECKS_DIR, entry))
    .sort();
}

interface Counts {
  basics: number;
  decks: number;
  cubeAliases: number;
  bareNames: number;
  unresolved: string[];
}

async function main(argv: readonly string[]): Promise<number> {
  let cacheDir = DEFAULT_CACHE;
  let outFile = DEFAULT_OUT;
  for (const arg of argv) {
    if (arg.startsWith('--cache=')) cacheDir = resolvePath(arg.slice('--cache='.length));
    else if (arg.startsWith('--out=')) outFile = resolvePath(arg.slice('--out='.length));
    else {
      console.error(`Unknown argument '${arg}'`);
      console.error('Usage: build-art-ids.ts [--cache=<dir>] [--out=<file>]');
      return 2;
    }
  }

  return await run(cacheDir, outFile);
}

/** Forge set codes, grouped by the Scryfall set they name. */
function forgeAliases(): ReadonlyMap<string, string[]> {
  const byScryfall = new Map<string, string[]>();
  for (const [forge, scryfall] of FORGE_TO_SCRYFALL_SET) {
    const bucket = byScryfall.get(scryfall.toUpperCase());
    if (bucket === undefined) byScryfall.set(scryfall.toUpperCase(), [forge]);
    else bucket.push(forge);
  }
  for (const bucket of byScryfall.values()) bucket.sort();
  return byScryfall;
}

async function run(cacheDir: string, outFile: string): Promise<number> {
  const started = Date.now();
  const manifestPath = join(cacheDir, 'manifest.json');
  const sourceUpdatedAt = (() => {
    try {
      return (JSON.parse(readFileSync(manifestPath, 'utf8')) as { sourceUpdatedAt?: string }).sourceUpdatedAt ?? null;
    } catch {
      // No manifest is not fatal — the table is built from cards.jsonl, and the
      // timestamp is provenance in the output, not an input.
      return null;
    }
  })();

  const cards = await loadCards(cacheDir);
  {
    console.log(`Loaded ${cards.length} printings from ${cacheDir}`);
    const index: CardIndex = buildCardIndex(cards);
    console.log(`Indexed ${index.printings} printings across ${index.knownSets.size} Scryfall sets`);

    const ids = new Map<string, string>();
    const counts: Counts = { basics: 0, decks: 0, cubeAliases: 0, bareNames: 0, unresolved: [] };

    /** First write wins, exactly as the browser-side index resolves. */
    const put = (key: string, id: string, bucket: keyof Counts): void => {
      if (ids.has(key)) return;
      ids.set(key, id);
      if (bucket !== 'unresolved') counts[bucket] += 1;
    };

    // ── basics, under every Forge code that names their set ──────────────────
    const basics = basicLandNames(cards);
    console.log(`Basic land names: ${basics.join(', ')}`);
    for (const name of basics) {
      for (const forgeCode of FORGE_TO_SCRYFALL_SET.keys()) {
        const hit = resolveCard(request(name, forgeCode), index);
        // Only an exact set hit earns a row: tier `name` means this edition has
        // no such basic, and a row pointing at some other set's art would be a
        // worse answer than the bare-name fallback below already gives.
        if (!hit.ok || hit.tier !== 'name+set') continue;
        const id = str(hit.card, 'id');
        if (id !== null) put(`${name}|${forgeCode.toUpperCase()}`, id, 'basics');
      }
    }

    // ── the cube pool's Forge aliases ────────────────────────────────────────
    //
    // `pool.json` is already in the bundle and already keys all 534 cube cards
    // by their SCRYFALL set code, so nothing is duplicated here. What it cannot
    // cover is Forge naming the same edition differently: 92 of Forge's codes
    // are not their Scryfall code. Those rows, and only those, are added.
    const aliases = forgeAliases();
    const pool = JSON.parse(readFileSync(POOL_FILE, 'utf8')) as {
      cards: { name: string; setCode: string; scryfallId?: string }[];
    };
    for (const card of pool.cards) {
      if (card.scryfallId === undefined || card.scryfallId === '') continue;
      const setCode = card.setCode.toUpperCase();
      for (const forgeCode of aliases.get(setCode) ?? []) {
        if (forgeCode.toUpperCase() === setCode) continue; // pool.json covers it
        put(`${card.name}|${forgeCode.toUpperCase()}`, card.scryfallId, 'cubeAliases');
      }
    }

    // ── the committed constructed lists ──────────────────────────────────────
    const decks = deckFiles();
    for (const file of decks) {
      const deck = parseDck(readFileSync(file, 'utf8'));
      for (const entries of deck.sections.values()) {
        for (const entry of entries) {
          const hit = resolveCard(entry.card, index);
          if (!hit.ok) {
            counts.unresolved.push(`${entry.card.name}|${entry.card.set ?? ''} (${hit.reason})`);
            continue;
          }
          const id = str(hit.card, 'id');
          if (id === null) continue;
          if (entry.card.set !== null) {
            put(`${entry.card.name}|${entry.card.set.toUpperCase()}`, id, 'decks');
          }
        }
      }
    }
    console.log(`Read ${decks.length} deck lists under decks/`);

    // ── bare-name fallbacks ──────────────────────────────────────────────────
    //
    // `scryfallIdFor` falls back from `Name|SET` to `Name`, so one row per name
    // is what guarantees a card is never blank. The printing is the earliest
    // non-digital one (`resolveCard` tier 3), which is deterministic.
    const bareNames = new Set<string>(basics);
    for (const file of decks) {
      for (const entries of parseDck(readFileSync(file, 'utf8')).sections.values()) {
        for (const entry of entries) bareNames.add(entry.card.name);
      }
    }
    for (const name of [...bareNames].sort()) {
      if (ids.has(name)) continue;
      const hit = resolveCard(request(name, null), index);
      if (!hit.ok) continue;
      const id = str(hit.card, 'id');
      if (id !== null) put(name, id, 'bareNames');
    }

    // ── write ────────────────────────────────────────────────────────────────
    const keys = [...ids.keys()].sort();
    const rows = keys.map((key) => `    ${JSON.stringify(key)}: ${JSON.stringify(ids.get(key))}`);
    const note =
      'GENERATED by scripts/art/build-art-ids.ts — do not edit by hand. ' +
      "Forge's wire carries Name + SetCode, never a Scryfall id; this is the table that turns one into the other so " +
      'packages/carddata/src/art/index.ts can resolve a URL. Ids only — no URL, no host, no image metadata (D15). ' +
      'Scope: every basic land under every Forge set code, every card in the committed decks/ lists, the cube pool’s ' +
      'Forge-code aliases (pool.json already carries the Scryfall-code keys), and one bare-name fallback row per name. ' +
      (sourceUpdatedAt === null ? '' : `Built from Scryfall default_cards updated ${sourceUpdatedAt}.`);
    const body = `{
  "version": ${ART_ID_TABLE_VERSION},
  "note": ${JSON.stringify(note)},
  "ids": {
${rows.join(',\n')}
  }
}
`;
    writeFileSync(outFile, body, 'utf8');

    const bytes = Buffer.byteLength(body, 'utf8');
    console.log(
      `Wrote ${keys.length} rows (${bytes} bytes) to ${outFile}\n` +
        `  basics ${counts.basics}, decks ${counts.decks}, cube aliases ${counts.cubeAliases}, bare names ${counts.bareNames}`,
    );
    if (counts.unresolved.length > 0) {
      console.log(`  ${counts.unresolved.length} deck reference(s) did not resolve:`);
      for (const line of [...new Set(counts.unresolved)].sort()) console.log(`    ${line}`);
    }
    console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return 0;
  }
}

process.exitCode = await main(process.argv.slice(2));
