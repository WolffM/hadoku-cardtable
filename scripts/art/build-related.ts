/*
 * Build `apps/ui/src/draft/related.json` — for every card Scryfall knows, the
 * other cards that come with it: the tokens (and emblems) it makes, and a meld
 * card's partner and the card they meld into. The draft's fan draws them in a
 * row under the card under the pointer, and every tile adds them to the
 * inspector's wheel (the operator, 2026-10-19: *"when hovering a transform card
 * in fan mode, let's show all the related cards below it in a line"*, then
 * *"tokens and meld results too"*; 2026-10-22: *"fan mode must show all tokens
 * and transforms when hovering a card"*).
 *
 * A back face is not here: every card carries its own (`DraftCard.faces`, and
 * a board card's from Forge), so `related.ts` reads it off the card.
 *
 * Every card, not one cube's: a room drafts whichever cube or set its leader
 * picked, and a match deals whatever its decks hold, so a table built off one
 * cube left every other card with nothing to show. Keyed by the card's name —
 * its front face's for a card with faces — because a board card crosses from
 * Forge as a name, with no Scryfall id. Each related card is stored once and
 * named by index, since a handful of tokens (Treasure, Clue, Food) are made by
 * hundreds of cards.
 *
 * ## Regenerate with
 *
 *   node scripts/art/build-related.ts --cache=<any checkout>/packages/carddata/data
 *
 * It reads every card's `all_parts` from the Scryfall cache
 * (`pnpm --filter @hadoku/carddata sync`). No network. Each related card is an
 * art id `cardImageUrl` resolves like any other card's. Sorted, so a re-run
 * against the same cache writes the same bytes.
 */

import { createReadStream, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = resolve(import.meta.dirname, '../..');
const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const CACHE = resolve(arg('cache') ?? resolve(ROOT, 'packages/carddata/data'), 'cards.jsonl');
const OUT = resolve(arg('out') ?? resolve(ROOT, 'apps/ui/src/draft/related.json'));

/** Rows that are not a card anyone plays: a token's own row, an emblem's, an art card's. */
const NOT_A_CARD = new Set(['token', 'double_faced_token', 'emblem', 'art_series']);

type Kind = 'token' | 'meld';

interface Part {
  id: string;
  component: string;
  name: string;
}

interface Row {
  id: string;
  name: string;
  layout?: string;
  all_parts?: Part[];
}

/** The name a card is keyed by: its front face's, as Forge names it on the board. */
function relatedKey(name: string): string {
  return name.split(' // ')[0]!;
}

/** One card's related cards: its tokens, then a meld card's partner, then what they meld into. */
function relatedOf(row: Row): { id: string; name: string; kind: Kind }[] {
  const own = new Set([row.name, ...row.name.split(' // ')]);
  const seen = new Set<string>();
  const parts = (row.all_parts ?? []).filter((p) => p.id !== row.id && !own.has(p.name) && !seen.has(p.name) && seen.add(p.name));
  return [
    ...parts.filter((p) => p.component === 'token').map((p) => ({ id: p.id, name: p.name, kind: 'token' as const })),
    ...parts.filter((p) => p.component === 'meld_part').map((p) => ({ id: p.id, name: p.name, kind: 'meld' as const })),
    ...parts.filter((p) => p.component === 'meld_result').map((p) => ({ id: p.id, name: p.name, kind: 'meld' as const })),
  ];
}

async function main(): Promise<void> {
  const byName = new Map<string, { id: string; name: string; kind: Kind }[]>();
  const lines = createInterface({ input: createReadStream(CACHE, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"all_parts"')) continue;
    const row = JSON.parse(line.replace(/,$/, '')) as Row;
    if (row.layout !== undefined && NOT_A_CARD.has(row.layout)) continue;
    const key = relatedKey(row.name);
    if (byName.has(key)) continue;
    const related = relatedOf(row);
    if (related.length > 0) byName.set(key, related);
  }
  const partKey = (p: { id: string; kind: Kind }): string => `${p.id}|${p.kind}`;
  const unique = new Map<string, { id: string; name: string; kind: Kind }>();
  for (const list of byName.values()) for (const p of list) unique.set(partKey(p), p);
  const parts = [...unique.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.kind < b.kind ? -1 : 1));
  const index = new Map(parts.map((p, i) => [partKey(p), i]));
  const cards = Object.fromEntries(
    [...byName.keys()].sort().map((name) => [name, byName.get(name)!.map((p) => index.get(partKey(p))!)]),
  );
  const note = 'scripts/art/build-related.ts — every card with tokens or a meld partner, by front-face name; each part is [art id, name, kind]';
  writeFileSync(OUT, `${JSON.stringify({ note, parts: parts.map((p) => [p.id, p.name, p.kind]), cards })}\n`);
  console.log(`${byName.size} cards, ${parts.length} related cards -> ${OUT}`);
}

if (process.argv[1] === import.meta.filename) await main();
