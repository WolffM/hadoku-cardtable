/*
 * Build `apps/ui/src/draft/related.json` — for each cube card, the other cards
 * that belong with it: its back face, the tokens (and emblems) it makes, and a
 * meld card's partner and the card they meld into. The draft's fan draws them in
 * a row under its open card (the operator, 2026-10-19: *"when hovering a
 * transform card in fan mode, let's show all the related cards below it in a
 * line"*, then *"tokens and meld results too"*).
 *
 * ## Regenerate with
 *
 *   node scripts/art/build-related.ts --cache=<any checkout>/packages/carddata/data
 *
 * It reads the cube from `apps/ui/src/draft/pool.json` and every card's
 * `all_parts`, `layout` and `card_faces` from the Scryfall cache
 * (`pnpm --filter @hadoku/carddata sync`). No network. Each entry is an art id —
 * a Scryfall id, or `<id>#back` for a back face — and a name, so the art resolves
 * through `cardImageUrl` like any other card. Sorted, so a re-run against the
 * same cache writes the same bytes.
 */

import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = resolve(import.meta.dirname, '../..');
const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const CACHE = resolve(arg('cache') ?? resolve(ROOT, 'packages/carddata/data'), 'cards.jsonl');
const POOL = resolve(ROOT, 'apps/ui/src/draft/pool.json');
const OUT = resolve(arg('out') ?? resolve(ROOT, 'apps/ui/src/draft/related.json'));

/** The layouts whose second face is a card of its own, drawn from `<id>#back` (`@hadoku/carddata/art`'s `BACK_FACE`). */
const TWO_FACED = new Set(['transform', 'modal_dfc', 'reversible_card']);

type Kind = 'back' | 'token' | 'meld';

interface Part {
  id: string;
  component: string;
  name: string;
}

interface Row {
  id: string;
  name: string;
  layout?: string;
  card_faces?: { name: string }[];
  all_parts?: Part[];
}

interface Related {
  id: string;
  name: string;
  kind: Kind;
}

/** The related cards of one cube card, back face first, then tokens, then meld. */
function relatedOf(row: Row): Related[] {
  const out: Related[] = [];
  if (row.layout !== undefined && TWO_FACED.has(row.layout) && row.card_faces?.[1] !== undefined) {
    out.push({ id: `${row.id}#back`, name: row.card_faces[1].name, kind: 'back' });
  }
  const seen = new Set<string>();
  const parts = (row.all_parts ?? []).filter((p) => p.id !== row.id && !seen.has(p.name) && seen.add(p.name));
  for (const p of parts) if (p.component === 'token') out.push({ id: p.id, name: p.name, kind: 'token' });
  // A meld card's partner, then what they meld into.
  for (const p of parts) if (p.component === 'meld_part' && p.name !== row.name) out.push({ id: p.id, name: p.name, kind: 'meld' });
  for (const p of parts) if (p.component === 'meld_result') out.push({ id: p.id, name: p.name, kind: 'meld' });
  return out;
}

async function main(): Promise<void> {
  const pool = JSON.parse(readFileSync(POOL, 'utf8')) as { cards: { scryfallId?: string }[] };
  const wanted = new Set(pool.cards.flatMap((c) => (c.scryfallId === undefined ? [] : [c.scryfallId])));
  const table: Record<string, Related[]> = {};
  const lines = createInterface({ input: createReadStream(CACHE, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    const at = line.indexOf('"id":"');
    if (at === -1) continue;
    const id = line.slice(at + 6, at + 42);
    if (!wanted.has(id)) continue;
    const related = relatedOf(JSON.parse(line) as Row);
    if (related.length > 0) table[id] = related;
  }
  const sorted = Object.fromEntries(Object.keys(table).sort().map((k) => [k, table[k]!]));
  writeFileSync(OUT, `${JSON.stringify({ note: 'scripts/art/build-related.ts — the cube cards that have a back face, tokens or a meld partner', cards: sorted }, null, 1)}\n`);
  console.log(`${Object.keys(sorted).length} of ${wanted.size} cube cards have related cards -> ${OUT}`);
}

if (process.argv[1] === import.meta.filename) await main();
